#!/usr/bin/env python3
"""csv2vcf - แปลงไฟล์รายชื่อผู้ติดต่อ .csv เป็นไฟล์ vCard (.vcf)

แปลงไฟล์ CSV รายชื่อผู้ติดต่อ (ไฟล์ export จาก Google Contacts, Outlook หรือไฟล์ที่ทำเอง
โดยใช้ชื่อคอลัมน์ภาษาอังกฤษหรือภาษาไทย) เป็นไฟล์ vCard 3.0 ที่นำเข้า Android, iOS,
Google Contacts และ Outlook ได้

ใช้เฉพาะ Python standard library

    python3 csv2vcf.py contacts.csv                      # -> contacts.vcf
    python3 csv2vcf.py contacts.csv -o out.vcf --country-code 66
"""

from __future__ import annotations

import argparse
import codecs
import contextlib
import csv
import datetime
import errno
import io
import os
import re
import shutil
import stat
import sys
import tempfile
import unicodedata
import urllib.parse
from dataclasses import dataclass, field
from typing import IO, Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

__version__ = "1.0.0"

DEFAULT_MAX_MB = 50
MAX_MAX_MB = 4096
MAX_WARNINGS_SHOWN = 100
PATH_SHOW_LIMIT = 1000  # แสดง path ของไฟล์ในข้อความแบบเต็ม (ผ่านการ sanitise แล้ว)
FOLD_LIMIT = 75  # จำนวนไบต์สูงสุดต่อบรรทัดจริง ไม่นับ CRLF (RFC 2425 5.8.1)

WarnFn = Callable[[int, str], None]


class ConversionError(Exception):
    """ปัญหาที่ทำให้การแปลงต้องหยุด (ข้อมูลนำเข้าผิด, เขียนไฟล์ผลลัพธ์ไม่ได้ ...)"""


# --------------------------------------------------------------------------
# ฟังก์ชันช่วยจัดการข้อความ
# --------------------------------------------------------------------------

_NEWLINE_RE = re.compile("\r\n|[\r\n\x0b\x0c\x85\u2028\u2029]")
# อักขระควบคุม C0/C1 (ยกเว้น tab/ขึ้นบรรทัดใหม่ ซึ่งจัดการแยก), surrogate เดี่ยว
# (เข้ารหัสเป็น UTF-8 ไม่ได้), BOM และอักขระควบคุมทิศทางข้อความ (bidi embedding/
# override/isolate) ซึ่งทำให้ชื่อแสดงผลต่างจากเนื้อหาจริงได้ (การปลอมแบบ "Trojan Source")
_STRIP_RE = re.compile("[\x00-\x08\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufeff\u202a-\u202e\u2066-\u2069]")


def clean_text(value: str, multiline: bool = False) -> str:
    """ทำความสะอาดข้อความในเซลล์ CSV: ทำ NFC, ลบอักขระควบคุม, จัดช่องว่างให้เรียบร้อย

    เก็บการขึ้นบรรทัดใหม่ไว้เฉพาะเมื่อ *multiline* เป็นจริง มิฉะนั้นช่องว่างที่ติดกัน
    (รวมถึงการขึ้นบรรทัดใหม่) จะถูกยุบเหลือช่องว่างเดียว
    """
    # ทำ NFC หลังลบอักขระควบคุม เพื่อให้อักขระที่ถูกคั่นไว้ประกอบกันได้ถูกต้อง
    value = unicodedata.normalize("NFC", _STRIP_RE.sub("", _NEWLINE_RE.sub("\n", value)))
    if multiline:
        return "\n".join(" ".join(line.split()) for line in value.split("\n")).strip("\n")
    return " ".join(value.split())


def escape_text(value: str) -> str:
    """escape ค่าชนิด TEXT (RFC 2426 หัวข้อ 4, RFC 6350 หัวข้อ 3.4)"""
    value = value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return _NEWLINE_RE.sub(lambda _m: "\\n", value)


_ESCAPE_PAIR_RE = re.compile(rb"\\.", re.DOTALL)


def fold_line(line: str, limit: int = FOLD_LIMIT) -> str:
    """ตัดบรรทัด (fold) ไม่ให้บรรทัดจริงบรรทัดใดยาวเกิน *limit* ไบต์

    ตัดเฉพาะระหว่างอักขระที่สมบูรณ์ และไม่ตัดกลาง escape ที่ขึ้นต้นด้วย backslash
    ลำดับไบต์ UTF-8 หลายไบต์ (เช่น ภาษาไทย) จึงไม่ขาด เพราะโปรแกรมนำเข้าหลายตัว
    ต่ออักขระที่ถูกตัดข้ามบรรทัดกลับคืนไม่ได้ ทำงานบนไบต์โดยตรงและถอยจุดตัดไม่เกิน
    ไม่กี่ไบต์ เวลาจึงเป็นเส้นตรงแม้ข้อความยาวหลาย MB
    """
    data = line.encode("utf-8")
    if len(data) <= limit:
        return line
    # ตำแหน่งที่ห้ามตัด: ไบต์ที่ตามหลัง backslash ของ escape (\\n, \\, ...) จับคู่จากซ้ายไปขวา
    no_cut = bytearray(len(data))
    for match in _ESCAPE_PAIR_RE.finditer(data):
        no_cut[match.start() + 1] = 1
    pieces: List[bytes] = []
    start, room = 0, limit
    while len(data) - start > room:
        end = start + room
        # ถอยจุดตัดออกจากกลางอักขระ UTF-8 (ไบต์ 10xxxxxx) และกลาง escape
        while end > start + 1 and ((data[end] & 0xC0) == 0x80 or no_cut[end]):
            end -= 1
        pieces.append(data[start:end])
        start, room = end, limit - 1  # บรรทัดต่อเนื่องขึ้นต้นด้วยช่องว่างหนึ่งตัว
    pieces.append(data[start:])
    return b"\r\n ".join(pieces).decode("utf-8")


def show(value: str, limit: int = 60) -> str:
    """ใส่เครื่องหมายคำพูดให้ค่าที่ไม่น่าเชื่อถือ เพื่อแสดงในข้อความบน terminal

    อักขระควบคุมและอักขระจัดรูปแบบ (ANSI escape sequence, bidi override ...)
    จะแสดงเป็น escape ไฟล์ CSV ที่จงใจสร้างจึงสั่งการ terminal ไม่ได้
    """
    if len(value) > limit:
        value = value[:limit] + "..."
    return '"' + escape_controls(value) + '"'


def escape_controls(value: str) -> str:
    """แปลงอักขระควบคุมและอักขระจัดรูปแบบเป็น escape (เช่น \\x1b) ก่อนแสดงบน terminal"""
    return "".join(
        ch.encode("unicode_escape").decode("ascii")
        if unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp")
        else ch
        for ch in value
    )


def _has_hidden_chars(value: str) -> bool:
    """มีอักขระที่มองไม่เห็น เช่น ช่องว่าง อักขระควบคุม หรือ zero-width (หมวด C*/Z* ของ Unicode) หรือไม่"""
    return any(unicodedata.category(ch)[0] in "CZ" for ch in value)


