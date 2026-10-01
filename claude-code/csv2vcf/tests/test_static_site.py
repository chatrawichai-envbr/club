"""เทสต์เว็บไซต์ GitHub Pages (index.html, app.js, worker.js, csv2vcf.js ในโฟลเดอร์ csv2vcf/)

csv2vcf.js เป็นโค้ดที่ port มาจาก csv2vcf.py เทสต์นี้ส่งข้อมูลชุดเดียวกันให้ทั้งสองภาษา
แล้วเทียบผลทุกไบต์ รวมถึงคำเตือนและข้อความผิดพลาด ต้องมี Node.js (ถ้าไม่มีจะข้ามเทสต์)
"""

import base64
import csv
import json
import os
import random
import re
import shutil
import subprocess
import sys
import unittest
import unicodedata
from urllib.parse import urlencode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import csv2vcf  # noqa: E402
import webapp  # noqa: E402

# หน้าเว็บ GitHub Pages อยู่ในโฟลเดอร์เดียวกับ csv2vcf.py (เผยแพร่ที่ /claude-code/csv2vcf/)
SITE = ROOT
WEB = os.path.join(ROOT, "web")
NODE = shutil.which("node")
HARNESS = os.path.join(ROOT, "tests", "js_harness.js")


def run_js(requests):
    """ส่งคำขอทั้งหมดให้ Node ในครั้งเดียว คืนผลลัพธ์ตามลำดับ"""
    result = subprocess.run(
        [NODE, HARNESS], input=json.dumps(requests).encode("utf-8"), capture_output=True, timeout=600
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr.decode("utf-8", "replace"))
    return json.loads(result.stdout.decode("utf-8"))


def as_bytes(data):
    return {"__bytes__": base64.b64encode(data).decode("ascii")}


def py_convert(data, settings):
    """ผลลัพธ์ของฝั่ง Python ผ่านโค้ดเดียวกับ API ของ webapp.py"""
    params = {
        "country_code": settings.get("countryCode"),
        "date_order": settings.get("dateOrder"),
        "encoding": settings.get("encoding"),
        "delimiter": settings.get("delimiter"),
    }
    query = urlencode({key: value for key, value in params.items() if value})
    try:
        options, encoding, delimiter = webapp.App._options(query)
        return {"ok": True, "value": webapp.App._run_conversion(data, options, encoding, delimiter)}
    except webapp.RequestError as exc:
        return {"ok": False, "error": str(exc)}


def column_dict(column):
    if column is None:
        return None
    return {"kind": column.kind, "attr": column.attr, "group": list(column.group), "types": list(column.types)}


def py_call(fn, args):
    """เรียกฟังก์ชันฝั่ง Python ที่ตรงกับชื่อฟังก์ชันฝั่ง JavaScript"""
    try:
        if fn == "cleanText":
            value = csv2vcf.clean_text(*args)
        elif fn == "escapeText":
            value = csv2vcf.escape_text(*args)
        elif fn == "foldLine":
            value = csv2vcf.fold_line(*args)
        elif fn == "show":
            value = csv2vcf.show(*args)
        elif fn == "escapeControls":
            value = csv2vcf.escape_controls(*args)
        elif fn == "asciiDigits":
            value = csv2vcf._ascii_digits(*args)
        elif fn == "normalizePhone":
            value = list(csv2vcf.normalize_phone(*args))
        elif fn == "splitEmails":
            value = csv2vcf.split_emails(*args)
        elif fn == "normalizeEmail":
            value = csv2vcf.normalize_email(*args)
        elif fn == "normalizeUrl":
            value = csv2vcf.normalize_url(*args)
        elif fn == "normalizeBirthday":
            value = csv2vcf.normalize_birthday(*args)
        elif fn == "normalizeHeader":
            value = csv2vcf.normalize_header(*args)
        elif fn == "classifyHeader":
            value = column_dict(csv2vcf.classify_header(*args))
        elif fn == "typesFromLabel":
            value = list(csv2vcf.types_from_label(*args))
        elif fn == "detectDelimiter":
            value = csv2vcf.detect_delimiter(*args)
        elif fn == "decodeCsvBytes":
            value = list(csv2vcf.decode_csv_bytes(*args))
        else:
            raise AssertionError(fn)
        return {"ok": True, "value": value}
    except csv2vcf.ConversionError as exc:
        return {"ok": False, "error": str(exc)}


