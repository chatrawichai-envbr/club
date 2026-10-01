"""เทสต์ระบบแก้ไข PDF (pdfedit/)

- ฟังก์ชันล้วนใน js/pdf-core.js (รันใน Node ผ่าน tests/harness.js ถ้าไม่มี Node.js จะข้าม):
  ตรวจชนิดไฟล์จากเนื้อไฟล์, EXIF ของ JPEG, ชื่อไฟล์ที่ดาวน์โหลด, พิกัดเมื่อหน้าหมุน, การย้ายองค์ประกอบเมื่อลบ/เรียงหน้า,
  การแปลงคำตอบของ AI (ต้องไม่กลายเป็น HTML) และ API key
- ไฟล์หน้าเว็บ: CSP ไม่มี unsafe, ไม่มีสคริปต์/สไตล์ในหน้า, ไฟล์ที่อ้างถึงมีอยู่จริง, ช่องเลือกไฟล์ไม่ทำให้ Firefox Android ล่ม,
  API key ไม่ถูกบันทึกลง localStorage ที่ใช้ร่วมกันทั้งโดเมน

    python3 -m unittest discover -s tests -v
"""

import json
import os
import re
import shutil
import struct
import subprocess
import unittest
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
HARNESS = os.path.join(ROOT, "tests", "harness.js")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


def jpeg_with_orientation(value, little_endian=True):
    """JPEG จำลอง: SOI + APP1 (Exif, IFD0 มี Orientation) + SOS"""
    e = "<" if little_endian else ">"
    tiff = (b"II" if little_endian else b"MM") + struct.pack(e + "HI", 42, 8)
    tiff += struct.pack(e + "H", 2)
    tiff += struct.pack(e + "HHIHH", 0x0100, 3, 1, 640, 0)   # ImageWidth
    tiff += struct.pack(e + "HHIHH", 0x0112, 3, 1, value, 0)  # Orientation
    tiff += struct.pack(e + "I", 0)
    app1 = b"Exif\x00\x00" + tiff
    return b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + \
        b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xda\x00\x02" + b"\x00" * 16