def _ascii_digits(value: str) -> str:
    """ทำ NFKC แล้วแปลงตัวเลขทุกแบบ (เลขไทย ๐-๙, ตัวเลขเต็มความกว้าง ...) เป็นเลข ASCII"""
    value = unicodedata.normalize("NFKC", value)
    return "".join(
        str(unicodedata.digit(ch)) if unicodedata.category(ch) == "Nd" else ch for ch in value
    )


# --------------------------------------------------------------------------
# ปรับรูปแบบข้อมูลแต่ละช่อง
# --------------------------------------------------------------------------

_PHONE_SPLIT_RE = re.compile(r":::|[;,/|\n]")
# ใช้ \s? ไม่ใช่ \s*: clean_text ยุบช่องว่างเหลือตัวเดียวแล้ว และ \s* ใช้เวลาแบบกำลังสองกับช่องว่างยาว ๆ
_PHONE_EXT_RE = re.compile(r"\s?(?:ต่อ|extension|ext\.?|x)\s?(?=\d)", re.IGNORECASE)
_EXCEL_SCI_RE = re.compile(r"^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$")
_PHONE_ALLOWED = frozenset("0123456789+-(). *#,")
_PHONE_PAREN_PLUS_RE = re.compile(r"^\(\s*\+\s*(\d{1,4})\s*\)")  # "(+66) 81..." -> "+66 81..."
_PHONE_TRUNK_ZERO_RE = re.compile(r"\(\s*0\s*\)")  # "+44 (0)20..." -> "+44 20..."
_MAX_PHONE_LEN = 40


def normalize_phone(
    raw: str, country_code: Optional[str] = None
) -> Tuple[Optional[str], Optional[str]]:
    """คืนค่า ``(phone, warning)`` โดย *phone* เป็น None เมื่อใช้ค่านั้นไม่ได้"""
    value = clean_text(_ascii_digits(raw))
    if not value:
        return None, None
    if _EXCEL_SCI_RE.match(value):
        return None, (
            f"เบอร์โทร {show(raw)} ถูก Excel แปลงเป็นเลขวิทยาศาสตร์ "
            "(ให้ตั้งคอลัมน์เป็น Text แล้ว export ใหม่)"
        )
    value = _PHONE_EXT_RE.sub(",", value)  # "ต่อ 12" / "ext 12" -> หยุดรอ (pause) แล้วกดเบอร์ต่อ
    kept = [ch for ch in value if ch in _PHONE_ALLOWED]
    dropped = len(kept) != len(value)
    phone = _PHONE_PAREN_PLUS_RE.sub(r"+\1 ", " ".join("".join(kept).split()))
    # "+" มีความหมายเฉพาะเมื่อเป็นอักขระตัวแรกเท่านั้น
    phone = phone[:1] + phone[1:].replace("+", "")
    if phone.startswith("+"):
        # เลข 0 ในวงเล็บคือเลขที่ใช้โทรในประเทศ ห้ามกดเมื่อโทรแบบมีรหัสประเทศ
        phone = _PHONE_TRUNK_ZERO_RE.sub(" ", phone)
    phone = " ".join(phone.split()).strip(" -.,")
    digits = sum(ch.isdigit() for ch in phone)
    if digits < 3 or len(phone) > _MAX_PHONE_LEN:
        return None, f"ข้ามเบอร์โทรที่ไม่ถูกต้อง {show(raw)}"
    if country_code and phone.startswith("0") and not phone.startswith("00"):
        phone = f"+{country_code} " + phone[1:].lstrip(" -.")
    warning = f"ตัดอักขระที่ไม่ใช่เบอร์โทรออกจาก {show(raw)}" if dropped else None
    return phone, warning


_EMAIL_SPLIT_RE = re.compile(r":::|[;,]")
# ทั้งสองฝั่งห้ามมี "@" ไม่เช่นนั้น "<@@@@..." จะ backtrack แบบกำลังสอง
_EMAIL_BRACKET_RE = re.compile(r"<([^<>\s@]+@[^<>\s@]+)>")
# ตั้งใจให้ยืดหยุ่น (รองรับอีเมลที่มีอักษรนอกภาษาอังกฤษ) แต่ไม่รับช่องว่างและอักขระ
# ที่มีความหมายพิเศษใน vCard หรือ HTML ส่วน label ของโดเมนไม่รับ "." pattern นี้
# จึงไม่มีทาง backtrack แบบระเบิด (catastrophic)
_EMAIL_RE = re.compile(r'^[^\s@<>()\[\]\\,;:"]+@[^\s@<>()\[\]\\,;:".]+(?:\.[^\s@<>()\[\]\\,;:".]+)+$')
_MAX_EMAIL_LEN = 254


def split_emails(raw: str) -> List[str]:
    """แยกเซลล์ที่มีอีเมลหนึ่งหรือหลายที่อยู่ ("a@x.com; Name <b@y.com>")"""
    parts: List[str] = []
    for segment in _EMAIL_SPLIT_RE.split(clean_text(raw)):
        parts.extend(_EMAIL_BRACKET_RE.findall(segment) or segment.split())
    return parts


def normalize_email(raw: str) -> Optional[str]:
    value = raw.strip()
    if value[:7].lower() == "mailto:":
        value = value[7:]
    # อักขระล่องหนทำให้ "admin\u200b@bank.co.th" ดูเหมือน admin@bank.co.th แต่เป็นคนละที่อยู่
    if len(value) > _MAX_EMAIL_LEN or _has_hidden_chars(value) or not _EMAIL_RE.match(value):
        return None
    return value


_URL_SCHEME_RE = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*):(?!\d)")
_URL_FORBIDDEN = frozenset('<>"\\`{}|^')
_MAX_URL_LEN = 2048


def normalize_url(raw: str) -> Optional[str]:
    """คืนค่า URL แบบ http(s) หรือ None สำหรับอย่างอื่นทั้งหมด (javascript:, file: ...)"""
    value = clean_text(raw)
    if (
        not value
        or len(value) > _MAX_URL_LEN
        or _has_hidden_chars(value)  # ช่องว่างและอักขระล่องหนที่ใช้ปลอมชื่อโดเมน
        or any(ch in _URL_FORBIDDEN for ch in value)
    ):
        return None
    match = _URL_SCHEME_RE.match(value)
    if match:
        if match.group(1).lower() not in ("http", "https") or not value[match.end():].startswith("//"):
            return None
    else:
        value = "https://" + value.lstrip("/")
    try:
        parts = urllib.parse.urlsplit(value)
        host = parts.hostname
        parts.port  # noqa: B018 -- ตรวจว่าพอร์ตเป็นตัวเลขที่ถูกต้อง (ถ้าไม่ถูกจะเกิด ValueError)
    except ValueError:
        return None
    # "https://www.bank.co.th@evil.example" แสดงเหมือนลิงก์ธนาคาร แต่จริง ๆ พาไป
    # evil.example จึงไม่รับ URL ที่มีชื่อผู้ใช้/รหัสผ่าน (และไม่ควรเก็บรหัสผ่านไว้ในลิงก์)
    if not host or "@" in parts.netloc:
        return None
    return value