# ข้อมูลทดสอบที่คัดมาเฉพาะกรณียาก (ชื่อ, ข้อมูล CSV, การตั้งค่า)
def _fixtures():
    with open(os.path.join(ROOT, "example.csv"), "rb") as fh:
        example = fh.read()
    thai = "ชื่อ,เบอร์โทร\nสมชาย,๐๘๑-๒๓๔-๕๖๗๘\n"
    cases = [
        ("ไฟล์ตัวอย่าง", example, {}),
        ("ไฟล์ตัวอย่าง + รหัสประเทศ", example, {"countryCode": "66"}),
        ("รหัสประเทศเลขไทย", example, {"countryCode": "๖๖"}),
        ("Google Contacts", (
            "Name,Given Name,Family Name,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value,"
            "Phone 2 - Type,Phone 2 - Value,Address 1 - Type,Address 1 - Formatted,Address 1 - Street,"
            "Address 1 - City,Address 1 - Postal Code,Address 1 - Country,Organization 1 - Name,Organization 1 - Title\n"
            "Jane Doe,Jane,Doe,* Work,jane@work.example ::: jane@home.example,* Mobile,081-111-1111 ::: 081-222-2222,"
            'Work Fax,02-333-3333,Home,"1 Main St\nSpringfield",1 Main St,Springfield,12345,US,Acme,Engineer\n'
        ).encode(), {}),
        ("Outlook", (
            "First Name,Last Name,Company,Job Title,Department,Business Phone,Home Phone,Mobile Phone,Business Fax,"
            "E-mail Address,E-mail 2 Address,Home Street,Home Street 2,Home City,Home Postal Code,Home Country/Region,Web Page\n"
            "Bob,Builder,BuildCo,Foreman,Ops,02-000-0001,02-000-0002,081-000-0003,02-000-0004,bob@build.example,"
            "bob2@build.example,5 Oak Rd,Apt 2,Leeds,LS1,UK,build.example\n"
        ).encode(), {}),
        ("ที่อยู่ไทย", "ชื่อ,ที่อยู่,ตำบล/แขวง,อำเภอ/เขต,จังหวัด,รหัสไปรษณีย์\nสมชาย,99/1 ถนนสุขุมวิท,คลองเตย,คลองเตย,กรุงเทพมหานคร,10110\n".encode(), {}),
        ("แทรกบรรทัด vCard", 'Name,Notes,Address\n"Evil\r\nEND:VCARD\r\nBEGIN:VCARD","a\rb\u2028c\x85d\x0be","x\ny"\n'.encode(), {}),
        ("อักขระควบคุม", 'Name,Phone\n"\x1b[31mRed\u202eevil\u2066\x01\x7f\x9b\ufeff",081\u200b1111111\n'.encode(), {}),
        ("escape", 'Name,Notes\n"Smith, Jr; a\\b","x,y;z"\n'.encode(), {}),
        ("บรรทัดยาว", ("Name,Notes\nA," + "ภาษาไทยยาวมาก😀 ,;\\" * 40 + "\n").encode(), {}),
        ("เบอร์หลายแบบ", (
            'Name,Phone,Mobile,Fax\nA,"(+66) 81-234-5678, +44 (0)20 7946 0000 / 02-123-4567 ต่อ 12",'
            '"8.12345678E+08;12;Tel: 081 234 5678",0811111111\n'
        ).encode(), {"countryCode": "66"}),
        ("อีเมลหลายแบบ", 'Name,Email\nA,"a@example.com; mailto:b@example.co.th, not-an-email, Somchai <s@example.com>, admin\u200b@bank.co.th"\n'.encode(), {}),
        ("URL หลายแบบ", (
            'Name,Website\nA,"example.com:::javascript:alert(1):::https://www.bank.co.th@evil.example:::'
            'https://[::1]:8080/x:::https://[abc]/:::https://a℀b.com/:::https://ex.com:99999:::HTTP://ok.test/@user"\n'
        ).encode(), {}),
        ("วันเกิด dmy", "Name,Birthday\nA,12/05/2533\nB,31/02/1990\nC,19900512\nD,2530-05-12 00:00:00\n".encode(), {}),
        ("วันเกิด mdy", "Name,Birthday\nA,05/12/1990\nB,๐๕/๑๒/๒๕๓๓\n".encode(), {"dateOrder": "mdy"}),
        ("ตัวคั่น ;", b'Name;Phone;"Note, with, many, commas"\n"Doe, John";0811111111;x\n', {}),
        ("ตัวคั่นแท็บ", b"Name\tPhone\nA\t0811111111\n", {}),
        ("เลือกตัวคั่นเอง", b"Name|Phone\nA|0811111111\n", {"delimiter": "pipe"}),
        ("sep= ของ Excel", "\ufeffsep=;\nName;Phone\nA;0811111111\n".encode(), {}),
        ("sep= ที่ไม่ถูกต้อง", b'sep="\nName,Phone\nA,0811111111\n', {}),
        ("BOM UTF-8", b"\xef\xbb\xbfName,Phone\r\nA,0811111111\r\n", {}),
        ("cp874", thai.encode("cp874"), {}),
        ("cp874 ระบุเอง", thai.encode("cp874"), {"encoding": "cp874"}),
        ("tis-620", thai.encode("tis-620"), {"encoding": "tis-620"}),
        ("cp1252", "Name,Notes\nJosé,café\n".encode("cp1252"), {"encoding": "cp1252"}),
        ("UTF-16 BOM", thai.encode("utf-16"), {}),
        ("UTF-16 BE BOM", b"\xfe\xff" + thai.encode("utf-16-be"), {"encoding": "utf-16"}),
        ("UTF-16 ไม่มี BOM", thai.encode("utf-16-le"), {"encoding": "utf-16"}),
        ("UTF-16 เสีย", b"\xff\xfeN\x00a\x00\x00\xd8", {}),
        ("UTF-8 ระบุเองแต่ไฟล์เสีย", b"Name\nab\xe0\xa4", {"encoding": "utf-8"}),
        ("UTF-8 BOM แต่ไฟล์เสีย", b"\xef\xbb\xbfName\nab\xff", {}),
        ("ไม่ใช่ทั้ง UTF-8 และ cp874", b"Name\na\xff\xdb", {}),
        ("NUL", b"Name,Phone\nA,081\x00\n", {}),
        ("Excel", b"PK\x03\x04" + b"\x00" * 20, {}),
        ("เครื่องหมายคำพูดไม่ปิด", b'Name,Phone\n"Bob,0811111111\nAlice,0822222222\n', {}),
        ("ข้อความหลังเครื่องหมายคำพูด", b'Name,Phone\n"Bob"x,0811111111\n', {}),
        ("ช่องยาวพอดีเพดาน", b'Name,Notes\nA,"' + b"x" * 131072 + b'"\n', {}),
        ("ช่องยาวเกินเพดาน", b'Name,Notes\nA,"' + b"x" * 131073 + b'"\n', {}),
        ("ไม่มีคอลัมน์ที่รู้จัก", b"foo,bar\n1,2\n", {}),
        ("ไฟล์ว่าง", b"\n\n", {}),
        ("ไม่มีรายชื่อ", b"Name,Phone\n,\n", {}),
        ("แถวว่างและแถวที่ไม่มีข้อมูล", b"\n\nName,Notes,Extra\n\n,\nA,,\n,only a note,x\n  ,  \n", {}),
        ("ขึ้นบรรทัดแบบ CR", b"Name,Phone\rA,0811111111\rB,0822222222", {}),
        ("หลายบรรทัดในเครื่องหมายคำพูด", b'Name,Notes\r\nA,"line1\r\nline2\rline3\n"\r\nB,x', {}),
        ("หัวคอลัมน์ชื่อพิเศษของ JavaScript", b"constructor,__proto__,toString,hasOwnProperty,Name\n1,2,3,4,A\n", {}),
        ("Google คอลัมน์ชื่อพิเศษ", b"Phone 1 - constructor,Phone 1 - Value,Name\nx,0811111111,A\n", {}),
        ("หัวคอลัมน์เลขไทย", "Phone ๑ - Value,Phone ๑ - Type,Name ๒,E-mail ² Address\n0811111111,Mobile,A,a@b.co\n".encode(), {}),
        ("หัวคอลัมน์ซ้ำ", b"Name,Phone,Phone\nA,081-111-1111,082-222-2222\n", {}),
        ("แถวสั้นและยาว", b"Name,Phone,Email\nA\nB,0811111111,b@example.com,extra\n", {}),
        ("ป้ายชนิดเบอร์แทรกข้อมูล", b'Phone 1 - Type,Phone 1 - Value,E-mail 1 - Type,E-mail 1 - Value\n"X-EVIL=1;VALUE=uri:tel","0811111111","work:evil@x.com\r\nURL:http://x","a@b.co"\n', {}),
        ("คำเตือนเกินเพดาน", ("Name,Email\n" + "A,bad\n" * 150).encode(), {}),
        ("คอลัมน์ไม่รู้จักจำนวนมาก", ("Name," + ",".join("x%d" % i for i in range(80)) + "\nA\n").encode(), {}),
        ("ตั้งค่าผิด: รหัสประเทศ", example, {"countryCode": "abc"}),
        ("ตั้งค่าผิด: ลำดับวันที่", example, {"dateOrder": "ymd"}),
        ("ตั้งค่าผิด: encoding", example, {"encoding": "punycode"}),
        ("ตั้งค่าผิด: ตัวคั่น", example, {"delimiter": "x"}),
    ]
    return cases


