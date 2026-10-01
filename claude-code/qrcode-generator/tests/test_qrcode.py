"""เทสต์ระบบสร้าง QR Code (qrcode-generator/)

- ข้อความใน QR แต่ละประเภท (js/payload.js รันใน Node ผ่าน tests/harness.js ถ้าไม่มี Node.js จะข้าม)
  โดยเฉพาะพร้อมเพย์: เลขผู้รับผิดต้องไม่ได้ QR (โอนเงินผิดบัญชี) และ CRC ต้องตรงกับ binascii ของ Python
- ไฟล์หน้าเว็บ: CSP ไม่มี unsafe, ไม่มีสคริปต์/สไตล์ในหน้า, ไม่โหลดไฟล์จากเว็บอื่น, ไฟล์ที่อ้างถึงมีอยู่จริง

    python3 -m unittest discover -s tests -v
"""

import binascii
import json
import os
import random
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
HARNESS = os.path.join(ROOT, "tests", "harness.js")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def crc_ccitt(text):
    return "%04X" % binascii.crc_hqx(text.encode("ascii"), 0xFFFF)


@unittest.skipUnless(NODE, "ต้องมี Node.js")
class PayloadTest(unittest.TestCase):
    def calls(self, requests):
        result = subprocess.run([NODE, HARNESS], input=json.dumps(requests).encode("utf-8"), capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        replies = json.loads(result.stdout.decode("utf-8"))
        for reply in replies:
            self.assertTrue(reply["ok"], reply)
        return [reply["value"] for reply in replies]

    def build(self, kind, **fields):
        return self.calls([{"fn": "build", "args": [kind, fields]}])[0]

    # -- พร้อมเพย์ ---------------------------------------------------------------

    def test_promptpay_targets(self):
        cases = {
            "0812345678": ("01", "0066812345678"),
            "081-234-5678": ("01", "0066812345678"),
            "+66 81 234 5678": ("01", "0066812345678"),   # ใส่รหัสประเทศมา
            "1-2345-67890-12-3": ("02", "1234567890123"),  # เลขประจำตัวประชาชน/ผู้เสียภาษี
            "123456789012345": ("03", "123456789012345"),  # e-Wallet
        }
        for text, (tag, value) in cases.items():
            with self.subTest(id=text):
                self.assertEqual(self.calls([{"fn": "promptpayTarget", "args": [text]}])[0], {"tag": tag, "value": value})

    def test_promptpay_rejects_wrong_lengths(self):
        # เดิมทุกความยาวตั้งแต่ 10 หลักได้ QR — 11/12/14 หลักถูกนับเป็นเบอร์โทร ได้บัญชีปลายทางผิด
        for text in ("081234567", "8123456789", "12345678901", "123456789012", "12345678901234", "1234567890123456"):
            with self.subTest(id=text):
                r = self.build("promptpay", id=text, amount="")
                self.assertEqual(r["data"], "")
                self.assertIn("เลขพร้อมเพย์ไม่ถูกต้อง", r["error"])

    def test_promptpay_payload_and_crc(self):
        static = self.build("promptpay", id="0812345678", amount="")["data"]
        self.assertEqual(static[:-4], "00020101021129370016A000000677010111011300668123456785802TH53037646304")
        self.assertEqual(static[-4:], crc_ccitt(static[:-4]))
        dynamic = self.build("promptpay", id="0812345678", amount="4.22")["data"]
        self.assertEqual(dynamic[:-4], "00020101021229370016A000000677010111011300668123456785802TH530376454044.226304")
        self.assertEqual(dynamic[-4:], crc_ccitt(dynamic[:-4]))
        # จำนวนเงิน 0 = ผู้จ่ายกรอกเอง (static)
        self.assertEqual(self.build("promptpay", id="0812345678", amount="0")["data"], static)

    def test_promptpay_amount_limits(self):
        self.assertIn("54139999999999.99", self.build("promptpay", id="0812345678", amount="9999999999.99")["data"])
        # เศษสตางค์ปัดก่อน: 0.001 = ผู้จ่ายกรอกเอง (เดิมได้ QR เรียกเก็บ 0.00 บาท)
        static = self.build("promptpay", id="0812345678", amount="")["data"]
        self.assertEqual(self.build("promptpay", id="0812345678", amount="0.001")["data"], static)
        self.assertIn("540510.01", self.build("promptpay", id="0812345678", amount="10.006")["data"])
        self.assertIn("5406100.00", self.build("promptpay", id="0812345678", amount="1e2")["data"])
        for amount in ("-1", "10000000000", "abc", "1e400", "Infinity", "0x10", "0b11", " - 5", "1,000"):
            with self.subTest(amount=amount):
                r = self.build("promptpay", id="0812345678", amount=amount)
                self.assertEqual(r["data"], "")
                self.assertIn("จำนวนเงิน", r["error"])

    def test_crc_matches_python_for_random_payloads(self):
        rng = random.Random(7)
        texts = ["".join(rng.choice("0123456789ABCDEFTH.") for _ in range(rng.randint(0, 80))) for _ in range(300)]
        got = self.calls([{"fn": "crc16", "args": [t]} for t in texts])
        self.assertEqual(got, [crc_ccitt(t) for t in texts])

    def test_fits_qr_capacity(self):
        # ความจุ QR รุ่น 40 ตามโหมด (qr-code-styling throw เมื่อยาวเกิน เดิมหน้าเว็บค้าง) — ทั้งพอดีและเกิน 1 ตัว
        capacity = {"0": (7089, 5596, 3993, 3057), "A": (4296, 3391, 2420, 1852), "a": (2953, 2331, 1663, 1273)}
        requests, expected = [], []
        for ch, limits in capacity.items():
            for level, limit in zip("LMQH", limits):
                for n, ok in ((limit, True), (limit + 1, False)):
                    requests.append({"fn": "fitsQr", "args": [ch * n, level]})
                    expected.append(ok)
        requests.append({"fn": "fitsQr", "args": ["a", "X"]})  # ระดับที่ไม่มีจริง
        expected.append(False)
        requests.append({"fn": "fitsQr", "args": ["a", "constructor"]})  # ชื่อ property ของ Object ไม่นับเป็นระดับ
        expected.append(False)
        self.assertEqual(self.calls(requests), expected)
        # ภาษาไทย 1 ตัว = 3 ไบต์ ต้องนับหลังแปลงเป็น UTF-8
        thai = self.calls([{"fn": "utf8Binary", "args": ["ก" * 555]}])[0]
        self.assertEqual(self.calls([{"fn": "fitsQr", "args": [thai, "Q"]}, {"fn": "fitsQr", "args": [thai, "H"]}]), [False, False])
        thai = self.calls([{"fn": "utf8Binary", "args": ["ก" * 424]}])[0]
        self.assertEqual(self.calls([{"fn": "fitsQr", "args": [thai, "H"]}]), [True])

    # -- ประเภทอื่น ---------------------------------------------------------------

    def test_wifi(self):
        r = self.build("wifi", ssid='บ้าน;Net', password='p"a:ss\\', security="WPA")
        self.assertEqual(r["data"], 'WIFI:S:บ้าน\\;Net;T:WPA;P:p\\"a\\:ss\\\\;H:false;;')
        # ไม่มีรหัสผ่าน: ไม่ใส่ P: แม้พิมพ์รหัสค้างไว้
        self.assertEqual(self.build("wifi", ssid="Cafe", password="old", security="nopass")["data"], "WIFI:S:Cafe;T:nopass;H:false;;")
        self.assertEqual(self.build("wifi", ssid="Cafe", password="x", security="<script>")["data"], "WIFI:S:Cafe;T:WPA;P:x;H:false;;")
        self.assertEqual(self.build("wifi", ssid="", password="x", security="WPA")["data"], "")

    def test_phone_email_url_text(self):
        self.assertEqual(self.build("phone", phone="081 234 5678")["data"], "tel:0812345678")
        self.assertEqual(self.build("phone", phone="+66 (81) 234-5678")["data"], "tel:+66(81)234-5678")
        self.assertEqual(self.build("phone", phone="abc"), {"data": "", "error": "เบอร์โทรต้องมีตัวเลข"})
        # ? และ & ในช่องอีเมลต้องไม่กลายเป็นหัวข้ออื่นของ mailto:
        self.assertEqual(self.build("email", to="a@b.com?cc=x@y.z&bcc=q@r.s", subject="")["data"],
                         "mailto:a@b.com%3Fcc%3Dx@y.z%26bcc%3Dq@r.s")
        self.assertEqual(self.build("email", to=" hi@x.co ", subject="งาน & สอบถาม")["data"],
                         "mailto:hi@x.co?subject=%E0%B8%87%E0%B8%B2%E0%B8%99%20%26%20%E0%B8%AA%E0%B8%AD%E0%B8%9A%E0%B8%96%E0%B8%B2%E0%B8%A1")
        self.assertEqual(self.build("url", url="www.example.com")["data"], "https://www.example.com")
        self.assertEqual(self.build("url", url="  https://x.y/a b ")["data"], "https://x.y/a b")
        self.assertEqual(self.build("url", url="   ")["data"], "")  # ไม่แสดง QR ของเว็บตัวอย่างอีก
        self.assertEqual(self.build("text", text="สวัสดี\nครับ")["data"], "สวัสดี\nครับ")
        self.assertEqual(self.build("nope"), {"data": "", "error": None})

    def test_utf8_binary(self):
        # qr-code-styling เข้ารหัสทีละไบต์แบบ Latin-1 จึงต้องแปลงเป็นไบต์ UTF-8 ก่อน ภาษาไทยจะได้ไม่เพี้ยน
        texts = ["", "abc", "สวัสดีครับ", "emoji " + chr(0x1F600), "ก" * 70000]
        got = self.calls([{"fn": "utf8Binary", "args": [t]} for t in texts])
        self.assertEqual(got, [t.encode("utf-8").decode("latin-1") for t in texts])
        # อักขระครึ่งตัว (lone surrogate) ไม่ทำให้ throw — กลายเป็น U+FFFD
        lone = json.loads('"a\\ud800b"')
        self.assertEqual(self.calls([{"fn": "utf8Binary", "args": [lone]}])[0], "a\xef\xbf\xbdb")


class _Tags(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    handle_startendtag = handle_starttag


class StaticFilesTest(unittest.TestCase):
    def setUp(self):
        self.page = read("index.html")
        parser = _Tags()
        parser.feed(self.page)
        parser.close()
        self.tags = parser.tags

    def test_content_security_policy(self):
        policies = [a.get("content") or "" for t, a in self.tags
                    if t == "meta" and (a.get("http-equiv") or "").lower() == "content-security-policy"]
        self.assertEqual(len(policies), 1)
        policy = policies[0]
        self.assertIn("default-src 'none'", policy)
        self.assertIn("script-src 'self';", policy)
        self.assertIn("style-src 'self';", policy)
        self.assertIn("base-uri 'none'", policy)
        self.assertNotIn("unsafe", policy)
        for source in re.findall(r"\S+", policy):
            self.assertNotRegex(source, r"^(https?:|\*|//)", "ห้ามโหลดไฟล์จากเว็บอื่น")

    def test_no_inline_code(self):
        self.assertNotIn("<style", self.page)
        for tag, attrs in self.tags:
            if tag == "script":
                self.assertIn("src", attrs, "ห้ามมีสคริปต์ในหน้า")
            self.assertNotIn("style", attrs)
            self.assertEqual([k for k in attrs if k.startswith("on")], [], "ห้ามมี event handler ในหน้า")

    def test_local_files_exist_and_nothing_external(self):
        for tag, attrs in self.tags:
            for key in ("href", "src"):
                url = attrs.get(key)
                if not url or url.startswith(("data:", "#")):
                    continue
                with self.subTest(url=url):
                    self.assertIsNone(re.match(r"[a-z][a-z0-9+.-]*:|//", url, re.I), "ห้ามโหลดไฟล์จากเว็บอื่น")
                    self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, url.split("?")[0]))), url)
        for name in ("fonts.css", "app.css", "tailwind.css"):
            css = read("css", name)
            for url in re.findall(r"url\(([^)]+)\)", css):
                with self.subTest(css=name, url=url):
                    self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, "css", url.strip("'\"")))), url)
            self.assertNotIn("@import", css)

    def test_back_link_and_file_pickers(self):
        hrefs = [a.get("href") for t, a in self.tags if t == "a"]
        self.assertIn("../index.html", hrefs)
        # Firefox บน Android ล่มเมื่อ accept ไม่ใช่รูปภาพ — ช่องเลือกโลโก้ใช้ image/* เท่านั้น
        pickers = [a for t, a in self.tags if t == "input" and a.get("type") == "file"]
        self.assertEqual([a.get("accept") for a in pickers], ["image/*"])

    def test_scripts_are_safe(self):
        for name in ("app.js", "payload.js"):
            code = read("js", name)
            with self.subTest(file=name):
                for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
                    self.assertNotIn(sink, code)
                self.assertIsNone(re.search(r"\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket", code))
        app = read("js", "app.js")
        keys = re.findall(r"localStorage\.(?:get|set)Item\(([^,)]+)", app)
        self.assertTrue(keys)
        self.assertIn("var SETTINGS_KEY = 'qrcode-generator:settings';", app)  # ขึ้นต้นด้วยชื่อโฟลเดอร์
        self.assertEqual(set(keys), {"SETTINGS_KEY"})


if __name__ == "__main__":
    unittest.main()