_DATE_YMD_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$")
_DATE_COMPACT_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")
_DATE_XY_RE = re.compile(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$")


def normalize_birthday(raw: str, date_order: str = "dmy") -> Optional[str]:
    """แปลงวันเกิดเป็นรูปแบบ ``YYYY-MM-DD``

    รับวันที่แบบ ISO และ DD/MM/YYYY (หรือ MM/DD/YYYY เมื่อ ``date_order="mdy"``)
    ปี พ.ศ. (มากกว่า 2400 ซึ่งใช้กันทั่วไปในไทย) จะแปลงเป็น ค.ศ.
    """
    value = clean_text(_ascii_digits(raw))
    match = _DATE_YMD_RE.match(value) or _DATE_COMPACT_RE.match(value)
    if match:
        year, month, day = (int(g) for g in match.groups())
    else:
        match = _DATE_XY_RE.match(value)
        if not match:
            return None
        first, second, year = (int(g) for g in match.groups())
        day, month = (second, first) if date_order == "mdy" else (first, second)
    if year > 2400:
        year -= 543
    try:
        return datetime.date(year, month, day).isoformat()
    except ValueError:
        return None


# --------------------------------------------------------------------------
# จดจำชื่อคอลัมน์
# --------------------------------------------------------------------------


def normalize_header(name: str) -> str:
    name = unicodedata.normalize("NFKC", name).replace("\ufeff", "")
    name = name.strip().strip("\"'").strip().lower()
    name = re.sub(r"[\s_]+", " ", name).rstrip(".:").strip()
    return name.replace("e-mail", "email")


@dataclass(frozen=True)
class Column:
    kind: str  # ชนิดข้อมูล: name | org | tel | email | url | adr | bday | note
    attr: str = "value"
    group: Tuple = ()
    types: Tuple[str, ...] = ()


_COLUMN_ALIASES: List[Tuple[str, str, Tuple[str, ...], Sequence[str]]] = [
    ("name", "full_name", (), [
        "name", "full name", "fullname", "display name", "formatted name", "contact name",
        "ชื่อ-นามสกุล", "ชื่อ - นามสกุล", "ชื่อ นามสกุล", "ชื่อและนามสกุล", "ชื่อเต็ม",
        "ชื่อที่แสดง", "ชื่อผู้ติดต่อ",
    ]),
    ("name", "given", (), ["first name", "firstname", "given name", "givenname", "first", "ชื่อ", "ชื่อจริง"]),
    ("name", "family", (), ["last name", "lastname", "family name", "familyname", "surname", "last", "นามสกุล"]),
    ("name", "middle", (), ["middle name", "middlename", "additional name", "middle", "ชื่อกลาง"]),
    ("name", "prefix", (), ["name prefix", "prefix", "honorific prefix", "คำนำหน้า", "คำนำหน้าชื่อ"]),
    ("name", "suffix", (), ["name suffix", "suffix", "honorific suffix"]),
    ("name", "nickname", (), ["nickname", "nick name", "ชื่อเล่น"]),
    ("org", "org", (), [
        "organization", "organisation", "organization name", "company", "company name",
        "บริษัท", "องค์กร", "หน่วยงาน", "สังกัด",
    ]),
    ("org", "title", (), ["job title", "jobtitle", "organization title", "position", "ตำแหน่ง"]),
    ("org", "dept", (), ["department", "organization department", "แผนก", "ฝ่าย"]),
    ("tel", "value", (), [
        "phone", "phone number", "phone no", "telephone", "telephone number", "tel", "tel no",
        "other phone", "เบอร์", "เบอร์โทร", "เบอร์โทรศัพท์", "โทรศัพท์", "หมายเลขโทรศัพท์",
    ]),
    ("tel", "value", ("PREF",), ["primary phone"]),
    ("tel", "value", ("CELL",), [
        "mobile", "mobile phone", "mobile number", "mobile no", "cell", "cell phone", "cellphone",
        "มือถือ", "เบอร์มือถือ", "โทรศัพท์มือถือ", "เบอร์โทรศัพท์มือถือ",
    ]),
    ("tel", "value", ("HOME",), ["เบอร์บ้าน", "โทรศัพท์บ้าน"]),
    ("tel", "value", ("WORK",), ["company main phone", "เบอร์ที่ทำงาน", "โทรศัพท์ที่ทำงาน"]),
    ("tel", "value", ("FAX",), ["fax", "fax number", "แฟกซ์", "โทรสาร"]),
    ("tel", "value", ("PAGER",), ["pager"]),
    ("tel", "value", ("CAR",), ["car phone"]),
    ("email", "value", (), ["email", "email address", "mail", "อีเมล", "อีเมล์", "อีเมลล์"]),
    ("url", "value", (), [
        "website", "web site", "web page", "webpage", "personal web page", "url", "homepage",
        "เว็บไซต์",
    ]),
    ("bday", "value", (), ["birthday", "bday", "birth date", "birthdate", "date of birth", "dob", "วันเกิด"]),
    ("note", "value", (), ["note", "notes", "comment", "comments", "หมายเหตุ", "บันทึก"]),
    ("adr", "address", (), ["address", "full address", "mailing address", "postal address", "ที่อยู่"]),
    ("adr", "address", ("HOME",), ["ที่อยู่บ้าน"]),
    ("adr", "address", ("WORK",), ["ที่อยู่ที่ทำงาน"]),
    ("adr", "street", (), ["street", "street address", "address line 1", "บ้านเลขที่", "ถนน"]),
    ("adr", "extended", (), ["extended address", "address line 2"]),
    ("adr", "subdistrict", (), ["subdistrict", "sub-district", "ตำบล", "แขวง", "ตำบล/แขวง", "แขวง/ตำบล"]),
    ("adr", "city", (), ["city", "town", "district", "อำเภอ", "เขต", "อำเภอ/เขต", "เขต/อำเภอ"]),
    ("adr", "region", (), ["state", "province", "region", "state/province", "จังหวัด"]),
    ("adr", "postal", (), ["postal code", "postcode", "post code", "zip", "zip code", "zipcode", "รหัสไปรษณีย์"]),
    ("adr", "country", (), ["country", "country/region", "country region", "ประเทศ"]),
    ("adr", "pobox", (), ["po box", "p.o. box", "pobox"]),
]

_SIMPLE_COLUMNS: Dict[str, Tuple[str, str, Tuple[str, ...]]] = {
    normalize_header(alias): (kind, attr, types)
    for kind, attr, types, aliases in _COLUMN_ALIASES
    for alias in aliases
}

# "Home Phone", "Business Fax", "Other E-mail", "Home Street" (แบบ Outlook)
_TYPE_PREFIXES: Dict[str, Tuple[str, ...]] = {
    "home": ("HOME",), "personal": ("HOME",), "business": ("WORK",), "work": ("WORK",),
    "office": ("WORK",), "other": (),
}

# แบบ Google Contacts: "Phone 1 - Type", "E-mail 2 - Value", "Address 1 - City" ...
_GOOGLE_RE = re.compile(r"^(phone|email|address|website|organization) ?(\d+) ?- ?(.+)$")
_GOOGLE_KIND = {"phone": "tel", "email": "email", "address": "adr", "website": "url", "organization": "org"}
_GOOGLE_ATTRS: Dict[str, Dict[str, str]] = {
    "phone": {"value": "value", "type": "type", "label": "type"},
    "email": {"value": "value", "type": "type", "label": "type"},
    "website": {"value": "value"},
    "address": {
        "formatted": "formatted", "street": "street", "city": "city", "po box": "pobox",
        "region": "region", "postal code": "postal", "country": "country",
        "extended address": "extended", "type": "type", "label": "type",
    },
    "organization": {"name": "org", "title": "title", "department": "dept"},
}


def _strip_numbers(name: str) -> str:
    return " ".join(word for word in name.split() if not word.isdigit())


def _make_column(kind: str, attr: str, types: Tuple[str, ...], index: int) -> Column:
    if kind in ("tel", "email", "url"):
        group: Tuple = (kind, "column", index)  # แต่ละคอลัมน์เป็นหนึ่งรายการแยกกัน
    elif kind == "adr":
        group = ("adr",) + types  # "Home Street" + "Home City" รวมเป็นที่อยู่เดียวกัน
    else:
        group = ()
    return Column(kind, attr, group, types)


def classify_header(header: str, index: int) -> Optional[Column]:
    """จับคู่หัวคอลัมน์ CSV กับช่องข้อมูลผู้ติดต่อ หรือคืน None ถ้าไม่รู้จัก"""
    name = normalize_header(header)
    if not name:
        return None
    match = _GOOGLE_RE.match(name)
    if match:
        section, number, sub = match.groups()
        attr = _GOOGLE_ATTRS[section].get(sub.strip())
        if attr is None:
            return None
        kind = _GOOGLE_KIND[section]
        if kind == "org":
            return Column("org", attr)
        return Column(kind, attr, group=(kind, "google", number))
    for candidate in dict.fromkeys((name, _strip_numbers(name))):
        hit = _SIMPLE_COLUMNS.get(candidate)
        if hit:
            return _make_column(*hit, index)
        word, _, rest = candidate.partition(" ")
        hit = _SIMPLE_COLUMNS.get(rest)
        if word in _TYPE_PREFIXES and hit and hit[0] in ("tel", "email", "adr"):
            kind, attr, types = hit
            return _make_column(kind, attr, _TYPE_PREFIXES[word] + types, index)
    return None


_LABEL_TYPES: List[Tuple[str, Tuple[str, ...], Tuple[str, ...]]] = [
    ("CELL", ("mobile", "cell", "iphone", "มือถือ"), ("tel",)),
    ("HOME", ("home", "personal", "บ้าน", "ส่วนตัว"), ("tel", "email", "adr")),
    ("WORK", ("work", "business", "office", "งาน"), ("tel", "email", "adr")),
    ("FAX", ("fax", "แฟกซ์", "โทรสาร"), ("tel",)),
    ("PAGER", ("pager",), ("tel",)),
]


def types_from_label(label: str, kind: str) -> Tuple[str, ...]:
    """แปลง label ที่เขียนอิสระ ("* Mobile", "Work Fax") เป็นค่า TYPE ที่อยู่ใน allowlist

    ไม่คัดลอกตัว label ลงในผลลัพธ์เลย จึงใช้แทรก parameter หรือ property ไม่ได้
    """
    text = clean_text(label).lower()
    types = [t for t, words, kinds in _LABEL_TYPES if kind in kinds and any(w in text for w in words)]
    if text.startswith("*"):  # Google ทำเครื่องหมายค่าหลักด้วย "* "
        types.append("PREF")
    return tuple(types)


# --------------------------------------------------------------------------
# ข้อมูลผู้ติดต่อ
# --------------------------------------------------------------------------


@dataclass
class Address:
    types: Tuple[str, ...] = ()
    pobox: str = ""
    extended: str = ""
    street: str = ""
    city: str = ""
    region: str = ""
    postal: str = ""
    country: str = ""

    def components(self) -> Tuple[str, ...]:
        return (self.pobox, self.extended, self.street, self.city, self.region, self.postal, self.country)


@dataclass
class Contact:
    full_name: str = ""
    given: str = ""
    family: str = ""
    middle: str = ""
    prefix: str = ""
    suffix: str = ""
    nickname: str = ""
    org: str = ""
    dept: str = ""
    title: str = ""
    phones: List[Tuple[str, Tuple[str, ...]]] = field(default_factory=list)
    emails: List[Tuple[str, Tuple[str, ...]]] = field(default_factory=list)
    addresses: List[Address] = field(default_factory=list)
    urls: List[str] = field(default_factory=list)
    birthday: str = ""
    note: str = ""

    def display_name(self) -> str:
        structured = " ".join(
            p for p in (self.prefix, self.given, self.middle, self.family, self.suffix) if p
        )
        return (
            self.full_name
            or structured
            or self.nickname
            or self.org
            or (self.emails[0][0] if self.emails else "")
            or (self.phones[0][0] if self.phones else "")
        )


@dataclass
class Options:
    country_code: Optional[str] = None  # เช่น "66": 081... -> +66 81...
    date_order: str = "dmy"  # วิธีอ่าน 01/02/2000: "dmy" หรือ "mdy"


def _dedupe(types: Iterable[str]) -> Tuple[str, ...]:
    return tuple(dict.fromkeys(types))


def build_contact(
    row: Sequence[str], columns: Sequence[Tuple[int, Column]], options: Options, warn: WarnFn, line: int
) -> Optional[Contact]:
    """แปลง CSV หนึ่งแถวเป็น Contact หรือคืน None ถ้าไม่มีข้อมูลที่ใช้ได้"""
    contact = Contact()
    groups: Dict[Tuple, Tuple[Column, Dict[str, List[str]]]] = {}
    notes: List[str] = []  # ต่อครั้งเดียวตอนท้าย (ต่อ string ซ้ำ ๆ ในลูปใช้เวลาแบบกำลังสอง)

    for index, column in columns:
        # columns เรียงตาม index จากน้อยไปมาก หยุดเมื่อเลยช่องสุดท้ายของแถว ไม่เช่นนั้น
        # หัวตารางหลายแสนคอลัมน์ x แถวสั้น ๆ หลายแสนแถว จะใช้เวลาแบบกำลังสอง (DoS)
        if index >= len(row):
            break
        raw = row[index]
        if not raw.strip():
            continue
        if column.kind in ("name", "org"):
            if not getattr(contact, column.attr):
                setattr(contact, column.attr, clean_text(raw))
        elif column.kind == "bday":
            if not contact.birthday:
                birthday = normalize_birthday(raw, options.date_order)
                if birthday:
                    contact.birthday = birthday
                else:
                    warn(line, f"ข้ามวันเกิดที่อ่านไม่ออก {show(raw)} (ใช้รูปแบบ YYYY-MM-DD หรือ DD/MM/YYYY)")
        elif column.kind == "note":
            text = clean_text(raw, multiline=True)
            if text:
                notes.append(text)
        else:
            _, fields = groups.setdefault(column.group, (column, {}))
            fields.setdefault(column.attr, []).append(raw)

    contact.note = "\n".join(notes)
    # ใช้ set ตรวจค่าซ้ำ (ค้นใน list ใช้เวลาแบบกำลังสองเมื่อแถวมีค่าหลายหมื่นค่า)
    seen_phones = set()
    seen_emails = set()
    seen_urls = set()
    for column, fields in groups.values():
        types = list(column.types)
        for label in fields.get("type", []):
            types.extend(types_from_label(label, column.kind))
        types_t = _dedupe(types)

        if column.kind == "tel":
            for raw in fields.get("value", []):
                for part in _PHONE_SPLIT_RE.split(raw):
                    phone, problem = normalize_phone(part, options.country_code)
                    if problem:
                        warn(line, problem)
                    key = phone and re.sub(r"[^\d+,]", "", phone)
                    if phone and key not in seen_phones:
                        seen_phones.add(key)
                        contact.phones.append((phone, types_t))
        elif column.kind == "email":
            for raw in fields.get("value", []):
                for part in split_emails(raw):
                    email = normalize_email(part)
                    if email is None:
                        warn(line, f"ข้ามอีเมลที่ไม่ถูกต้อง {show(part)}")
                    elif email.lower() not in seen_emails:
                        seen_emails.add(email.lower())
                        contact.emails.append((email, types_t))
        elif column.kind == "url":
            for raw in fields.get("value", []):
                for part in raw.split(":::"):
                    if not part.strip():
                        continue
                    url = normalize_url(part)
                    if url is None:
                        warn(line, f"ข้าม URL ที่ไม่ปลอดภัยหรือไม่ถูกต้อง {show(part)} (รองรับเฉพาะ http/https)")
                    elif url not in seen_urls:
                        seen_urls.add(url)
                        contact.urls.append(url)
        elif column.kind == "adr":
            address = _build_address(fields, types_t)
            if address:
                contact.addresses.append(address)

    if not contact.display_name():
        warn(line, "ข้ามแถวนี้เพราะไม่มีชื่อ องค์กร เบอร์โทร หรืออีเมล")
        return None
    return contact


def _build_address(fields: Dict[str, List[str]], types: Tuple[str, ...]) -> Optional[Address]:
    def part(name: str, multiline: bool = False) -> str:
        values = (clean_text(v, multiline) for v in fields.get(name, []))
        return ", ".join(v for v in values if v)

    # คอลัมน์ "Address"/"ที่อยู่" ที่ทำเอง ถือเป็นส่วนถนน (street) เมื่อไม่มีคอลัมน์ street
    # แม้จะมีคอลัมน์เมือง/จังหวัดอยู่ด้วยก็ตาม
    street = part("street", multiline=True) or part("address", multiline=True)
    subdistrict = part("subdistrict")
    if subdistrict:
        street = f"{street} {subdistrict}".strip()
    address = Address(
        types=tuple(t for t in types if t in ("HOME", "WORK", "PREF")),
        pobox=part("pobox"),
        extended=part("extended"),
        street=street,
        city=part("city"),
        region=part("region"),
        postal=part("postal"),
        country=part("country"),
    )
    if not any(address.components()):
        # "Address N - Formatted" ของ Google ซ้ำกับส่วนย่อยที่แยกไว้แล้ว
        # จึงใช้เฉพาะเมื่อส่วนย่อยว่างทั้งหมด
        address.street = part("formatted", multiline=True)
    return address if any(address.components()) else None


# --------------------------------------------------------------------------
# สร้างผลลัพธ์ vCard
# --------------------------------------------------------------------------


def _content_line(name: str, value: str, types: Tuple[str, ...] = ()) -> str:
    head = name + (";TYPE=" + ",".join(types) if types else "")
    return fold_line(f"{head}:{value}")


def contact_to_vcard(contact: Contact) -> str:
    """สร้าง vCard 3.0 ของ Contact หนึ่งรายการ โดยขึ้นบรรทัดใหม่ด้วย CRLF"""
    name_parts = (contact.family, contact.given, contact.middle, contact.prefix, contact.suffix)
    if not any(name_parts) and contact.full_name:
        # โทรศัพท์หลายรุ่นสร้างชื่อที่แสดงจาก N ไม่ใช่ FN
        name_parts = ("", contact.full_name, "", "", "")

    lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        _content_line("N", ";".join(escape_text(p) for p in name_parts)),
        _content_line("FN", escape_text(contact.display_name())),
    ]
    if contact.nickname:
        lines.append(_content_line("NICKNAME", escape_text(contact.nickname)))
    if contact.org or contact.dept:
        org = escape_text(contact.org) + (";" + escape_text(contact.dept) if contact.dept else "")
        lines.append(_content_line("ORG", org))
    if contact.title:
        lines.append(_content_line("TITLE", escape_text(contact.title)))
    for phone, types in contact.phones:
        # ค่าเบอร์โทรมีเฉพาะอักขระใน _PHONE_ALLOWED
        lines.append(_content_line("TEL", phone, types))
    for email, types in contact.emails:
        lines.append(_content_line("EMAIL", escape_text(email), _dedupe(("INTERNET",) + types)))
    for address in contact.addresses:
        value = ";".join(escape_text(p) for p in address.components())
        lines.append(_content_line("ADR", value, address.types))
    for url in contact.urls:
        # URL เป็นค่าชนิด URI (ไม่ใช่ TEXT) และ normalize_url ไม่รับช่องว่าง
        lines.append(_content_line("URL", url))
    if contact.birthday:
        lines.append(_content_line("BDAY", contact.birthday))
    if contact.note:
        lines.append(_content_line("NOTE", escape_text(contact.note)))
    lines.append("END:VCARD")
    return "\r\n".join(lines) + "\r\n"