@unittest.skipUnless(NODE, "ต้องมี Node.js")
class CoreTest(unittest.TestCase):
    def calls(self, requests):
        result = subprocess.run([NODE, HARNESS], input=json.dumps(requests).encode("utf-8"), capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        replies = json.loads(result.stdout.decode("utf-8"))
        for reply in replies:
            self.assertTrue(reply["ok"], reply)
        return replies

    def call(self, fn, *args):
        return self.calls([{"fn": fn, "args": list(args)}])[0]["value"]

    @staticmethod
    def raw(data):
        return {"$hex": data.hex()}

    def test_pdf_header(self):
        cases = [
            (b"%PDF-1.7\n", True),
            (b"x" * 500 + b"%PDF-1.4", True),        # มีข้อมูลนำหน้า (ไฟล์แนบจากอีเมล)
            (b"x" * 1019 + b"%PDF-", True),           # ยังอยู่ใน 1 KB แรก
            (b"x" * 1020 + b"%PDF-", False),
            (b"%PDF", False),
            (b"", False),
            (b"<html>%PD F-", False),
        ]
        got = [r["value"] for r in self.calls([{"fn": "hasPdfHeader", "args": [self.raw(d)]} for d, _ in cases])]
        self.assertEqual(got, [ok for _, ok in cases])

    def test_image_kind(self):
        cases = [
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "png"),
            (b"\xff\xd8\xff\xe0", "jpeg"),
            (b"GIF89a", None),
            (b"RIFF\x00\x00\x00\x00WEBP", None),
            (b"\x89PNG", None),
            (b"", None),
        ]
        got = [r["value"] for r in self.calls([{"fn": "imageKind", "args": [self.raw(d)]} for d, _ in cases])]
        self.assertEqual(got, [k for _, k in cases])

    def test_jpeg_orientation(self):
        cases = [
            (jpeg_with_orientation(6), 6),
            (jpeg_with_orientation(8, little_endian=False), 8),
            (jpeg_with_orientation(1), 1),
            (jpeg_with_orientation(9), 1),                      # ค่านอกช่วง
            (b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 9 + b"\xff\xda", 1),  # ไม่มี EXIF
            (jpeg_with_orientation(6)[:40], 1),                 # ไฟล์ขาด
            (b"\xff\xd8" + b"\xff\xe1\x00\x01", 1),             # ความยาว segment ผิด
            (b"\x89PNG\r\n\x1a\n", 1),
        ]
        got = [r["value"] for r in self.calls([{"fn": "jpegOrientation", "args": [self.raw(d)]} for d, _ in cases])]
        self.assertEqual(got, [o for _, o in cases])
        # ไฟล์ปลอมขนาดใหญ่ (segment ว่างต่อกันยาว) ต้องจบเร็ว — วนไม่เกินจำนวน segment ที่กำหนด
        big = b"\xff\xd8" + b"\xff\xe2\x00\x02" * 500000
        reply = self.calls([{"fn": "jpegOrientation", "args": [self.raw(big)]}])[0]
        self.assertEqual(reply["value"], 1)
        self.assertLess(reply["ms"], 200)

    def test_shape_thai(self):
        # วรรณยุกต์ + สระอำ → นิคหิต + วรรณยุกต์ + สระอา (pdf-lib วางสระอำหลังวรรณยุกต์ผิดตำแหน่ง)
        self.assertEqual(self.call("shapeThai", "\u0e1b\u0e48\u0e33"), "\u0e1b\u0e4d\u0e48\u0e32")
        self.assertEqual(self.call("shapeThai", "\u0e19\u0e49\u0e33 \u0e01\u0e33"), "\u0e19\u0e4d\u0e49\u0e32 \u0e01\u0e33")
        self.assertEqual(self.call("shapeThai", "abc"), "abc")

    def test_clean_text(self):
        self.assertEqual(self.call("cleanText", "a\r\nb\rc\x00\x07d\te  \n\n ", 100), "a\nb\ncd    e")
        self.assertEqual(self.call("cleanText", "\u0e01" * 10, 4), "\u0e01" * 4)
        self.assertEqual(self.call("cleanText", None, 10), "")
        reply = self.calls([{"fn": "cleanText", "args": [" " * 300000 + "x" + " " * 300000, 0]}])[0]
        self.assertEqual(reply["value"].strip(), "x")
        self.assertLess(reply["ms"], 500)

    def test_colors_and_numbers(self):
        self.assertEqual(self.call("hexColor", " #AbCdEf "), "#abcdef")
        self.assertEqual(self.call("hexColor", "red"), "#000000")
        self.assertEqual(self.call("hexColor", "#12345", "#ffffff"), "#ffffff")
        self.assertEqual(self.call("hexColor", "#123456;background:url(x)"), "#000000")
        self.assertEqual(self.call("hexToRgb01", "#ff0080"), {"r": 1, "g": 0, "b": 128 / 255})
        self.assertEqual(self.call("clamp", "16", 4, 400, None), 16)
        self.assertEqual(self.call("clamp", "9999", 4, 400, None), 400)
        self.assertIsNone(self.call("clamp", "", 4, 400, None))
        self.assertIsNone(self.call("clamp", "abc", 4, 400, None))
        self.assertIsNone(self.call("clamp", "Infinity", 4, 400, None))

    def test_output_name(self):
        cases = [
            (["report.pdf", "edited_", ".pdf"], "edited_report.pdf"),
            (["../../etc/passwd.PDF", "edited_", ".pdf"], "edited_passwd.pdf"),
            (["C:\\Users\\a\\scan", "flattened_", ".pdf"], "flattened_scan.pdf"),
            (["evil\u202egpj.exe.pdf", "", ".pdf"], "evil_gpj.exe.pdf"),        # อักขระกลับทิศข้อความ
            (['a<b>:c"d|e?f*g.pdf', "", ".pdf"], "a_b_c_d_e_f_g.pdf"),
            ([".hidden.pdf", "", ".pdf"], "hidden.pdf"),
            (["...   ", "", ".pdf"], "document.pdf"),
            ([".pdf", "edited_", ".pdf"], "edited_document.pdf"),
            ([None, "", "_images.zip"], "document_images.zip"),
            (["\u0e2a\u0e31\u0e0d\u0e0d\u0e32 2569.pdf", "edited_", ".pdf"], "edited_\u0e2a\u0e31\u0e0d\u0e0d\u0e32 2569.pdf"),
        ]
        got = [r["value"] for r in self.calls([{"fn": "outputName", "args": a} for a, _ in cases])]
        self.assertEqual(got, [n for _, n in cases])
        long_name = self.call("outputName", "x" * 500 + ".pdf", "edited_", ".pdf")
        self.assertEqual(long_name, "edited_" + "x" * 100 + ".pdf")

    def test_page_remapping(self):
        edits = {"1": ["a"], "2": ["b"], "3": ["c"], "__proto__": ["x"], "0": ["z"], "1.5": ["y"], "4": "not-a-list"}
        self.assertEqual(self.call("pageKeys", edits), [1, 2, 3])
        self.assertEqual(self.call("remapAfterDelete", edits, 2), {"1": ["a"], "2": ["c"]})
        self.assertEqual(self.call("remapAfterDelete", edits, 1), {"1": ["b"], "2": ["c"]})
        order = [{"source": "new", "page": 1}, {"source": "main", "page": 3}, {"source": "main", "page": 1}, {"source": "main", "page": 2}]
        self.assertEqual(self.call("remapForOrder", edits, order), {"2": ["c"], "3": ["a"], "4": ["b"]})
        for bad in ("__proto__", "1", 0, -1, 1.5, None):
            self.assertEqual(self.call("remapForOrder", edits, [{"source": "main", "page": bad}]), {}, bad)
        self.assertEqual(self.call("countEdits", edits), 3)

    def test_geometry(self):
        self.assertEqual([self.call("normAngle", a) for a in (0, 90, 360, 450, -90, "270", "x")], [0, 90, 0, 90, 270, 270, 0])
        self.assertEqual(self.call("screenAngle", 90, 0), 90)
        self.assertEqual(self.call("screenAngle", 0, 90), 270)
        self.assertEqual(self.call("screenAngle", 270, 270), 0)
        # จุดเริ่มวาดเลื่อนลง "ด้านล่างขององค์ประกอบ" ตามมุมหมุน (พิกัด PDF แกน y ชี้ขึ้น)
        self.assertEqual(self.call("offsetDown", 100, 500, 0, 20), [100, 480])
        self.assertEqual(self.call("offsetDown", 100, 500, 90, 20), [120, 500])
        self.assertEqual(self.call("offsetDown", 100, 500, 180, 20), [100, 520])
        self.assertEqual(self.call("offsetDown", 100, 500, 270, 20), [80, 500])
        self.assertAlmostEqual(self.call("baselineOffset", 16, 1.3, 0.844, 0.457), 16 * (0.65 + 0.1935))
        self.assertEqual(self.call("alongAxis", 10, 5, 0), 10)
        self.assertEqual(self.call("alongAxis", 10, 5, 90), 5)
        self.assertEqual(self.call("alongAxis", 10, 5, 180), -10)
        self.assertEqual(self.call("renderScale", 1000, 1000, 2, 16000000), 2)
        self.assertAlmostEqual(self.call("renderScale", 4000, 4000, 2, 16000000), 1)

    def test_ai_lines_are_plain_text(self):
        text = "# หัวข้อ\n**สำคัญ** ข้อความ <img src=x onerror=alert(1)>\n* ข้อแรก\n- ข้อสอง **หนา**\n\nจบ ** ไม่ครบคู่"
        lines = self.call("aiLines", text)
        self.assertEqual(lines[0], {"kind": "heading", "parts": [{"text": "หัวข้อ", "bold": False}]})
        self.assertEqual(lines[1]["parts"], [{"text": "สำคัญ", "bold": True}, {"text": " ข้อความ <img src=x onerror=alert(1)>", "bold": False}])
        self.assertEqual(lines[2], {"kind": "bullet", "parts": [{"text": "ข้อแรก", "bold": False}]})
        self.assertEqual(lines[3]["parts"], [{"text": "ข้อสอง ", "bold": False}, {"text": "หนา", "bold": True}])
        self.assertEqual(lines[4], {"kind": "blank", "parts": []})
        self.assertEqual(lines[5]["parts"], [{"text": "จบ ** ไม่ครบคู่", "bold": False}])
        reply = self.calls([{"fn": "aiLines", "args": ["*" * 200000]}])[0]
        self.assertLess(reply["ms"], 500)

    def test_gemini_response(self):
        ok = {"candidates": [{"content": {"parts": [{"text": "ส่วนแรก "}, {"text": "ส่วนสอง"}, {"inlineData": {}}]}, "finishReason": "STOP"}]}
        self.assertEqual(self.call("geminiText", ok), {"text": "ส่วนแรก ส่วนสอง", "blocked": None})
        self.assertEqual(self.call("geminiText", {"promptFeedback": {"blockReason": "SAFETY"}}), {"text": "", "blocked": "SAFETY"})
        self.assertEqual(self.call("geminiText", {"candidates": [{"finishReason": "RECITATION"}]}), {"text": "", "blocked": "RECITATION"})
        self.assertEqual(self.call("geminiText", None), {"text": "", "blocked": None})
        self.assertEqual(self.call("geminiText", {"candidates": "x"}), {"text": "", "blocked": None})

    def test_api_key(self):
        self.assertEqual(self.call("validApiKey", " AIzaSyA-bc_123.xyz456 "), "AIzaSyA-bc_123.xyz456")
        for bad in ("short", "AIzaSy abc 1234567", "AIzaSyabc1234567\r\nX-Evil: 1", "AIzaSy\u0e01\u0e02\u0e03\u0e04\u0e05\u0e06\u0e07", "a" * 201, None):
            with self.subTest(key=bad):
                self.assertEqual(self.call("validApiKey", bad), "")


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
        self.js = {name: read("js", name) for name in sorted(os.listdir(os.path.join(ROOT, "js"))) if name.endswith(".js")}

    def test_content_security_policy(self):
        policies = [a.get("content") or "" for t, a in self.tags
                    if t == "meta" and (a.get("http-equiv") or "").lower() == "content-security-policy"]
        self.assertEqual(len(policies), 1)
        directives = {}
        for part in policies[0].split(";"):
            words = part.split()
            if words:
                directives[words[0]] = words[1:]
        self.assertEqual(directives["default-src"], ["'none'"])
        self.assertEqual(directives["script-src"], ["'self'", "'wasm-unsafe-eval'"])  # ไม่มี unsafe-inline/unsafe-eval
        self.assertEqual(directives["style-src"], ["'self'"])
        self.assertEqual(directives["base-uri"], ["'none'"])
        # ส่งข้อมูลออกนอกเว็บได้ที่เดียว: Gemini API
        self.assertEqual(directives["connect-src"], ["'self'", "https://generativelanguage.googleapis.com"])
        for name, sources in directives.items():
            if name != "connect-src":
                for source in sources:
                    self.assertNotRegex(source, r"^(https?:|\*|//)", name)
        self.assertNotIn("unsafe-inline", policies[0])
        self.assertNotIn("unsafe-eval", policies[0].replace("wasm-unsafe-eval", ""))

    def test_no_inline_code(self):
        self.assertNotIn("<style", self.page)
        for tag, attrs in self.tags:
            if tag == "script":
                self.assertIn("src", attrs, "ห้ามมีสคริปต์ในหน้า")
            self.assertNotIn("style", attrs)
            self.assertEqual([k for k in attrs if k.startswith("on")], [], "ห้ามมี event handler ในหน้า")

    def test_local_files_exist(self):
        for tag, attrs in self.tags:
            for key in ("href", "src"):
                url = attrs.get(key)
                if not url or url.startswith("#"):
                    continue
                with self.subTest(url=url):
                    if url.startswith("https://"):
                        self.assertEqual(tag, "a")  # ลิงก์ภายนอกมีได้เฉพาะลิงก์ที่ผู้ใช้กด
                        self.assertIn("noopener", attrs.get("rel", ""))
                        continue
                    self.assertIsNone(re.match(r"[a-z][a-z0-9+.-]*:|//", url, re.I))
                    self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, url))), url)
        css = read("css", "app.css")
        urls = re.findall(r"url\(([^)]+)\)", css)
        self.assertTrue(urls)
        for url in urls:
            self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, "css", url.strip("'\"")))), url)
        # ไฟล์ที่ js/app.js โหลดทีหลัง
        app = self.js["app.js"]
        paths = re.findall(r"'(vendor/[A-Za-z0-9_./-]+)'", app)
        self.assertGreaterEqual(len(paths), 6)
        for p in paths:
            with self.subTest(path=p):
                full = os.path.join(ROOT, p)
                self.assertTrue(os.path.isfile(full) or os.path.isdir(full), p)

    def test_back_link_and_file_pickers(self):
        hrefs = [a.get("href") for t, a in self.tags if t == "a"]
        self.assertIn("../index.html", hrefs)
        pickers = {a.get("id"): a for t, a in self.tags if t == "input" and a.get("type") == "file"}
        self.assertEqual(sorted(pickers), ["file-input", "image-input", "merge-input"])
        # Firefox บน Android ล่มเมื่อ accept มีนามสกุลหรือชนิดที่ไม่ใช่รูป — ช่อง PDF ไม่มี accept ในหน้า (js ใส่ให้เฉพาะเบราว์เซอร์อื่น)
        self.assertNotIn("accept", pickers["file-input"])
        self.assertNotIn("accept", pickers["merge-input"])
        self.assertEqual(pickers["image-input"].get("accept"), "image/*")
        app = self.js["app.js"]
        self.assertIn("if (!GECKO_ANDROID) input.setAttribute('accept'", app)

    def test_scripts_are_safe(self):
        for name, code in self.js.items():
            with self.subTest(file=name):
                # ใช้งานจริง (กำหนดค่า/เรียก) — คำว่า innerHTML ในรายการห้ามของ Dialog.el ไม่นับ
                self.assertIsNone(re.search(r"\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\('on", code))
        app = self.js["app.js"]
        # ออกอินเทอร์เน็ตได้ที่เดียว และส่ง API key ทาง header ไม่ใช่ใน URL
        self.assertIn("var GEMINI_URL = 'https://generativelanguage.googleapis.com/", app)
        self.assertIn("'x-goog-api-key': S.apiKey", app)
        self.assertNotRegex(app, r"[?&]key=")
        self.assertEqual(re.findall(r"\bfetch\(([^,)]+)", app), ["FONT_URL", "GEMINI_URL"])
        self.assertIn("isEvalSupported: false", app)

    def test_stale_render_errors_are_ignored(self):
        # หมุน/ลบ/เรียงหน้าระหว่างที่หน้าเดิมยังวาดไม่เสร็จ: ข้อผิดพลาดจากเอกสารเก่าต้องไม่เด้งแจ้งผู้ใช้
        app = self.js["app.js"]
        render = app[app.index("async function renderPage()"):app.index("function showPage(")]
        self.assertIn("var stale = function () { return seq !== renderSeq || doc !== S.doc; };", render)
        self.assertIn("page = await doc.getPage(S.page);", render)
        self.assertIn("|| stale()) return;", render)

    def test_api_key_is_never_stored(self):
        app = self.js["app.js"]
        self.assertIn("var THEME_KEY = 'pdfedit:theme';", app)  # key ขึ้นต้นด้วยชื่อโฟลเดอร์
        self.assertEqual(re.findall(r"localStorage\.(\w+)\(([^,)]*)", app), [("getItem", "THEME_KEY"), ("setItem", "THEME_KEY")])
        self.assertNotRegex(app, r"sessionStorage|indexedDB|document\.cookie")
        self.assertNotIn("pdf_toolkit_apikey", app)


if __name__ == "__main__":
    unittest.main()
