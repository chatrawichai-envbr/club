"""เทสต์โค้ด JavaScript ของ doc2pdf (รันใน Node ผ่าน tests/harness.js ต้องมี Node.js ถ้าไม่มีจะข้าม)

เน้นส่วนที่รับข้อมูลที่ไม่น่าเชื่อถือ: ชื่อไฟล์, ข้อความจากไฟล์ PDF และ OCR, ตัวอ่าน PDF (pdf-actualtext.js)
และไฟล์ ZIP/Word ที่สร้างขึ้น ข้อความที่จงใจสร้างต้องไม่ทำให้หน้าเว็บค้าง (ReDoS, zip bomb)

    python3 -m unittest discover -s tests -v
"""

import base64
import io
import json
import os
import shutil
import subprocess
import unittest
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = shutil.which("node")
HARNESS = os.path.join(HERE, "harness.js")
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
# ข้อความแทน "ท่" (UTF-16BE พร้อม BOM) ในรูปสตริง PDF แบบเลขฐานแปด
ACTUAL_TEXT = rb"/Span << /ActualText (\376\377\016\027\016\110) >> BDC (x) Tj EMC" + b"\n"


def as_bytes(data):
    return {"__bytes__": base64.b64encode(data).decode("ascii")}


def from_bytes(value):
    return base64.b64decode(value["__bytes__"])


def make_pdf(objects):
    """PDF แบบง่าย (สตรีมไม่บีบอัด) จาก {เลขวัตถุ: เนื้อหา}"""
    out = b"%PDF-1.7\n"
    for num, body in objects.items():
        out += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    return out + b"trailer << /Root 1 0 R >>\n%%EOF\n"


def stream(entries, data):
    return b"<< " + entries + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


