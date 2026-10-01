"""เทสต์ไฟล์หน้าเว็บของ doc2pdf: ต้องไม่โหลดอะไรจากเว็บอื่น (ไม่ต้องมี Node.js)

แอปทำงานในเบราว์เซอร์ทั้งหมด ไลบรารีอยู่ใน vendor/ และใช้ฟอนต์ที่มีในเครื่อง ถ้าหน้าเว็บโหลดไฟล์จากเว็บอื่น
(เช่น Google Fonts หรือ CDN) IP ของผู้ใช้จะถูกส่งไปที่นั่น และเว็บนั้นเปลี่ยนไฟล์ที่ส่งมาได้เอง

    python3 -m unittest discover -s tests -v
"""

import os
import re
import unittest
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ค่าใน CSP ที่อนุญาต: เฉพาะเว็บนี้เอง และข้อมูลที่สร้างในเครื่อง (blob:, data:, กล้อง)
CSP_ALLOWED = {"'self'", "'none'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:", "data:", "mediastream:"}
# URL ที่มีในโค้ดได้: ชื่อ namespace ของ XML (ไม่ได้โหลดจริง)
NAMESPACE_PREFIXES = ("http://www.w3.org/", "http://schemas.openxmlformats.org/", "http://purl.org/")


class _Tags(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    handle_startendtag = handle_starttag


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


class NoThirdPartyTest(unittest.TestCase):
    def setUp(self):
        parser = _Tags()
        parser.feed(read("index.html"))
        parser.close()
        self.tags = parser.tags

    def test_page_links_only_to_own_files(self):
        for tag, attrs in self.tags:
            for key in ("href", "src", "srcset", "action", "poster", "data"):
                url = attrs.get(key)
                if url is None or (tag == "use" and url.startswith("#")):
                    continue
                with self.subTest(tag=tag, url=url):
                    self.assertIsNone(re.match(r"[a-z][a-z0-9+.-]*:|//", url, re.I), "ห้ามโหลดไฟล์จากเว็บอื่น")

    def test_content_security_policy_allows_only_own_site(self):
        policies = [attrs.get("content") or "" for tag, attrs in self.tags
                    if tag == "meta" and (attrs.get("http-equiv") or "").lower() == "content-security-policy"]
        self.assertEqual(len(policies), 1)
        for directive in policies[0].split(";"):
            name, *sources = directive.split()
            for source in sources:
                with self.subTest(directive=name, source=source):
                    self.assertIn(source, CSP_ALLOWED)

    def test_stylesheets_load_nothing_from_other_sites(self):
        folder = os.path.join(ROOT, "css")
        for name in sorted(os.listdir(folder)):
            css = read("css", name)
            with self.subTest(file=name):
                self.assertNotIn("@import", css)
                self.assertIsNone(re.search(r"url\(\s*['\"]?\s*(?:[a-z][a-z0-9+.-]*:|//)", css, re.I))

    def test_android_file_pickers_get_mime_types_only(self):
        # หน้าเลือกไฟล์ของ Android กรองได้เฉพาะ MIME type (type/subtype) — นามสกุลอย่าง .pdf ทำให้หน้าเลือกไฟล์
        # ของ Firefox บน Android ค้างแล้วปิดตัว ทุกช่องเลือกไฟล์ที่มีนามสกุลใน accept ต้องถูกเปลี่ยนบน Android
        code = "\n".join(read("js", name) for name in sorted(os.listdir(os.path.join(ROOT, "js"))))
        overrides = dict(re.findall(r"\$\('(\w+)'\)\.setAttribute\('accept', '([^']*)'\)", code))
        removed = set(re.findall(r"\$\('(\w+)'\)\.removeAttribute\('accept'\)", code))
        for tag, attrs in self.tags:
            if tag == "input" and attrs.get("type") == "file":
                tokens = [t.strip() for t in (attrs.get("accept") or "").split(",") if t.strip()]
                with self.subTest(input=attrs.get("id")):
                    if any(not re.fullmatch(r"[a-z]+/(?:\*|[a-z0-9.+-]+)", t) for t in tokens):
                        self.assertIn(attrs.get("id"), overrides, "ต้องเปลี่ยน accept เป็น MIME type บน Android")
        self.assertEqual(overrides, {"fileInput": "image/*", "pdfInput": "application/pdf"})
        for name, value in overrides.items():
            for token in value.split(","):
                self.assertRegex(token.strip(), r"^[a-z]+/(?:\*|[a-z0-9.+-]+)$", name)
        # Firefox บน Android ล่มก่อนหน้าเลือกไฟล์จะขึ้นเมื่อ accept ไม่ใช่รูปภาพ — ช่องเลือก PDF ต้องไม่มี accept
        self.assertEqual(removed, {"pdfInput"})
        convert = read("js", "pdf-convert.js")
        self.assertIn("if (GECKO_ANDROID) $('pdfInput').removeAttribute('accept');", convert)
        self.assertIn("if (!GECKO_ANDROID) PdfTools.preload();", convert)
        # โหมด "เว็บไซต์เดสก์ท็อป" ของ Firefox บน Android ส่ง user agent เป็น Linux — ต้องดูจากจอสัมผัสด้วย
        self.assertIn("matchMedia('(pointer: coarse)').matches", convert)
        self.assertIn("if (window.PdfConvert && PdfConvert.isAndroid) $('fileInput').setAttribute('accept', 'image/*');", code)

    def test_image_picker_shows_jfif_on_computers(self):
        accept = [attrs.get("accept") for tag, attrs in self.tags if tag == "input" and attrs.get("id") == "fileInput"][0]
        for ext in (".jfif", ".jfi", ".jpe", ".pjpeg", ".pjp"):
            self.assertIn(ext, accept.split(","))

    def test_scripts_contain_no_external_urls(self):
        folder = os.path.join(ROOT, "js")
        for name in sorted(os.listdir(folder)):
            # http(s)://... หรือ "//host..." (URL แบบไม่ระบุ scheme ในสตริง) — ไม่นับ regex อย่าง /^image\//i
            for url in re.findall(r"https?://[^\s'\"`)]+|(?<=['\"`])//[A-Za-z0-9-]+\.[^\s'\"`)]+", read("js", name)):
                with self.subTest(file=name, url=url):
                    self.assertTrue(url.startswith(NAMESPACE_PREFIXES), "ห้ามโหลดไฟล์จากเว็บอื่น")


if __name__ == "__main__":
    unittest.main()
