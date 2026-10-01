"""เทสต์ระบบลบพื้นหลังรูปภาพ (bg-remove/)

- ฟังก์ชันล้วนใน js/core.js (รันใน Node ผ่าน tests/harness.js ถ้าไม่มี Node.js จะข้าม):
  ตรวจชนิดรูปจากเนื้อไฟล์ทุกชนิดที่รองรับ, ขนาดของ SVG, อินพุต/เอาต์พุตของโมเดล, การย่อภาพ, ชื่อไฟล์ที่ดาวน์โหลด
- ไฟล์หน้าเว็บ: CSP ไม่มี unsafe และไม่ส่งข้อมูลออกนอกเว็บ, ไม่มีสคริปต์/สไตล์ในหน้า, ไฟล์ที่อ้างถึง (รวมโมเดล) มีอยู่จริง,
  ช่องเลือกไฟล์ไม่ทำให้ Firefox Android ล่ม

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


def ftyp(major, compatible):
    body = major + b"\x00\x00\x00\x00" + b"".join(compatible)
    return struct.pack(">I", 8 + len(body)) + b"ftyp" + body + b"\x00" * 16


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

    def test_detect_format(self):
        bmp = b"BM" + b"\x00" * 12 + struct.pack("<I", 40) + b"\x00" * 16
        cases = [
            (b"\xff\xd8\xff\xe0\x00\x10JFIF", "jpeg"),                  # .jpg .jpeg .jfif
            (b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "png"),
            (b"GIF89a" + b"\x00" * 8, "gif"),
            (b"GIF87a" + b"\x00" * 8, "gif"),
            (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "webp"),
            (bmp, "bmp"),
            (b"BM" + b"\x00" * 12 + struct.pack("<I", 7) + b"\x00" * 16, None),  # ส่วนหัว BMP ผิด
            (b"II*\x00\x08\x00\x00\x00", "tiff"),
            (b"MM\x00*\x00\x00\x00\x08", "tiff"),
            (b"\x00\x00\x01\x00\x01\x00" + b"\x00" * 16, "ico"),
            (b"\x00\x00\x02\x00\x01\x00" + b"\x00" * 16, "ico"),          # .cur
            (b"\x00\x00\x01\x00\x00\x00" + b"\x00" * 16, None),           # ICO ที่ไม่มีภาพ
            (ftyp(b"heic", [b"mif1", b"heic"]), "heif"),
            (ftyp(b"mif1", [b"mif1", b"heic"]), "heif"),
            (ftyp(b"mif1", [b"mif1", b"miaf"]), "heif"),                  # HEIF ทั่วไป
            (ftyp(b"avif", [b"mif1", b"avif"]), "avif"),
            (ftyp(b"mif1", [b"mif1", b"avif"]), "avif"),
            (ftyp(b"isom", [b"mp41"]), None),                             # วิดีโอ MP4
            (b'<?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg PUBLIC "-" "x" [ <!ENTITY a "b"> ]>\n<svg xmlns="x"/>', "svg"),
            (b"\xef\xbb\xbf  <SVG width='1'></SVG>", "svg"),
            (b"<svgx></svgx>", None),
            (b"<html><svg></svg></html>", None),
            (b"<?xml version='1.0'", None),
            (b"not an image", None),
            (b"", None),
        ]
        got = [r["value"] for r in self.calls([{"fn": "detectFormat", "args": [self.raw(d)]} for d, _ in cases])]
        self.assertEqual(got, [f for _, f in cases])

    def test_svg_info_and_size(self):
        info = self.call("svgInfo", '<svg xmlns="x" width="3cm" height=\'2cm\' viewBox="0 0 30 20">')
        self.assertAlmostEqual(info["width"], 3 * 96 / 2.54)
        self.assertAlmostEqual(info["height"], 2 * 96 / 2.54)
        self.assertEqual(info["viewBox"], [0, 0, 30, 20])
        self.assertEqual(self.call("svgInfo", '<svg viewBox="0,0,200,100">'), {"width": None, "height": None, "viewBox": [0, 0, 200, 100]})
        self.assertEqual(self.call("svgInfo", '<svg width="100%" height="50%">'), {"width": None, "height": None, "viewBox": None})
        self.assertEqual(self.call("svgInfo", '<svg width="300" viewBox="0 0 200 100">')["height"], 150)
        self.assertEqual(self.call("svgInfo", '<svg data-width="5" width="12pt" height="1in">')["width"], 16)  # data-width ไม่ใช่ width
        self.assertIsNone(self.call("svgInfo", "<html></html>"))
        # ขนาดที่วาด: เล็กขยายเป็น 1024 ใหญ่ย่อเหลือ 2048 ไม่มีขนาดใช้ 1024×1024
        self.assertEqual(self.call("svgRenderSize", {"width": 200, "height": 100, "viewBox": None}, 1024, 2048), {"width": 1024, "height": 512})
        self.assertEqual(self.call("svgRenderSize", {"width": 10000, "height": 5000, "viewBox": None}, 1024, 2048), {"width": 2048, "height": 1024})
        self.assertEqual(self.call("svgRenderSize", {"width": None, "height": None, "viewBox": [0, 0, 30, 60]}, 1024, 2048), {"width": 512, "height": 1024})
        self.assertEqual(self.call("svgRenderSize", None, 1024, 2048), {"width": 1024, "height": 1024})

    def test_svg_with_size(self):
        out = self.call("svgWithSize", '<?xml version="1.0"?><svg xmlns="x" width="3cm" height="2cm"><g/></svg>', 1024, 683)
        self.assertEqual(out.count("width="), 1)
        self.assertIn('<svg width="1024" height="683" viewBox="0 0 113.386 75.591" preserveAspectRatio="none" xmlns="x"><g/></svg>', out)
        out2 = self.call("svgWithSize", "<svg viewBox='0 0 10 10' width='5'><rect/></svg>", 1024, 1024)
        self.assertEqual(out2, "<svg width=\"1024\" height=\"1024\" viewBox='0 0 10 10'><rect/></svg>")
        # เครื่องหมาย > ในค่า attribute ไม่ทำให้ตัดแท็กผิดที่
        out3 = self.call("svgWithSize", '<svg aria-label="a > b" viewBox="0 0 1 1"/>', 8, 8)
        self.assertEqual(out3, '<svg width="8" height="8" aria-label="a > b" viewBox="0 0 1 1"/>')
        self.assertIsNone(self.call("svgWithSize", "<html/>", 10, 10))

    def test_svg_parsing_is_linear(self):
        # แท็ก <svg> ยาวมากที่จงใจสร้าง ต้องไม่ทำให้ regex ช้าแบบกำลังสอง (ReDoS)
        payloads = ["<svg " + "a" * 19000 + ">", "<svg" + ' a="'.replace('"', "") * 5000 + ">", "<svg" + " a=" * 6000 + ">",
                    "<svg width=\"" + "1" * 19000 + "\">"]
        for reply in self.calls([{"fn": "svgInfo", "args": [p]} for p in payloads]):
            self.assertLess(reply["ms"], 300)

    def test_model_input_and_mask(self):
        specs = self.call("model", "isnet"), self.call("model", "u2netp")
        self.assertEqual([s["size"] for s in specs], [1024, 320])
        self.assertIsNone(self.call("model", "__proto__"))
        self.assertIsNone(self.call("model", "constructor"))
        tiny = {"size": 2, "scale": "255", "mean": [0.5, 0.5, 0.5], "std": [1, 1, 1]}
        rgba = [255, 0, 51, 0, 0, 255, 102, 255, 255, 255, 255, 255, 0, 0, 0, 255]
        got = self.call("buildInput", rgba, tiny)
        expected = [255 / 255 - 0.5, 0 - 0.5, 1 - 0.5, 0 - 0.5,          # R ของ 4 พิกเซล
                    0 - 0.5, 1 - 0.5, 1 - 0.5, 0 - 0.5,                  # G
                    51 / 255 - 0.5, 102 / 255 - 0.5, 1 - 0.5, 0 - 0.5]   # B
        for a, b in zip(got, expected):
            self.assertAlmostEqual(a, b, places=5)
        # แบบ rembg: หารด้วยค่าสีสูงสุดของทั้งภาพ (ไม่นับช่อง alpha)
        mx = {"size": 1, "scale": "max", "mean": [0, 0, 0], "std": [1, 1, 1]}
        self.assertEqual(self.call("buildInput", [100, 50, 25, 255], mx), [1, 0.5, 0.25])
        self.assertEqual(self.call("buildInput", [0, 0, 0, 255], mx), [0, 0, 0])
        self.assertEqual(self.call("maskToBytes", [0.2, 0.6, 1.0]), [0, 128, 255])
        self.assertEqual(self.call("maskToBytes", [0.9, 0.9]), [255, 255])
        self.assertEqual(self.call("maskToBytes", [0.1, 0.1]), [0, 0])

    def test_build_input_rejects_wrong_size(self):
        result = subprocess.run([NODE, HARNESS], input=json.dumps([{"fn": "buildInput", "args": [[1, 2, 3], {"size": 2}]}]).encode(),
                                capture_output=True, timeout=60)
        self.assertFalse(json.loads(result.stdout)[0]["ok"])

    def test_edge_lut(self):
        soft = self.call("edgeLut", 0)
        self.assertEqual(soft, list(range(256)))
        hard = self.call("edgeLut", 100)
        self.assertEqual((hard[0], hard[119], hard[136], hard[255]), (0, 0, 255, 255))
        self.assertEqual(hard, sorted(hard))
        self.assertEqual(self.call("edgeLut", "abc"), soft)

    def test_fit_and_resize(self):
        self.assertEqual(self.call("fitSize", 4000, 3000, 12e6, 8192), {"width": 4000, "height": 3000, "scale": 1})
        fit = self.call("fitSize", 8000, 6000, 12e6, 8192)
        self.assertEqual((fit["width"], fit["height"]), (4000, 3000))
        self.assertEqual(self.call("fitSize", 20000, 100, 16e6, 8192)["width"], 8192)
        # 4×2 → 2×1: เฉลี่ยทีละ 2×2
        src = []
        for v in (0, 100, 200, 40, 20, 60, 0, 0):
            src += [v, v, v, 255]
        self.assertEqual(self.call("resizeRGBA", src, 4, 2, 2, 1), [45, 45, 45, 255, 60, 60, 60, 255])
        self.assertEqual(self.call("resizeRGBA", [1, 2, 3, 4], 1, 1, 1, 1), [1, 2, 3, 4])
        bad = subprocess.run([NODE, HARNESS], input=json.dumps([{"fn": "resizeRGBA", "args": [[0] * 16, 2, 2, 4, 4]}]).encode(),
                             capture_output=True, timeout=60)
        self.assertFalse(json.loads(bad.stdout)[0]["ok"])  # ขยายภาพไม่ได้

    def test_output_name(self):
        cases = [
            (["photo.JPG", "-no-bg.png"], "photo-no-bg.png"),
            (["../../etc/passwd", "-no-bg.png"], "passwd-no-bg.png"),
            (["C:\\Users\\a\\IMG_0001.HEIC", "-no-bg.jpg"], "IMG_0001-no-bg.jpg"),
            (["evil\u202egnp.exe.png", "-no-bg.png"], "evil_gnp.exe-no-bg.png"),
            (['a<b>:c"d|e?f*.png', "-no-bg.png"], "a_b_c_d_e_f_-no-bg.png"),
            ([".hidden.png", "-no-bg.png"], "hidden-no-bg.png"),
            (["", "-no-bg.png"], "image-no-bg.png"),
            ([None, "-no-bg.webp"], "image-no-bg.webp"),
            (["\u0e23\u0e39\u0e1b \u0e1a\u0e49\u0e32\u0e19.webp", "-no-bg.png"], "\u0e23\u0e39\u0e1b \u0e1a\u0e49\u0e32\u0e19-no-bg.png"),
        ]
        got = [r["value"] for r in self.calls([{"fn": "outputName", "args": a} for a, _ in cases])]
        self.assertEqual(got, [n for _, n in cases])
        self.assertEqual(self.call("outputName", "x" * 300 + ".png", ".png"), "x" * 100 + ".png")
        self.assertEqual(self.call("hexColor", "#AABBCC"), "#aabbcc")
        self.assertEqual(self.call("hexColor", "red;x"), "#ffffff")


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
        self.js = {n: read("js", n) for n in sorted(os.listdir(os.path.join(ROOT, "js"))) if n.endswith(".js")}

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
        self.assertEqual(directives["script-src"], ["'self'"])
        self.assertEqual(directives["style-src"], ["'self'"])
        self.assertEqual(directives["connect-src"], ["'self'"])  # รูปไม่ถูกส่งออกนอกเว็บ
        self.assertEqual(directives["worker-src"], ["'self'"])
        self.assertEqual(directives["base-uri"], ["'none'"])
        self.assertNotIn("unsafe", policies[0])
        self.assertNotRegex(policies[0], r"https?:|\*")

    def test_no_inline_code(self):
        self.assertNotIn("<style", self.page)
        for tag, attrs in self.tags:
            if tag == "script":
                self.assertIn("src", attrs)
            self.assertNotIn("style", attrs)
            self.assertEqual([k for k in attrs if k.startswith("on")], [])

    def test_local_files_exist(self):
        for tag, attrs in self.tags:
            for key in ("href", "src"):
                url = attrs.get(key)
                if not url or url.startswith("#"):
                    continue
                with self.subTest(url=url):
                    self.assertIsNone(re.match(r"[a-z][a-z0-9+.-]*:|//", url, re.I), "ห้ามโหลดไฟล์จากเว็บอื่น")
                    self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, url))), url)
        # worker และไฟล์ที่ worker โหลด (path เทียบกับโฟลเดอร์ js/)
        app = self.js["app.js"]
        for worker in re.findall(r"makeWorker\('([^']+)'\)", app):
            self.assertTrue(os.path.isfile(os.path.join(ROOT, worker)), worker)
        for name in ("ai-worker.js", "decode-worker.js"):
            for group in re.findall(r"importScripts\(([^)]*)\)", self.js[name]):
                for p in re.findall(r"'([^']+)'", group):
                    with self.subTest(worker=name, script=p):
                        self.assertTrue(os.path.isfile(os.path.normpath(os.path.join(ROOT, "js", p))), p)

    def test_models_exist_with_expected_size(self):
        core = self.js["core.js"]
        models = re.findall(r"file: '([^']+)',\s*bytes: (\d+),", core)
        self.assertEqual(len(models), 2)
        for path, size in models:
            with self.subTest(model=path):
                full = os.path.join(ROOT, path)
                self.assertTrue(os.path.isfile(full), path)
                self.assertEqual(os.path.getsize(full), int(size))
                self.assertLess(os.path.getsize(full), 50 * 1024 * 1024)  # GitHub เตือนไฟล์เกิน 50 MB

    def test_back_link_and_file_picker(self):
        self.assertIn("../index.html", [a.get("href") for t, a in self.tags if t == "a"])
        pickers = [a for t, a in self.tags if t == "input" and a.get("type") == "file"]
        # Firefox บน Android ล่มเมื่อ accept มีนามสกุล — ในหน้าใช้แค่ image/* และ js เพิ่มนามสกุลเฉพาะที่ไม่ใช่ Android
        self.assertEqual([a.get("accept") for a in pickers], ["image/*"])
        self.assertIn("if (!ANDROID) $('file-input').setAttribute('accept', ACCEPT_DESKTOP);", self.js["app.js"])
        for ext in ("jpg", "jpeg", "jfif", "png", "bmp", "webp", "heic", "heif", "svg", "ico", "gif", "tif", "tiff"):
            self.assertIn("." + ext + ",", self.js["app.js"].replace("tiff'", "tiff,'"))

    def test_scripts_are_safe(self):
        for name, code in self.js.items():
            with self.subTest(file=name):
                self.assertIsNone(re.search(r"\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|\beval\(|new Function", code))
        # ดาวน์โหลดได้เฉพาะไฟล์โมเดลจากเว็บเดียวกัน (ใน worker)
        fetches = {n: re.findall(r"\bfetch\(([^)]*)\)", c) for n, c in self.js.items()}
        self.assertEqual({n: f for n, f in fetches.items() if f}, {"ai-worker.js": ["url"]})
        self.assertIn("download(BASE + spec.file", self.js["ai-worker.js"])
        app = self.js["app.js"]
        self.assertIn("var MODEL_KEY = 'bg-remove:model';", app)  # key ขึ้นต้นด้วยชื่อโฟลเดอร์
        self.assertEqual(re.findall(r"localStorage\.(\w+)\((\w+)", app), [("getItem", "MODEL_KEY"), ("setItem", "MODEL_KEY")])
        self.assertIn("S.model = C.model(saved) ? saved", app)  # ตรวจค่าที่อ่านกลับมา (C.model ใช้ hasOwnProperty)

    def test_decode_worker_not_killed_mid_job(self):
        # ตัวจับเวลาปิด worker ถอดรหัสต้องเริ่มนับหลังงานเสร็จ ไม่ใช่ตอนเริ่ม (HEIC ใหญ่บนมือถือช้าใช้เวลาเกิน 30 วินาที)
        app = self.js["app.js"]
        decoder = app[app.index("function decoder()"):app.index("function decoderDone()")]
        self.assertNotIn("setTimeout", decoder)
        via = app[app.index("async function viaWorker"):app.index("async function decodeFile")]
        self.assertRegex(via, r"finally \{\s*decoderDone\(\);")


if __name__ == "__main__":
    unittest.main()