@unittest.skipUnless(NODE, "ต้องมี Node.js")
class Doc2pdfTest(unittest.TestCase):
    def call(self, fn, *args):
        """เรียกฟังก์ชันใน harness.js คืน (ผลลัพธ์, เวลาที่ใช้เป็น ms)"""
        result = subprocess.run(
            [NODE, HARNESS], input=json.dumps([{"fn": fn, "args": list(args)}]).encode("utf-8"),
            capture_output=True, timeout=300,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        reply = json.loads(result.stdout.decode("utf-8"))[0]
        if not reply["ok"]:
            raise ValueError(reply["error"])
        return reply["value"], reply["ms"]

    # -- ชื่อไฟล์ -------------------------------------------------------------

    def test_filename_is_sanitized(self):
        cases = {
            "  ..report.pdf . ": "report.pdf",
            "a/b:c*d": "a_b_c_d.pdf",
            "รายงาน\u202eFDP.exe": "รายงาน_FDP.exe.pdf",
            "a\u200bb\u2060c\ufeffd\u061ce\u0085f": "a_b_c_d_e_f.pdf",  # อักขระล่องหน/ควบคุม C1
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(self.call("sanitizeFilename", name)[0], expected)

    def test_long_filename_is_not_cut_inside_a_character(self):
        # ตัดที่ 100 ตัวตรงกลางอีโมจิ (surrogate pair) ต้องไม่เหลืออักขระครึ่งตัว
        value, _ = self.call("sanitizeFilename", "a" * 99 + "\U0001F600" * 3)
        self.assertEqual(value, "a" * 99 + ".pdf")
        value.encode("utf-8")  # อักขระครึ่งตัวจะ encode ไม่ได้

    def test_filename_with_long_whitespace_is_fast(self):
        value, ms = self.call("sanitizeFilename", "a" + " " * 200000 + "b")
        self.assertEqual(value, "a.pdf")
        self.assertLess(ms, 500)

    # -- ข้อความจาก OCR และจากไฟล์ PDF -----------------------------------------

    def test_ocr_text_cleanup(self):
        value, _ = self.call("cleanText", "a  \r\nb\t\u2028c   \n\n\n\nd ")
        self.assertEqual(value, "a\nb\u2028c\n\nd")

    def test_ocr_text_with_long_whitespace_is_fast(self):
        value, ms = self.call("cleanText", "x" + " " * 200000 + "y  \nz")
        self.assertEqual(value, "x" + " " * 200000 + "y\nz")
        self.assertLess(ms, 500)

    def test_pdf_text_lines(self):
        items = [
            {"str": "hello  ", "x": 0, "y": 0, "width": 50},
            {"str": "world", "x": 500, "y": 0, "width": 50, "hasEOL": True},  # ห่างมาก = คอลัมน์ถัดไป
            {"str": "next line \t ", "x": 0, "y": -20, "width": 50},
        ]
        self.assertEqual(self.call("buildLines", items)[0], ["hello\tworld", "next line"])

    def test_pdf_text_with_long_whitespace_is_fast(self):
        items = [{"str": "a" + " " * 200000 + "b  ", "x": 0, "y": 0, "width": 50}]
        items += [{"str": "w     ", "x": 100 * (i + 1), "y": 0, "width": 5} for i in range(5000)]
        value, ms = self.call("buildLines", items)
        self.assertEqual(len(value), 1)
        self.assertTrue(value[0].startswith("a" + " " * 200000 + "b\tw\tw"))
        self.assertLess(ms, 2000)

    # -- ตัวอ่าน /ActualText ในไฟล์ PDF ------------------------------------------

    def test_actual_text_is_read(self):
        pdf = make_pdf({1: b"<< /Type /Page /Resources << >> /Contents 2 0 R >>", 2: stream(b"", ACTUAL_TEXT)})
        self.assertEqual(self.call("actualText", as_bytes(pdf), 1)[0], [{"tag": "Span", "text": "ท่"}])

    def test_long_number_token_is_fast(self):
        # /\d+\.?\d*$/ เดิมใช้เวลาแบบกำลังสองกับตัวเลขยาว ๆ ที่ตามด้วยตัวอักษร (100,000 ตัว = หลายนาที)
        content = ACTUAL_TEXT + b"1" * 100000 + b"x Tj\n"
        pdf = make_pdf({1: b"<< /Type /Page /Resources << >> /Contents 2 0 R >>", 2: stream(b"", content)})
        value, ms = self.call("actualText", as_bytes(pdf), 1)
        self.assertEqual(value, [{"tag": "Span", "text": "ท่"}])
        self.assertLess(ms, 1000)

    def test_repeated_forms_are_limited(self):
        # ฟอร์มเดียวถูกเรียกซ้ำหลายครั้ง: ไล่ได้รวมไม่เกิน 64 MB ต่อหน้า (กัน zip bomb ที่ทำให้หน้าเว็บค้าง)
        form = stream(b"/Type /XObject /Subtype /Form", ACTUAL_TEXT + b" " * (1024 * 1024))

        def page(calls):
            return make_pdf({
                1: b"<< /Type /Page /Resources << /XObject << /F 3 0 R >> >> /Contents 2 0 R >>",
                2: stream(b"", b"/F Do\n" * calls),
                3: form,
            })

        value, _ = self.call("actualText", as_bytes(page(10)), 1)
        self.assertEqual(len(value), 10)
        value, ms = self.call("actualText", as_bytes(page(100)), 1)
        self.assertIsNone(value)  # อ่านไม่ได้ → ผู้เรียกใช้ข้อความจาก PDF.js ตามเดิม
        self.assertLess(ms, 20000)

    def test_dense_tokens_are_limited(self):
        # ฟอร์มที่อัด token เล็ก ๆ แน่น ๆ ("0 0 m " ~1 MB = 510,000 token) เรียกซ้ำ 2,000 ครั้ง: ไม่เกินเพดานไบต์เร็วพอ
        # เดิมแยก token ~32 ล้านตัว ค้างหน้าเว็บ ~30 วินาทีต่อหน้า — ต้องหยุดที่เพดาน token ต่อหน้า
        form = stream(b"/Type /XObject /Subtype /Form", b"q " + b"0 0 m " * 170000 + b"Q\n")
        pdf = make_pdf({
            1: b"<< /Type /Page /Resources << /XObject << /F 3 0 R >> >> /Contents 2 0 R >>",
            2: stream(b"", ACTUAL_TEXT + b"/F Do\n" * 2000),
            3: form,
        })
        value, ms = self.call("actualText", as_bytes(pdf), 1)
        self.assertIsNone(value)  # อ่านไม่ได้ → ผู้เรียกใช้ข้อความจาก PDF.js ตามเดิม
        self.assertLess(ms, 6000)
        # ทุกหน้าเรียกฟอร์มหนักอันเดียวกัน: เกินเพดาน 3 หน้าแล้วหยุดอ่านทั้งไฟล์ (เดิม 15 หน้า = ค้างราว 7 นาที)
        objs = {1000: stream(b"", b"/F Do\n" * 2000), 1001: form}
        for i in range(1, 16):
            objs[i] = b"<< /Type /Page /Resources << /XObject << /F 1001 0 R >> >> /Contents 1000 0 R >>"
        value, ms = self.call("actualTextPages", as_bytes(make_pdf(objs)), list(range(1, 16)))
        self.assertEqual(value, [None] * 15)
        self.assertLess(ms, 15000)
        # หน้าปกติที่มี token พอสมควรยังอ่านได้
        busy = stream(b"", ACTUAL_TEXT + b"0 0 m " * 100000)
        pdf = make_pdf({1: b"<< /Type /Page /Resources << >> /Contents 2 0 R >>", 2: busy})
        self.assertEqual(self.call("actualText", as_bytes(pdf), 1)[0], [{"tag": "Span", "text": "\u0e17\u0e48"}])

    # -- ไฟล์ ZIP และ Word -----------------------------------------------------

    def test_zip_is_valid(self):
        entries = [{"name": "page-001.txt", "data": "ก" * 1000}, {"name": "dir/b.txt", "data": "b"}]
        data = from_bytes(self.call("zip", entries)[0])
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip())  # CRC ถูกต้องทุกไฟล์
            self.assertEqual(archive.namelist(), ["page-001.txt", "dir/b.txt"])
            self.assertEqual(archive.read("page-001.txt").decode("utf-8"), "ก" * 1000)

    def test_zip_rejects_unsafe_names(self):
        for name in ("../evil.txt", "a/../../evil.txt", "/etc/passwd", "a\\b.txt", "c:evil", "a\x00b", ""):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.call("zip", [{"name": name, "data": "x"}])
        with self.assertRaises(ValueError):
            self.call("zip", [{"name": "a.txt", "data": "1"}, {"name": "a.txt", "data": "2"}])

    def test_docx_escapes_text(self):
        text = 'a<b>&c "q" \x01\ufffe'
        opts = {"title": "<t>&", "font": 'F" onload="x', "pages": [[["line " + text, "col1\tcol2"]], []]}
        data = from_bytes(self.call("docx", opts)[0])
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertIsNone(archive.testzip())
            document = ET.fromstring(archive.read("word/document.xml"))
            core = archive.read("docProps/core.xml").decode("utf-8")
            styles = ET.fromstring(archive.read("word/styles.xml"))
        texts = [t.text for t in document.iter(W + "t")]
        self.assertEqual(texts, ['line a<b>&c "q" ', "col1", "col2"])  # อักขระที่ XML ไม่อนุญาตถูกตัดออก
        self.assertEqual(len(list(document.iter(W + "tab"))), 1)
        self.assertIn("<dc:title>&lt;t&gt;&amp;</dc:title>", core)
        fonts = next(styles.iter(W + "rFonts"))
        self.assertEqual(fonts.get(W + "ascii"), 'F" onload="x')  # ชื่อฟอนต์อยู่ใน attribute เดียว ไม่แทรก attribute ใหม่
        self.assertEqual(len(fonts.attrib), 4)

    # -- ถอดรหัส HEIC ใน worker ---------------------------------------------------

    def test_heic_file_that_hangs_or_crashes_worker_is_not_retried_on_page(self):
        # ไฟล์ที่ทำให้ worker ค้างหรือล่ม ถ้าถอดรหัสซ้ำในหน้าเว็บ หน้าเว็บจะค้าง/ล่มตาม
        for kind in ("hang", "crash"):
            with self.subTest(worker=kind):
                value, _ = self.call("heic", [kind], 1)
                self.assertEqual(value["inline"], 0)
                self.assertFalse(value["results"][0]["ok"])
                self.assertTrue(value["results"][0]["fromWorker"])

    def test_heic_other_files_retry_in_new_worker(self):
        # ไฟล์ที่รอคิวอยู่ตอน worker ถูกปิดเพราะไฟล์อื่น ต้องถอดรหัสได้ใน worker ตัวใหม่
        for kind in ("hang", "crash"):
            with self.subTest(worker=kind):
                value, _ = self.call("heic", [kind, "ok"], 2)
                first, second = value["results"]
                self.assertTrue(first["fromWorker"])
                self.assertTrue(second["ok"], second)
                self.assertEqual((value["workers"], value["inline"]), (2, 0))

    def test_heic_falls_back_to_page_only_when_worker_cannot_load(self):
        value, _ = self.call("heic", ["load"], 1)
        self.assertTrue(value["results"][0]["ok"])
        self.assertEqual(value["inline"], 1)
        value, _ = self.call("heic", ["ok"], 1)
        self.assertEqual((value["results"][0]["ok"], value["inline"]), (True, 0))

    # -- ค่าตั้งค่าที่จำไว้ใน localStorage ---------------------------------------------

    def test_settings_must_be_real_table_entries(self):
        # localStorage ใช้ร่วมกับทุกแอปใต้ envburiramclub.github.io ค่าอย่าง "constructor" ต้องได้ค่าเริ่มต้น
        self.assertEqual(self.call("pick", "PRESETS", "high")[0]["dpi"], 300)
        self.assertEqual(self.call("pick", "FONTS", "tahoma")[0]["name"], "Tahoma")
        for key in ("constructor", "__proto__", "toString", "hasOwnProperty", ""):
            with self.subTest(key=key):
                self.assertEqual(self.call("pick", "PRESETS", key)[0]["dpi"], 150)
                self.assertEqual(self.call("pick", "FONTS", key)[0]["name"], "TH Sarabun New")

    def test_image_file_types(self):
        # JFIF (.jfif, .jfi) และ .jpe, .pjpeg, .pjp คือ JPEG — Android/macOS มักระบุชนิดเป็นไฟล์ทั่วไปหรือไม่ระบุเลย
        accepted = [
            ("photo.jfif", ""), ("photo.jfif", "application/octet-stream"), ("PHOTO.JFIF", "binary/octet-stream"),
            ("photo.jfif", "image/jpeg"), ("photo.jfif", "image/pjpeg"), ("a.jfi", ""), ("a.jpe", ""), ("a.pjpeg", ""),
            ("a.pjp", ""), ("scan.jpg", ""), ("scan.png", "image/png"), ("iphone.heic", "application/octet-stream"),
            ("noext", "image/webp"),
        ]
        rejected = [
            ("photo.jfif", "text/plain"), ("doc.pdf", "application/octet-stream"), ("photo.jfif.exe", ""),
            ("noext", "application/octet-stream"), ("notes.txt", ""), ("jfif", ""), ("photo.jfif ", ""),
        ]
        for name, kind in accepted:
            with self.subTest(name=name, type=kind):
                self.assertTrue(self.call("isImageFile", name, kind)[0])
        for name, kind in rejected:
            with self.subTest(name=name, type=kind):
                self.assertFalse(self.call("isImageFile", name, kind)[0])

    def test_page_layout_with_unknown_page_size(self):
        a4, _ = self.call("pageLayout", 1000, 1414, {"pageSize": "a4", "margin": 10})
        self.assertEqual((round(a4["pw"]), round(a4["ph"])), (210, 297))
        fit, _ = self.call("pageLayout", 1000, 1414, {"pageSize": "fit"})
        for key in ("constructor", "__proto__", "toString", "nope"):
            with self.subTest(pageSize=key):
                # ขนาดที่ไม่มีในตาราง = ตามขนาดภาพ (เดิม "constructor" ได้ NaN ทั้งหน้า)
                self.assertEqual(self.call("pageLayout", 1000, 1414, {"pageSize": key})[0], fit)

    def test_xml_escape(self):
        self.assertEqual(self.call("xml", '<&>"\x00\x0b\ud800x')[0], "&lt;&amp;&gt;&quot;x")


if __name__ == "__main__":
    unittest.main()