# --------------------------------------------------------------------------
# อ่านไฟล์ CSV
# --------------------------------------------------------------------------


# ไฟล์ .xlsx (ZIP) และ .xls (OLE2) ซึ่งผู้ใช้มักใส่มาแทน CSV
_EXCEL_SIGNATURES = (b"PK\x03\x04", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


def decode_csv_bytes(data: bytes, encoding: str = "auto") -> Tuple[str, str]:
    """ถอดรหัสไบต์ของไฟล์ CSV คืนค่า ``(text, encoding_used)``

    โหมด ``auto`` ใช้ BOM ของ UTF-8/UTF-16 ถ้ามี จากนั้นลอง UTF-8 แล้วจึงลองภาษาไทย
    Windows (cp874) ซึ่งเป็นค่าที่ Excel บน Windows ภาษาไทยใช้บันทึกโดยปริยาย
    """
    if data.startswith(_EXCEL_SIGNATURES):
        raise ConversionError(
            "ไฟล์นี้เป็นไฟล์ Excel (.xlsx/.xls) หรือไฟล์บีบอัด ไม่ใช่ CSV "
            'ให้เปิดใน Excel แล้วบันทึกเป็น "CSV UTF-8" ก่อน'
        )
    attempt = encoding
    try:
        if encoding != "auto":
            return data.decode(encoding), encoding
        if data.startswith(codecs.BOM_UTF8):
            attempt = "utf-8-sig"
            return data.decode(attempt), attempt
        if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
            attempt = "utf-16"
            return data.decode(attempt), attempt
        try:
            attempt = "utf-8"
            return data.decode(attempt), attempt
        except UnicodeDecodeError:
            attempt = "cp874"
            return data.decode(attempt), attempt
    except LookupError as exc:
        raise ConversionError(f"ไม่รู้จัก encoding {show(encoding)}") from exc
    except UnicodeDecodeError as exc:
        # แจ้งชื่อ encoding ที่ลองจริง (exc.encoding ของ cp874/tis-620/cp1252 คือ "charmap"
        # ซึ่งผู้ใช้ไม่รู้จัก) และ utf-8-sig นับตำแหน่งหลัง BOM (ถ้ามี) จึงบวกกลับให้เป็นตำแหน่งจริงในไฟล์
        skipped_bom = codecs.lookup(attempt).name == "utf-8-sig" and data.startswith(codecs.BOM_UTF8)
        start = exc.start + (len(codecs.BOM_UTF8) if skipped_bom else 0)
        raise ConversionError(
            f"ถอดรหัสไฟล์ด้วย {attempt} ไม่ได้ (ตำแหน่งไบต์ {start}) "
            "ลองระบุ --encoding เช่น utf-8, cp874, tis-620, utf-16"
        ) from exc


_DELIMITERS = (",", ";", "\t", "|")
_SEP_HINT_RE = re.compile(r"^sep=(.)\r?\n")
_QUOTED_RE = re.compile(r'"[^"]*"')


def detect_delimiter(text: str) -> str:
    """เลือกตัวคั่นที่พบบ่อยที่สุดในบรรทัดหัวตาราง (ค่าเริ่มต้น ",")"""
    # ไม่นับตัวคั่นที่อยู่ในเครื่องหมายคำพูด เช่น "Name, Full";Phone ใช้ ; เป็นตัวคั่น
    header = _QUOTED_RE.sub("", text.split("\n", 1)[0])
    counts = {d: header.count(d) for d in _DELIMITERS}
    best = max(counts, key=lambda d: counts[d])  # ถ้าจำนวนเท่ากันจะได้ ","
    return best if counts[best] else ","


@dataclass
class Stats:
    rows: int = 0
    written: int = 0
    skipped: int = 0
    ignored_columns: List[str] = field(default_factory=list)


def iter_vcards(
    text: str,
    delimiter: Optional[str] = None,
    options: Optional[Options] = None,
    warn: Optional[WarnFn] = None,
    stats: Optional[Stats] = None,
) -> Iterator[str]:
    """สร้าง vCard ทีละรายการ สำหรับแต่ละแถวที่ใช้ได้ใน CSV *text*"""
    options = options or Options()
    warn = warn or (lambda _line, _msg: None)
    stats = stats if stats is not None else Stats()

    if "\x00" in text:
        raise ConversionError(
            "ไฟล์มีอักขระ NUL อาจเป็นไฟล์ UTF-16 ที่ไม่มี BOM ลองระบุ --encoding utf-16-le"
        )
    if text.startswith("\ufeff"):
        text = text[1:]
    hint = _SEP_HINT_RE.match(text)  # บรรทัดแรก "sep=;" ของ Excel
    if hint and hint.group(1) in _DELIMITERS:
        text = text[hint.end():]
        delimiter = delimiter or hint.group(1)
    delimiter = delimiter or detect_delimiter(text)
    if not isinstance(delimiter, str) or len(delimiter) != 1 or delimiter in '"\r\n':
        raise ConversionError(f"ตัวคั่นคอลัมน์ไม่ถูกต้อง {show(str(delimiter))}")

    # strict: เครื่องหมายคำพูดที่ไม่ปิดต้องแจ้ง error ให้ชัดเจน แทนที่จะรวม
    # ทุกแถวที่ตามมาเป็นรายชื่อเดียวแบบเงียบ ๆ
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    try:
        header: List[str] = []
        for header in reader:
            if any(cell.strip() for cell in header):
                break
        columns: List[Tuple[int, Column]] = []
        for index, name in enumerate(header):
            column = classify_header(name, index)
            if column:
                columns.append((index, column))
            elif name.strip():
                stats.ignored_columns.append(name)
        if not columns:
            raise ConversionError(
                "ไม่พบคอลัมน์ที่รู้จักในแถวหัวตาราง (เช่น Name, Phone, Email, ชื่อ, เบอร์โทร, อีเมล) "
                f"หัวตารางที่พบ: {', '.join(show(h, 30) for h in header[:10]) or '(ว่าง)'}"
            )
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue
            stats.rows += 1
            contact = build_contact(row, columns, options, warn, reader.line_num)
            if contact is None:
                stats.skipped += 1
                continue
            stats.written += 1
            yield contact_to_vcard(contact)
    except csv.Error as exc:
        raise ConversionError(
            f"อ่านไฟล์ CSV ไม่ได้ที่บรรทัด {reader.line_num}: {_translate_csv_error(str(exc))}"
        ) from exc


def _translate_csv_error(message: str) -> str:
    """แปลข้อความผิดพลาดภาษาอังกฤษของโมดูล csv เป็นภาษาไทย (ข้อความอื่นแสดงตามเดิม)"""
    if "field larger than field limit" in message:
        return f"ข้อมูลในช่องเดียวยาวเกิน {csv.field_size_limit():,} ตัวอักษร"
    if "unexpected end of data" in message:
        return 'ไฟล์จบกลางข้อมูล อาจมีเครื่องหมายคำพูด " ที่ไม่ได้ปิด'
    if "expected after" in message:
        return 'มีข้อความต่อท้ายเครื่องหมายคำพูดปิด (ถ้าข้อความมี " ต้องเขียนเป็น "")'
    return escape_controls(message)


# --------------------------------------------------------------------------
# ไฟล์และ command line
# --------------------------------------------------------------------------


def read_input(path: str, max_bytes: int) -> bytes:
    if path == "-":
        data = sys.stdin.buffer.read(max_bytes + 1)
    else:
        with open(path, "rb") as fh:
            data = fh.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ConversionError(f"ไฟล์ใหญ่เกิน {max_bytes // (1024 * 1024)} MB (ปรับได้ด้วย --max-size)")
    return data


def default_output_path(input_path: str) -> str:
    if input_path == "-":
        return "-"
    root, _ext = os.path.splitext(input_path)
    return root + ".vcf"


def _check_output_path(output: str, force: bool, input_path: Optional[str]) -> None:
    if os.path.isdir(output):
        raise ConversionError(f"{show(output, PATH_SHOW_LIMIT)} เป็นโฟลเดอร์ ไม่ใช่ไฟล์")
    if not os.path.isdir(os.path.dirname(os.path.abspath(output))):
        raise ConversionError(f"ไม่พบโฟลเดอร์ของไฟล์ผลลัพธ์ {show(output, PATH_SHOW_LIMIT)}")
    if not os.path.lexists(output):
        return
    try:
        target = os.stat(output)  # ตามลิงก์สัญลักษณ์ไปยังไฟล์จริง
    except OSError:
        target = None  # ลิงก์เสียที่ชี้ไปยังไฟล์ที่ไม่มีอยู่
    if target is not None and not stat.S_ISREG(target.st_mode):
        # os.replace จะแทนที่ไฟล์พิเศษทั้งตัว ถ้ารันด้วยสิทธิ์ root แล้วสั่ง
        # -o /dev/null --force จะทำลาย /dev/null ของทั้งระบบ จึงห้ามแม้ใส่ --force
        raise ConversionError(
            f"{show(output, PATH_SHOW_LIMIT)} ไม่ใช่ไฟล์ธรรมดา (เช่น อุปกรณ์หรือ FIFO) จึงเขียนทับไม่ได้ "
            "ถ้าต้องการส่งออกทางเอาต์พุตมาตรฐาน ให้ใช้ -o -"
        )
    if input_path and input_path != "-":
        try:
            same = os.path.samefile(output, input_path)
        except OSError:
            same = False
        if same:
            raise ConversionError("ไฟล์ผลลัพธ์ต้องไม่ใช่ไฟล์เดียวกับไฟล์ CSV ต้นฉบับ")
    if not force:
        raise ConversionError(f"มีไฟล์ {show(output, PATH_SHOW_LIMIT)} อยู่แล้ว (ใช้ --force เพื่อเขียนทับ)")


_NO_CONTACTS = "ไม่มีรายชื่อที่แปลงได้เลย จึงไม่สร้างไฟล์ผลลัพธ์"
_SPOOL_IN_MEMORY = 16 * 1024 * 1024


def _write_all(vcards: Iterable[str], fh: IO[bytes]) -> int:
    count = 0
    for card in vcards:
        fh.write(card.encode("utf-8"))
        count += 1
    return count


def write_vcards(
    vcards: Iterable[str], output: str, force: bool = False, input_path: Optional[str] = None
) -> int:
    """เขียน vCard ลง *output* ("-" = stdout) คืนค่าจำนวนรายการที่เขียน

    เขียนลงไฟล์ชั่วคราวส่วนตัวก่อน (สิทธิ์ 0600 เพราะรายชื่อเป็นข้อมูลส่วนบุคคล)
    แล้วเปลี่ยนชื่อแทนที่แบบ atomic หากเกิดข้อผิดพลาด จึงไม่มีไฟล์ .vcf ที่เขียนค้าง
    ครึ่งเดียว และไม่ทับไฟล์เดิม
    """
    if output == "-":
        # พักผลลัพธ์ไว้ก่อน แล้วส่งออกทีเดียวเมื่อแปลงครบ ถ้า CSV เสียกลางไฟล์จะได้ไม่มี
        # ผลลัพธ์ครึ่งเดียวหลุดออกไป (เช่น ตอนใช้ -o - > out.vcf) ข้อมูลเกิน
        # _SPOOL_IN_MEMORY จะย้ายไปไฟล์ชั่วคราวส่วนตัวที่ระบบลบให้เอง
        with tempfile.SpooledTemporaryFile(max_size=_SPOOL_IN_MEMORY) as spool:
            count = _write_all(vcards, spool)
            if not count:
                raise ConversionError(_NO_CONTACTS)
            spool.seek(0)
            shutil.copyfileobj(spool, sys.stdout.buffer)
        sys.stdout.buffer.flush()
        return count

    _check_output_path(output, force, input_path)
    directory = os.path.dirname(os.path.abspath(output))
    try:
        fd, tmp_path = tempfile.mkstemp(prefix=".csv2vcf-", suffix=".tmp", dir=directory)
    except OSError as exc:
        # แจ้งชื่อไฟล์ผลลัพธ์ แทนชื่อไฟล์ชั่วคราวที่ผู้ใช้ไม่รู้จัก
        raise OSError(exc.errno, exc.strerror, output) from exc
    count = 0
    try:
        with os.fdopen(fd, "wb") as fh:
            count = _write_all(vcards, fh)
        if not count:
            raise ConversionError(_NO_CONTACTS)
        os.replace(tmp_path, output)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise
    return count


def _delimiter_arg(value: str) -> str:
    value = {"tab": "\t", "\\t": "\t", "comma": ",", "semicolon": ";", "pipe": "|"}.get(value.lower(), value)
    if len(value) != 1 or value in "\"\r\n" or value.isalnum():
        raise argparse.ArgumentTypeError("ต้องเป็นอักขระเดียว เช่น , ; | หรือ tab")
    return value


def _country_code_arg(value: str) -> str:
    value = _ascii_digits(value).strip().lstrip("+")
    if not re.fullmatch(r"[1-9][0-9]{0,2}", value):  # \d จะรับตัวเลขทุกภาษา จึงระบุ 0-9
        raise argparse.ArgumentTypeError("ต้องเป็นตัวเลข 1-3 หลัก เช่น 66")
    return value


def _max_size_arg(value: str) -> int:
    try:
        size = int(value)
    except ValueError:
        size = 0
    if not 0 < size <= MAX_MAX_MB:
        raise argparse.ArgumentTypeError(f"ต้องเป็นจำนวนเต็ม 1-{MAX_MAX_MB} (หน่วย MB)")
    return size


class _ThaiHelpFormatter(argparse.HelpFormatter):
    """HelpFormatter ที่ขึ้นต้นบรรทัดวิธีใช้ด้วย "วิธีใช้:" แทน "usage:" """

    def add_usage(self, usage, actions, groups, prefix=None):  # type: ignore[no-untyped-def]
        super().add_usage(usage, actions, groups, "วิธีใช้: " if prefix is None else prefix)


# ข้อความ error ภาษาอังกฤษของ argparse -> ภาษาไทย ข้อความที่ไม่อยู่ในรายการจะแสดงตามเดิม
# (จับเฉพาะคำนำหน้าและวลีคงที่ จึงไม่มี regex ที่ backtrack กับค่าจาก argv)
_ARGPARSE_EXACT = {
    "expected one argument": "ต้องระบุค่าหนึ่งค่า",
    "expected at most one argument": "ระบุค่าได้ไม่เกินหนึ่งค่า",
}
_ARGPARSE_PREFIXES = (
    ("the following arguments are required: ", "ต้องระบุ "),
    ("unrecognized arguments: ", "ไม่รู้จักอาร์กิวเมนต์ "),
    ("invalid choice: ", "ค่าไม่ถูกต้อง "),
    ("ambiguous option: ", "ตัวเลือกกำกวม "),
    ("ignored explicit argument ", "ตัวเลือกนี้ไม่รับค่า "),
)
# argparse ต่อวลีเหล่านี้ไว้ท้ายข้อความ จึงแทนที่ตัวสุดท้าย (ค่าจาก argv อยู่ก่อนหน้า)
_ARGPARSE_PHRASES = ((" (choose from ", " (เลือกได้จาก "), (" could match ", " อาจหมายถึง "))
_ARGPARSE_INVALID_VALUE_RE = re.compile(r"^invalid \S+ value: ")


def _translate_argparse_error(message: str) -> str:
    """แปลข้อความ error ของ argparse เป็นภาษาไทย และ escape อักขระควบคุมที่มาจาก argv"""
    prefix = ""
    if message.startswith("argument "):
        name, sep, rest = message[len("argument "):].partition(": ")
        if sep and " " not in name:
            prefix, message = f"อาร์กิวเมนต์ {name}: ", rest
    if message in _ARGPARSE_EXACT:
        message = _ARGPARSE_EXACT[message]
    else:
        for english, thai in _ARGPARSE_PREFIXES:
            if message.startswith(english):
                message = thai + message[len(english):]
                for old, new in _ARGPARSE_PHRASES:
                    head, found, tail = message.rpartition(old)
                    if found:
                        message = head + new + tail
                break
        else:
            match = _ARGPARSE_INVALID_VALUE_RE.match(message)
            if match:
                message = "ค่าไม่ถูกต้อง " + message[match.end():]
    return escape_controls(prefix + message)


class _ThaiArgumentParser(argparse.ArgumentParser):
    """ArgumentParser ที่แสดงข้อความ error เป็นภาษาไทย"""

    def error(self, message: str):  # type: ignore[override]
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: ผิดพลาด: {_translate_argparse_error(message)}\n")


def build_parser() -> argparse.ArgumentParser:
    parser = _ThaiArgumentParser(
        prog="csv2vcf",
        description="แปลงไฟล์รายชื่อผู้ติดต่อ .csv เป็นไฟล์ vCard 3.0 (.vcf) "
        "สำหรับนำเข้า Android, iPhone, Google Contacts และ Outlook",
        formatter_class=_ThaiHelpFormatter,
        add_help=False,  # เพิ่ม -h เองด้านล่าง เพื่อให้คำอธิบายเป็นภาษาไทย
    )
    # กลุ่มที่สร้างเองแทนกลุ่มเริ่มต้น "positional arguments" / "options" ซึ่งเป็นภาษาอังกฤษ
    required = parser.add_argument_group("อาร์กิวเมนต์ที่ต้องระบุ")
    options = parser.add_argument_group("ตัวเลือก")
    required.add_argument("input", metavar="ไฟล์_CSV", help="ไฟล์ CSV ต้นฉบับ (ใช้ - เพื่ออ่านจากอินพุตมาตรฐาน)")
    options.add_argument("-h", "--help", action="help", help="แสดงข้อความช่วยเหลือนี้แล้วออก")
    options.add_argument("-o", "--output", metavar="ไฟล์_VCF", help="ไฟล์ .vcf ที่จะสร้าง (ค่าเริ่มต้น: ชื่อเดียวกับไฟล์ CSV, ใช้ - เพื่อส่งออกทางเอาต์พุตมาตรฐาน)")
    options.add_argument("-e", "--encoding", default="auto", metavar="การเข้ารหัส", help="การเข้ารหัสอักขระของไฟล์ CSV (ค่าเริ่มต้น: auto คือลอง UTF-8 ก่อน แล้วจึงลอง cp874)")
    options.add_argument("-d", "--delimiter", type=_delimiter_arg, metavar="ตัวคั่น", help="ตัวคั่นคอลัมน์ เช่น , ; | หรือ tab (ค่าเริ่มต้น: ตรวจหาให้เอง)")
    options.add_argument("--country-code", type=_country_code_arg, metavar="รหัสประเทศ", help="แปลงเบอร์ที่ขึ้นต้นด้วย 0 เป็นรูปแบบสากล เช่น 66: 081... -> +66 81...")
    options.add_argument("--date-order", choices=("dmy", "mdy"), default="dmy", help="ลำดับวันที่ของวันเกิดแบบ xx/xx/yyyy: dmy คือ วัน/เดือน/ปี, mdy คือ เดือน/วัน/ปี (ค่าเริ่มต้น: dmy)")
    options.add_argument("--max-size", type=_max_size_arg, default=DEFAULT_MAX_MB, metavar="เมกะไบต์", help=f"ขนาดไฟล์ CSV สูงสุด (ค่าเริ่มต้น: {DEFAULT_MAX_MB} เมกะไบต์)")
    options.add_argument("-f", "--force", action="store_true", help="เขียนทับไฟล์ผลลัพธ์ถ้ามีอยู่แล้ว")
    options.add_argument("-q", "--quiet", action="store_true", help="ไม่แสดงคำเตือนรายแถว")
    options.add_argument("-V", "--version", action="version", version=f"%(prog)s รุ่น {__version__}", help="แสดงรุ่นของโปรแกรมแล้วออก")
    return parser


# ข้อความจากระบบปฏิบัติการ (เป็นภาษาอังกฤษ) ที่พบบ่อย -> ภาษาไทย
_OS_ERRORS: Dict[Optional[int], str] = {
    errno.ENOENT: "ไม่พบไฟล์หรือโฟลเดอร์",
    errno.EACCES: "ไม่มีสิทธิ์เข้าถึง",
    errno.EPERM: "ไม่ได้รับอนุญาตให้ทำรายการนี้",
    errno.EISDIR: "เป็นโฟลเดอร์ ไม่ใช่ไฟล์",
    errno.ENOTDIR: "ส่วนหนึ่งของ path ไม่ใช่โฟลเดอร์",
    errno.ENOSPC: "พื้นที่ดิสก์เต็ม",
    errno.EROFS: "ระบบไฟล์เป็นแบบอ่านอย่างเดียว",
    errno.ENAMETOOLONG: "ชื่อไฟล์ยาวเกินไป",
}


def main(argv: Optional[Sequence[str]] = None) -> int:
    # ห้าม crash บน console ที่แสดงภาษาไทยไม่ได้ (เช่น cp437) ต้องตั้งก่อน parse_args
    # เพราะ --help และข้อความ error ของอาร์กิวเมนต์ก็เป็นภาษาไทย
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    args = build_parser().parse_args(argv)

    warning_count = 0

    def warn(line: int, message: str) -> None:
        nonlocal warning_count
        warning_count += 1
        if not args.quiet and warning_count <= MAX_WARNINGS_SHOWN:
            print(f"คำเตือน: บรรทัด {line}: {message}", file=sys.stderr)

    output = args.output or default_output_path(args.input)
    stats = Stats()
    try:
        data = read_input(args.input, args.max_size * 1024 * 1024)
        text, used_encoding = decode_csv_bytes(data, args.encoding)
        if args.encoding == "auto" and used_encoding == "cp874":
            print("หมายเหตุ: ไฟล์ไม่ใช่ UTF-8 จึงอ่านเป็นภาษาไทย Windows (cp874) ถ้าตัวอักษรเพี้ยนให้ระบุ --encoding", file=sys.stderr)
        options = Options(country_code=args.country_code, date_order=args.date_order)
        vcards = iter_vcards(text, args.delimiter, options, warn, stats)
        written = write_vcards(vcards, output, force=args.force, input_path=args.input)
    except ConversionError as exc:
        print(f"csv2vcf: ผิดพลาด: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        # โปรแกรมปลายทางปิดรับข้อมูลก่อน (เช่น | head) ไม่ใช่ความผิดของไฟล์ จึงออกเงียบ ๆ
        # และชี้ stdout ไปที่ devnull ไม่ให้ Python แจ้ง error ซ้ำตอนปิดโปรแกรม
        with contextlib.suppress(OSError, ValueError, AttributeError):
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 1
    except OSError as exc:
        where = f" {show(str(exc.filename), PATH_SHOW_LIMIT)}" if exc.filename else ""
        reason = _OS_ERRORS.get(exc.errno) or exc.strerror or str(exc)
        print(f"csv2vcf: ผิดพลาด:{where} {reason}", file=sys.stderr)
        return 1

    hidden = warning_count - MAX_WARNINGS_SHOWN
    if hidden > 0 and not args.quiet:
        print(f"... และคำเตือนอีก {hidden} รายการ", file=sys.stderr)
    if stats.ignored_columns and not args.quiet:
        names = ", ".join(show(name, 30) for name in stats.ignored_columns[:15])
        more = f" และอีก {len(stats.ignored_columns) - 15} คอลัมน์" if len(stats.ignored_columns) > 15 else ""
        print(f"หมายเหตุ: ไม่ได้ใช้คอลัมน์ {names}{more}", file=sys.stderr)
    target = "เอาต์พุตมาตรฐาน" if output == "-" else show(output, PATH_SHOW_LIMIT)
    print(f"แปลงสำเร็จ {written} รายชื่อ -> {target} (ข้าม {stats.skipped} แถว)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