def _random_csv(rng):
    pieces = list("aZ09 ,;:\t\r\n\"'<>@.+-()/|*#\\\x1b\x7f\x85\u2028\u202e\u200b\u00adกำ่๑😀é") + [
        "BEGIN:VCARD", "END:VCARD", "javascript:", "http://", "https://", ":::", "ต่อ", "ext", "(0)", "(+66)",
        "www.", ".co.th", "[::1]", ":80", "mailto:", "* Mobile", "Work", "2533", "/", "-", "E+08", "@example.com",
    ]
    headers = [
        "Name", "First Name", "Last Name", "Phone", "Mobile", "Home Phone", "Email", "E-mail 1 - Type", "E-mail 1 - Value",
        "Phone 1 - Type", "Phone 1 - Value", "Address", "Home Street", "Home City", "Address 1 - Formatted",
        "Website", "Birthday", "Notes", "Company", "Department", "ชื่อ", "จังหวัด", "ตำบล", "Unknown",
    ]
    rng.shuffle(headers)
    headers = headers[: rng.randint(1, len(headers))]
    delimiter = rng.choice([",", ";", "\t", "|"])
    lines = [delimiter.join(headers)]
    for _ in range(rng.randint(0, 12)):
        cells = []
        for _ in range(rng.randint(0, len(headers) + 1)):
            cell = "".join(rng.choice(pieces) for _ in range(rng.randint(0, 40)))
            if rng.random() < 0.7:
                cell = '"' + cell.replace('"', '""') + '"'
            cells.append(cell)
        lines.append(delimiter.join(cells))
    text = rng.choice(["\n", "\r\n", "\r"]).join(lines) + rng.choice(["", "\n"])
    encoding = rng.choice(["utf-8", "utf-8", "utf-8-sig", "utf-16", "cp874"])
    data = text.encode(encoding, "replace")
    settings = {
        "countryCode": rng.choice([None, "66", "1"]),
        "dateOrder": rng.choice([None, "dmy", "mdy"]),
        "encoding": rng.choice(["auto", "auto", "auto", "utf-8", "cp874", "utf-16"]),
        "delimiter": rng.choice(["", "", "comma", "semicolon", "tab", "pipe"]),
    }
    return data, {key: value for key, value in settings.items() if value}


