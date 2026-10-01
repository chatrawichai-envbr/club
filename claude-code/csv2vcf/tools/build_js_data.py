#!/usr/bin/env python3
"""สร้าง csv2vcf-data.js จากตารางข้อมูลใน csv2vcf.py

เว็บไซต์บน GitHub Pages (index.html ในโฟลเดอร์ csv2vcf/) แปลงไฟล์ด้วย JavaScript ในเบราว์เซอร์ ตารางข้อมูล
(ชื่อคอลัมน์ที่รู้จัก, ตัวเลขทุกภาษา, ตารางถอดรหัส cp874/tis-620/cp1252, ค่าคงที่ต่าง ๆ)
ต้องตรงกับฝั่ง Python ทุกตัว จึงสร้างไฟล์นี้จาก Python โดยตรงแทนการพิมพ์ซ้ำ

    python3 tools/build_js_data.py

รันใหม่ทุกครั้งที่แก้ตารางใน csv2vcf.py (tests/test_static_site.py ตรวจว่าไฟล์ยังตรงกัน)
"""

from __future__ import annotations

import csv
import json
import os
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import csv2vcf  # noqa: E402
import webapp  # noqa: E402

OUTPUT = os.path.join(ROOT, "csv2vcf-data.js")
SINGLE_BYTE_CODECS = ("cp874", "tis-620", "cp1252")


def _codec_table(encoding: str) -> list:
    """ตารางถอดรหัสไบต์ 0x80-0xFF (None = ไบต์ที่ถอดไม่ได้) ครึ่งล่างต้องเป็น ASCII"""
    for byte in range(0x80):
        assert bytes([byte]).decode(encoding) == chr(byte), (encoding, byte)
    table = []
    for byte in range(0x80, 0x100):
        try:
            table.append(ord(bytes([byte]).decode(encoding)))
        except UnicodeDecodeError:
            table.append(None)
    return table


def build_data() -> dict:
    digit_zeros = []
    isdigit_not_nd = []
    for cp in range(0x110000):
        ch = chr(cp)
        category = unicodedata.category(ch)
        if category == "Nd" and unicodedata.digit(ch) == 0:
            digit_zeros.append(cp)
        elif category != "Nd" and ch.isdigit():
            isdigit_not_nd.append(cp)
    return {
        "version": csv2vcf.__version__,
        "unicodeVersion": unicodedata.unidata_version,
        "fieldLimit": csv.field_size_limit(),
        "foldLimit": csv2vcf.FOLD_LIMIT,
        "maxPhoneLen": csv2vcf._MAX_PHONE_LEN,
        "maxEmailLen": csv2vcf._MAX_EMAIL_LEN,
        "maxUrlLen": csv2vcf._MAX_URL_LEN,
        "maxWarnings": webapp.MAX_WARNINGS,
        "maxIgnoredColumns": webapp.MAX_IGNORED_COLUMNS,
        "encodings": list(webapp.ENCODINGS),
        "delimiterNames": {name: value for name, value in webapp.DELIMITERS.items()},
        "delimiters": list(csv2vcf._DELIMITERS),
        "simpleColumns": {key: [kind, attr, list(types)] for key, (kind, attr, types) in csv2vcf._SIMPLE_COLUMNS.items()},
        "typePrefixes": {word: list(types) for word, types in csv2vcf._TYPE_PREFIXES.items()},
        "googleKind": dict(csv2vcf._GOOGLE_KIND),
        "googleAttrs": {section: dict(attrs) for section, attrs in csv2vcf._GOOGLE_ATTRS.items()},
        "labelTypes": [[t, list(words), list(kinds)] for t, words, kinds in csv2vcf._LABEL_TYPES],
        "digitZeros": digit_zeros,
        "isdigitNotNd": isdigit_not_nd,
        "codecs": {name: _codec_table(name) for name in SINGLE_BYTE_CODECS},
    }


def render(data: dict) -> str:
    # ensure_ascii: ข้อมูลเป็น ASCII ล้วน (อักขระพิเศษเป็น \\uXXXX) ไม่มีอักขระแฝงหรืออักขระกลับทิศข้อความในซอร์ส
    body = json.dumps(data, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return (
        "// ไฟล์นี้สร้างอัตโนมัติด้วย tools/build_js_data.py จาก csv2vcf.py ห้ามแก้ด้วยมือ\n"
        '"use strict";\n'
        "(function (root) {\n"
        f"  var DATA = {body};\n"
        '  if (typeof module === "object" && module.exports) module.exports = DATA;\n'
        "  else root.CSV2VCF_DATA = DATA;\n"
        '})(typeof self !== "undefined" ? self : this);\n'
    )


def main() -> int:
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(render(build_data()))
    print(f"เขียน {os.path.relpath(OUTPUT, ROOT)} แล้ว")
    return 0


if __name__ == "__main__":
    sys.exit(main())