def _random_text(rng, pieces, size=40):
    return "".join(rng.choice(pieces) for _ in range(rng.randint(0, size)))


@unittest.skipUnless(NODE, "ต้องมี Node.js เพื่อรันโค้ด JavaScript")
@unittest.skipUnless(sys.version_info >= (3, 11), "เทียบกับพฤติกรรมของ Python 3.11 ขึ้นไป (urllib.parse)")
class JavaScriptMatchesPythonTest(unittest.TestCase):
    def compare(self, requests, expected, labels):
        actual = run_js(requests)
        for label, want, got in zip(labels, expected, actual):
            self.assertFalse(got.get("crash"), "%s: %s" % (label, got))
            self.assertEqual(want, got, label)

    def test_fixtures(self):
        cases = _fixtures()
        requests = [{"op": "convert", "data": as_bytes(data), "settings": settings} for _, data, settings in cases]
        expected = [py_convert(data, settings) for _, data, settings in cases]
        self.compare(requests, expected, [name for name, _, _ in cases])
        self.assertTrue(any(result["ok"] for result in expected))
        self.assertTrue(any(not result["ok"] for result in expected))

    def test_random_files(self):
        rng = random.Random(20260928)
        cases = [_random_csv(rng) for _ in range(400)]
        requests = [{"op": "convert", "data": as_bytes(data), "settings": settings} for data, settings in cases]
        expected = [py_convert(data, settings) for data, settings in cases]
        self.compare(requests, expected, ["ไฟล์สุ่ม %d: %r" % (i, cases[i]) for i in range(len(cases))])
        self.assertGreater(sum(result["ok"] for result in expected), 50)  # ต้องมีไฟล์ที่แปลงได้จริงจำนวนมาก

    def test_functions_with_random_values(self):
        rng = random.Random(7)
        pieces = list("aZ09 +-()./:@[]%#?=&;,\\\"'<>|\t\n\r\x00\x1b\x7f\x85\u2028\u202e\u200b\u00adกำ่๑๙٣０😀éΣ") + [
            "http", "https", "://", "(0)", "(+66)", "ต่อ", "ext", "x", ":::", "www.", ".co.th", "[::1]", "[v1.x]",
            ":80", ":99999", "mailto:", "MAILTO:", "* ", "mobile", "Work", "fax", "home", "E+08", "2533", "℀",
            "phone 1 - ", "e-mail", "address 2 - city", "home ", "business ", "_", "constructor", "__proto__",
        ]
        requests, expected, labels = [], [], []

        def add(fn, *args):
            requests.append({"op": "call", "fn": fn, "args": [as_bytes(a) if isinstance(a, bytes) else a for a in args]})
            expected.append(py_call(fn, args))
            labels.append("%s%r" % (fn, args))

        for _ in range(1500):
            text = _random_text(rng, pieces)
            add("cleanText", text, rng.random() < 0.5)
            add("escapeText", text)
            add("show", text, rng.choice([5, 60]))
            add("escapeControls", text)
            add("asciiDigits", text)
            add("normalizePhone", text, rng.choice([None, "66"]))
            add("splitEmails", text)
            add("normalizeEmail", text)
            add("normalizeUrl", text)
            add("normalizeBirthday", text, rng.choice(["dmy", "mdy"]))
            add("normalizeHeader", text)
            add("classifyHeader", text, rng.randint(0, 5))
            add("typesFromLabel", text, rng.choice(["tel", "email", "adr", "url"]))
            add("detectDelimiter", text)
            add("foldLine", "NOTE:" + csv2vcf.escape_text(text * rng.randint(1, 6)), rng.choice([75, 75, 10, 20]))
        for _ in range(300):
            data = bytes(rng.randrange(256) for _ in range(rng.randint(0, 12)))
            for encoding in ("auto", "utf-8", "utf-8-sig", "utf-16", "cp874", "tis-620", "cp1252"):
                add("decodeCsvBytes", data, encoding)
        self.compare(requests, expected, labels)


class DataFileTest(unittest.TestCase):
    def test_generated_data_is_up_to_date(self):
        # ถ้าแก้ตารางใน csv2vcf.py แล้วลืมรัน tools/build_js_data.py เทสต์นี้จะเตือน
        import build_js_data

        with open(os.path.join(SITE, "csv2vcf-data.js"), encoding="utf-8") as fh:
            current = fh.read()
        match = re.search(r"var DATA = (\{.*\});\n", current)
        self.assertIsNotNone(match)
        on_disk = json.loads(match.group(1))
        fresh = build_js_data.build_data()
        if on_disk["unicodeVersion"] != fresh["unicodeVersion"]:
            # ตารางตัวเลขขึ้นกับรุ่น Unicode ของ Python ที่ใช้สร้าง เทียบเฉพาะส่วนที่เหลือ
            for key in ("unicodeVersion", "digitZeros", "isdigitNotNd"):
                on_disk.pop(key)
                fresh.pop(key)
        self.assertEqual(on_disk, json.loads(json.dumps(fresh)), "ให้รัน python3 tools/build_js_data.py ใหม่")
        self.assertEqual(on_disk["fieldLimit"], csv.field_size_limit())


class StaticFilesTest(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(SITE, name), encoding="utf-8") as fh:
            return fh.read()

    def test_required_files_exist(self):
        for name in ("index.html", "style.css", "app.js", "worker.js", "csv2vcf.js", "csv2vcf-data.js",
                     "example.csv", "favicon.svg"):
            self.assertTrue(os.path.isfile(os.path.join(SITE, name)), name)

    def test_content_security_policy(self):
        page = self.read("index.html")
        match = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', page)
        self.assertIsNotNone(match, "ต้องมี CSP ใน <meta> (GitHub Pages ตั้ง header เองไม่ได้)")
        csp = match.group(1)
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'none'", csp)  # หน้าเว็บส่งข้อมูลออกไปไหนไม่ได้
        self.assertNotIn("unsafe", csp)
        self.assertIn('<meta name="referrer" content="no-referrer">', page)

    def test_no_inline_code_and_relative_urls(self):
        page = self.read("index.html")
        self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)[^>]*>", page), "ห้ามมีสคริปต์ inline")
        self.assertNotIn("<style", page)
        self.assertIsNone(re.search(r"\sstyle=", page))
        self.assertIsNone(re.search(r"\son[a-z]+=", page), "ห้ามมี event handler inline")
        # GitHub Pages ของ repo อยู่ใต้ /ชื่อ-repo/ ลิงก์ต้องเป็นแบบ relative
        for url in re.findall(r'(?:href|src)="([^"]+)"', page):
            self.assertFalse(url.startswith("/"), url)
            self.assertNotRegex(url, r"^[a-z]+:", url)

    def test_scripts_never_use_html_injection_sinks(self):
        for name in ("app.js", "worker.js", "csv2vcf.js"):
            code = self.read(name)
            for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
                self.assertFalse(sink in code, "%s ใช้ %s" % (name, sink))
            network = re.search(r"\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource", code)
            self.assertIsNone(network, "%s เชื่อมต่อเครือข่าย" % name)

    def test_links_back_to_home_page(self):
        # หน้าหลักของ repo (../index.html) รวมลิงก์ทุกระบบ หน้านี้ต้องมีลิงก์กลับ
        self.assertIn('href="../index.html"', self.read("index.html"))
        self.assertTrue(os.path.isfile(os.path.join(ROOT, "..", "index.html")))

    def test_both_sites_share_one_stylesheet(self):
        # web/ (webapp.py) กับหน้า GitHub Pages ใช้ style.css ชุดเดียวกัน แก้ที่หนึ่งต้องแก้อีกที่
        with open(os.path.join(SITE, "style.css"), "rb") as a, open(os.path.join(WEB, "style.css"), "rb") as b:
            self.assertEqual(a.read(), b.read())

    def test_android_file_picker_gets_no_extension_filter(self):
        # หน้าเลือกไฟล์ของ Android กรองได้เฉพาะ MIME type: accept ".csv,.txt" ทำให้หน้าเลือกไฟล์ของ Firefox
        # บน Android ค้างแล้วปิดตัว ทั้งสองหน้าต้องเอา accept ออกบน Android ก่อนผูก event ใด ๆ
        for name in ("app.js", os.path.join("web", "app.js")):
            with self.subTest(file=name):
                code = self.read(name)
                fix = code.index('if (android) input.removeAttribute("accept");')
                self.assertLess(fix, code.index("addEventListener"))
                # โหมด "เว็บไซต์เดสก์ท็อป" บน Android ส่ง user agent เป็น Linux — ต้องดูจากจอสัมผัสด้วย
                self.assertIn('window.matchMedia("(pointer: coarse)").matches', code[:fix])
        for name in ("index.html", os.path.join("web", "index.html")):
            with self.subTest(file=name):
                # บนคอมพิวเตอร์ยังกรองด้วยนามสกุล (Windows/Mac รู้จักนามสกุลดีกว่า MIME type)
                self.assertIn('accept=".csv,.txt,text/csv"', self.read(name))

    @unittest.skipUnless(NODE, "ต้องมี Node.js เพื่อรันโค้ด JavaScript")
    def test_download_name_is_safe(self):
        # ชื่อไฟล์ผลลัพธ์มาจากชื่อไฟล์ของผู้ใช้: อักขระกลับทิศข้อความทำให้ "a<U+202E>exe.csv" แสดงเป็นไฟล์ .exe
        # จุดนำหน้าทำให้ได้ไฟล์ซ่อน และอักขระอย่าง : ? * ใช้ในชื่อไฟล์ Windows ไม่ได้
        cases = [
            ("contacts.csv", "contacts.vcf"),
            ("a\u202eexe.csv", "aexe.vcf"),
            ("\u200bphone\u2066book.txt", "phonebook.vcf"),
            ("..hidden.csv", "hidden.vcf"),
            ('a:b?c*"d<e>|f.csv', "a_b_c__d_e__f.vcf"),
            ("\u0e23\u0e32\u0e22\u0e0a\u0e37\u0e48\u0e2d.csv", "\u0e23\u0e32\u0e22\u0e0a\u0e37\u0e48\u0e2d.vcf"),
            (".csv", "contacts.vcf"),
            ("", "contacts.vcf"),
            ("x" * 400 + ".csv", "x" * 150 + ".vcf"),
        ]
        for name in ("app.js", os.path.join("web", "app.js")):
            code = self.read(name)
            funcs = code[code.index("  function displayName("):code.index("  function unescapeText(")]
            script = funcs + "process.stdout.write(JSON.stringify(%s.map((n) => [vcfName(n), displayName(n)])));" % json.dumps([n for n, _ in cases])
            out = subprocess.run([NODE, "-e", script], capture_output=True, timeout=60)
            self.assertEqual(out.returncode, 0, out.stderr.decode("utf-8", "replace"))
            got = json.loads(out.stdout.decode("utf-8"))
            with self.subTest(file=name):
                self.assertEqual([g[0] for g in got], [e for _, e in cases])
                self.assertEqual(got[1][1], "aexe.csv")  # ชื่อที่แสดงบนหน้าเว็บก็ตัดอักขระกลับทิศข้อความ
                self.assertIn("displayName(candidate.name)", code)

    def test_server_page_has_same_csp_as_webapp_header(self):
        # web/index.html ถูกเผยแพร่บน GitHub Pages ด้วย ซึ่งตั้ง header ไม่ได้ — CSP ในหน้าต้องเท่ากับ header ของ webapp.py
        page = self.read(os.path.join("web", "index.html"))
        found = re.findall(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)">', page)
        header = dict(webapp.SECURITY_HEADERS)["Content-Security-Policy"]
        expected = "; ".join(p.strip() for p in header.split(";") if p.strip() and not p.strip().startswith("frame-ancestors"))
        self.assertEqual(found, [expected])
        self.assertIn('<meta name="referrer" content="no-referrer">', page)

    def test_server_page_refuses_to_run_without_webapp(self):
        # web/index.html ถูกเผยแพร่บน GitHub Pages ด้วย (ที่ csv2vcf/web/) แต่ที่นั่นไม่มี /api/convert
        # หน้านั้นต้องไม่ส่งไฟล์ไปไหน และพาไปใช้เวอร์ชันที่แปลงในเบราว์เซอร์แทน
        page = self.read(os.path.join("web", "index.html"))
        self.assertIn('data-max-mb="__MAX_MB__"', page)
        self.assertRegex(page, r'<p class="status error" id="standalone" hidden>[^<]*<a href="\.\./index\.html">')
        for url in re.findall(r'(?:href|src)="([^"]+)"', page):
            # URL แบบ relative ใช้ได้ทั้งที่ / ของ webapp.py และใต้ /claude-code/csv2vcf/web/ บน GitHub Pages
            self.assertFalse(url.startswith("/"), url)
        code = self.read(os.path.join("web", "app.js"))
        guard = code.index("if (!servedByWebapp)")
        self.assertLess(guard, code.index("addEventListener"), "ต้องตรวจก่อนผูก event ใด ๆ")
        self.assertLess(guard, code.index("fetch("))
        self.assertIn('fetch("api/convert?"', code)

    def test_no_hidden_characters_in_sources(self):
        for folder in (SITE, WEB):
            for name in os.listdir(folder):
                if name.endswith((".html", ".css", ".js", ".svg", ".csv", ".md")):
                    text = self.read(os.path.join(folder, name))
                    hidden = [hex(ord(ch)) for ch in text if unicodedata.category(ch) in ("Cf", "Zl", "Zp", "Co")
                              or (unicodedata.category(ch) == "Cc" and ch not in "\n\t\r")]
                    self.assertEqual(hidden, [], name)


if __name__ == "__main__":
    unittest.main()
