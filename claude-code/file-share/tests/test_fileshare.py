"""เทสต์ระบบฝากไฟล์ (file-share/)

- ฟังก์ชันล้วนใน js/core.js (รันใน Node ผ่าน tests/harness.js ถ้าไม่มี Node.js จะข้าม):
  ขีดจำกัดขนาดไฟล์, ชื่อไฟล์ที่ปลอดภัย, URL เข้าสู่ระบบ Google/Microsoft, PKCE (RFC 7636), การอ่านผลเข้าสู่ระบบ,
  การตรวจลิงก์จาก API และผลของเว็บฝากไฟล์ฟรี
- ไฟล์หน้าเว็บ: CSP, ไม่มีสคริปต์ในหน้า, ไม่มีไลบรารีภายนอก, โทเคนไม่ถูกบันทึกลง storage, config.js ไม่มีความลับ

    python3 -m unittest discover -s tests -v
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")
HARNESS = os.path.join(ROOT, "tests", "harness.js")
MiB = 1024 * 1024
GID = "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com"
MID = "11111111-2222-3333-4444-555555555555"


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as fh:
        return fh.read()


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

    def many(self, fn, argsets):
        return [r["value"] for r in self.calls([{"fn": fn, "args": a} for a in argsets])]

    def test_size_limits(self):
        cases = [
            ([{"size": 100 * MiB}, "google"], None),
            ([{"size": 100 * MiB + 1}, "google"], "ไฟล์ใหญ่เกิน 100 MB (ขนาด 100 MB)"),
            ([{"size": 100 * MiB + 1}, "onedrive"], "ไฟล์ใหญ่เกิน 100 MB (ขนาด 100 MB)"),
            ([{"size": 100 * 1000 * 1000}, "tmpfiles"], None),
            ([{"size": 100 * 1000 * 1000 + 1}, "tmpfiles"], "ไฟล์ใหญ่เกิน 95.4 MB (ขนาด 95.4 MB)"),
            ([{"size": 100 * MiB}, "gofile"], None),
            ([{"size": 0}, "google"], "ไฟล์ว่างเปล่า"),
            ([{"size": "abc"}, "google"], "ไฟล์ว่างเปล่า"),
            ([{"size": 10}, "__proto__"], "ไม่รู้จักที่ฝากไฟล์"),
            ([{"size": 10}, "dropbox"], "ไม่รู้จักที่ฝากไฟล์"),
        ]
        self.assertEqual(self.many("checkFile", [a for a, _ in cases]), [e for _, e in cases])
        self.assertEqual(self.many("formatBytes", [[0], [1536], [100 * MiB], [5 * 1024 * MiB], [15 * 1024 * MiB + 1]]),
                         ["0 B", "1.5 KB", "100 MB", "5 GB", "15 GB"])

    def test_file_names(self):
        rlo = "\u202e"
        self.assertEqual(self.many("displayName", [["C:\\x\\evil" + rlo + "gnp.exe"], ["a\u200bb.pdf"], [""], [None]]),
                         ["evilgnp.exe", "ab.pdf", "file", "file"])
        self.assertEqual(self.many("driveName", [["../../etc/passwd"], ["  \u0e23\u0e32\u0e22\u0e07\u0e32\u0e19.pdf  "], [""]]),
                         ["passwd", "\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19.pdf", "file"])
        self.assertEqual(self.many("oneDriveName", [
            ['big:"file"?.bin'], ["a<b>|c*.txt"], [" CON.txt "], ["com1"], ["desktop.ini"], [".lock"],
            ["x_vti_y.doc"], ["name. . "], ["..."], ["a/b\\c.txt"],
        ]), ["big__file__.bin", "a_b__c_.txt", "_CON.txt", "_com1", "_desktop.ini", "lock", "_x_vti_y.doc", "name", "file", "c.txt"])
        self.assertEqual(self.many("hostName", [["my file (1).pdf"], ["a&b=c#d.zip"], ["<script>.js"]]),
                         ["my file (1).pdf", "a_b_c_d.zip", "_script_.js"])
        long = self.call("oneDriveName", "x" * 400 + ".docx")
        self.assertEqual(len(long), 200)
        self.assertTrue(long.endswith(".docx"))

    def test_google_auth_url(self):
        url = self.call("googleAuthUrl", {"clientId": GID, "redirectUri": "https://envburiramclub.github.io/claude-code/file-share/index.html", "state": "S1&x=y"})
        parts = urlsplit(url)
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ("https", "accounts.google.com", "/o/oauth2/v2/auth"))
        q = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.assertEqual(q["client_id"], GID)
        self.assertEqual(q["response_type"], "token")
        self.assertEqual(q["scope"], "https://www.googleapis.com/auth/drive.file")  # สิทธิ์น้อยที่สุด: เฉพาะไฟล์ที่แอปสร้าง
        self.assertEqual(q["state"], "S1&x=y")  # encode แล้ว ไม่แทรกพารามิเตอร์อื่นได้
        self.assertNotIn("x", q)
        self.assertEqual(q["redirect_uri"], "https://envburiramclub.github.io/claude-code/file-share/index.html")

    def test_microsoft_auth_url(self):
        url = self.call("microsoftAuthUrl", {"clientId": MID, "authority": "evil.example/x", "redirectUri": "https://x/i.html", "state": "S", "challenge": "C"})
        parts = urlsplit(url)
        self.assertEqual(parts.netloc, "login.microsoftonline.com")
        self.assertEqual(parts.path, "/common/oauth2/v2.0/authorize")  # authority แปลก ๆ → common
        q = {k: v[0] for k, v in parse_qs(parts.query).items()}
        self.assertEqual((q["response_type"], q["response_mode"], q["code_challenge"], q["code_challenge_method"]), ("code", "fragment", "C", "S256"))
        self.assertEqual(q["scope"], "Files.ReadWrite User.Read")
        self.assertEqual(self.many("authority", [["consumers"], ["ORGANIZATIONS"], [MID.upper()], ["../x"], [None]]),
                         ["consumers", "organizations", MID, "common", "common"])
        self.assertEqual(self.call("microsoftTokenUrl", "consumers"), "https://login.microsoftonline.com/consumers/oauth2/v2.0/token")

    def test_microsoft_account_note(self):
        notes = self.many("msAccountsNote", [["consumers"], ["common"], ["organizations"], [MID], ["../x"]])
        self.assertIn("\u0e40\u0e09\u0e1e\u0e32\u0e30\u0e1a\u0e31\u0e0d\u0e0a\u0e35 Microsoft \u0e2a\u0e48\u0e27\u0e19\u0e15\u0e31\u0e27", notes[0])  # เฉพาะบัญชี Microsoft ส่วนตัว
        self.assertIn("\u0e43\u0e0a\u0e49\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49", notes[0])  # องค์กรใช้ไม่ได้
        self.assertIn("\u0e17\u0e31\u0e49\u0e07", notes[1])  # ใช้ได้ทั้งสองแบบ
        self.assertEqual(notes[2], notes[3])  # tenant ID = บัญชีองค์กรเท่านั้น
        self.assertEqual(notes[4], notes[1])  # ค่าแปลก ๆ → common

    def test_auth_error_text(self):
        # ข้อความจริงจาก Microsoft เมื่อ redirect URI อยู่ใต้แพลตฟอร์ม Web แทน SPA
        real = ("AADSTS70002: The provided request must include a 'client_secret' input parameter. "
                "Trace ID: bc8d0ad3-3b6b-4898-b823-dec8bb500000 Correlation ID: 2173706d Timestamp: 2026-09-30")
        msg = self.call("authErrorText", "invalid_client", real)
        self.assertIn("Single-page application", msg)
        self.assertTrue(msg.endswith("(AADSTS70002)"), msg)
        self.assertNotIn("Trace ID", msg)
        for code in ("AADSTS7000218", "AADSTS9002326", "AADSTS9002331", "AADSTS50011", "AADSTS65001"):
            with self.subTest(code=code):
                self.assertTrue(self.call("authErrorText", "x", code + ": text").endswith("(" + code + ")"))
        # รหัสที่ไม่รู้จัก: แสดงข้อความเดิม (ตัด Trace ID, ขึ้นบรรทัด, จำกัดความยาว) และชื่อ error ที่ทำความสะอาดแล้ว
        self.assertEqual(self.call("authErrorText", "server_error<b>", "AADSTS1234: a\nb Trace ID: 1"),
                         "\u0e40\u0e02\u0e49\u0e32\u0e2a\u0e39\u0e48\u0e23\u0e30\u0e1a\u0e1a\u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08 (server_errorb): AADSTS1234: a b")
        self.assertLess(len(self.call("authErrorText", "e" * 500, "d" * 5000)), 300)
        self.assertIn("authErrorText(err, params.error_description)", read("js", "app.js"))

    def test_client_ids(self):
        self.assertEqual(self.many("validClientId", [["google", GID], ["google", " " + GID + " "], ["google", "abc"], ["google", GID + "/x"],
                                                     ["microsoft", MID], ["microsoft", "not-a-guid"], ["dropbox", MID]]),
                         [GID, GID, "", "", MID, "", ""])

    def test_pkce_and_random(self):
        verifier = "dBjftJeZ4CVP-mJ92ZtT7-Mb4n4RRSzwDs7aXPh5bTxz"
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        self.assertEqual(self.call("pkceChallenge", verifier, {"$global": "subtle"}), expected)
        tokens = self.many("randomToken", [[{"$global": "crypto"}, 32]] * 3 + [[{"$global": "crypto"}, 48]])
        self.assertEqual([len(t) for t in tokens], [43, 43, 43, 64])
        self.assertEqual(len(set(tokens)), 4)
        for t in tokens:
            self.assertRegex(t, r"^[A-Za-z0-9_-]+$")

    def test_parse_params(self):
        p = self.call("parseParams", "#access_token=ya29.a%2Bb&token_type=Bearer&expires_in=3599&state=a+b&state=second")
        self.assertEqual(p, {"access_token": "ya29.a+b", "token_type": "Bearer", "expires_in": "3599", "state": "a b"})
        self.assertEqual(self.call("parseParams", "?code=%E0%A4&x=1"), {"x": "1"})  # % ผิดรูปแบบ → ข้าม
        self.assertEqual(self.call("parseParams", "__proto__=1&constructor=2"), {"__proto__": "1", "constructor": "2"})
        self.assertEqual(len(self.call("parseParams", "&".join("k%d=v" % i for i in range(200)))), 50)
        self.assertEqual(self.call("parseParams", "a=" + "x" * 9000), {})
        reply = self.calls([{"fn": "parseParams", "args": ["=" * 200000 + "&" * 200000]}])[0]
        self.assertLess(reply["ms"], 500)

    def test_safe_link(self):
        allowed = ["drive.google.com", "*.sharepoint.com"]
        cases = [
            ("https://drive.google.com/file/d/x/view", "https://drive.google.com/file/d/x/view"),
            ("HTTPS://DRIVE.GOOGLE.COM/a", "https://drive.google.com/a"),
            ("https://contoso.sharepoint.com/x", "https://contoso.sharepoint.com/x"),
            ("https://sharepoint.com/x", None),
            ("https://evil.sharepoint.com.attacker.net/x", None),
            ("https://drive.google.com.evil.net/x", None),
            ("http://drive.google.com/x", None),
            ("javascript:alert(1)", None),
            ("https://user:pw@drive.google.com/x", None),
            ("//drive.google.com/x", None),
            (None, None),
        ]
        self.assertEqual(self.many("safeLink", [[u, allowed] for u, _ in cases]), [e for _, e in cases])

    def test_free_host_responses(self):
        self.assertEqual(self.call("tmpfilesLinks", {"status": "success", "data": {"url": "http://tmpfiles.org/123/a b.png"}}),
                         {"page": "https://tmpfiles.org/123/a%20b.png", "direct": "https://tmpfiles.org/dl/123/a%20b.png"})
        # รหัสแบบใหม่เป็นตัวอักษรผสม (พบจากการใช้งานจริง 30 ก.ย. 2569) ต้องได้ลิงก์ดาวน์โหลดตรงด้วย
        self.assertEqual(self.call("tmpfilesLinks", {"status": "success", "data": {"url": "http://tmpfiles.org/wsARwlEoEnhy/screenshot.png"}}),
                         {"page": "https://tmpfiles.org/wsARwlEoEnhy/screenshot.png", "direct": "https://tmpfiles.org/dl/wsARwlEoEnhy/screenshot.png"})
        # รูปแบบที่ไม่รู้จัก หรือเป็นลิงก์ /dl/ อยู่แล้ว → ไม่เดา ใช้ลิงก์เดิม
        for odd in ("https://tmpfiles.org/dl/abc/a.png", "https://tmpfiles.org/abc", "https://tmpfiles.org/a/b/c.png"):
            with self.subTest(url=odd):
                self.assertEqual(self.call("tmpfilesLinks", {"status": "success", "data": {"url": odd}}), {"page": odd, "direct": odd})
        for bad in ({"status": "error"}, {"status": "success", "data": {"url": "https://evil.net/1/a"}},
                    {"status": "success", "data": {"url": "javascript:alert(1)"}}, None, "x"):
            self.assertIsNone(self.call("tmpfilesLinks", bad), bad)
        self.assertEqual(self.call("gofileLink", {"status": "ok", "data": {"downloadPage": "https://gofile.io/d/AbCd"}}), "https://gofile.io/d/AbCd")
        for bad in ({"status": "ok", "data": {"downloadPage": "javascript:alert(1)"}}, {"status": "error-notFound"},
                    {"status": "ok", "data": {"downloadPage": "https://gofile.io.evil.net/d/x"}}):
            self.assertIsNone(self.call("gofileLink", bad), bad)

    def test_onedrive_chunks(self):
        chunk = 32 * 320 * 1024
        self.assertEqual(chunk % (320 * 1024), 0)
        total = 25 * MiB + 123
        self.assertEqual(self.call("chunkRanges", total, chunk), [[0, chunk - 1], [chunk, 2 * chunk - 1], [2 * chunk, total - 1]])
        self.assertEqual(self.call("chunkRanges", 0, chunk), [])
        self.assertEqual(self.many("nextRange", [[{"nextExpectedRanges": ["26214400-"]}], [{"nextExpectedRanges": ["5-9", "20-"]}],
                                                 [{"nextExpectedRanges": ["x-"]}], [{"nextExpectedRanges": ["1" * 20 + "-"]}], [None], [{}]]),
                         [26214400, 5, -1, -1, -1, -1])


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

    def csp(self):
        policies = [a.get("content") or "" for t, a in self.tags if t == "meta" and (a.get("http-equiv") or "").lower() == "content-security-policy"]
        self.assertEqual(len(policies), 1)
        directives = {}
        for part in policies[0].split(";"):
            words = part.split()
            if words:
                directives[words[0]] = words[1:]
        return policies[0], directives

    def test_content_security_policy(self):
        policy, d = self.csp()
        self.assertEqual(d["default-src"], ["'none'"])
        self.assertEqual(d["script-src"], ["'self'"])  # ไม่มีไลบรารีจาก CDN หรือเว็บอื่นเลย
        self.assertEqual(d["style-src"], ["'self'"])
        self.assertEqual(d["base-uri"], ["'none'"])
        self.assertEqual(d["form-action"], ["'none'"])
        self.assertNotIn("unsafe", policy)
        # ส่งข้อมูลออกได้เฉพาะ API ของที่ฝากไฟล์
        self.assertEqual(sorted(d["connect-src"]), sorted([
            "'self'", "https://www.googleapis.com", "https://oauth2.googleapis.com", "https://login.microsoftonline.com",
            "https://graph.microsoft.com", "https://api.onedrive.com", "https://*.onedrive.com", "https://*.sharepoint.com",
            "https://*.microsoftpersonalcontent.com", "https://tmpfiles.org", "https://upload.gofile.io"]))

    def test_upload_hosts_are_allowed_by_csp(self):
        _, d = self.csp()
        allowed = set(d["connect-src"])
        # ตัดคอมเมนต์ออกก่อน แล้วดู URL ทุกตัวในโค้ด
        code = "\n".join(l for c in self.js.values() for l in c.split("\n") if not l.strip().startswith(("//", "*", "/*")))
        for url in sorted(set(re.findall(r"'(https://[a-z0-9.-]+)[/']", code))):
            if url in ("https://accounts.google.com", "https://drive.google.com", "https://github.com"):
                continue  # หน้าเข้าสู่ระบบ (เปลี่ยนหน้า) และลิงก์ที่ผู้ใช้กด ไม่ใช่การส่งข้อมูลด้วยสคริปต์
            with self.subTest(url=url):
                self.assertIn(url, allowed)

    def test_no_inline_code_and_files_exist(self):
        self.assertNotIn("<style", self.page)
        for tag, attrs in self.tags:
            if tag == "script":
                self.assertIn("src", attrs)
                self.assertTrue(os.path.isfile(os.path.join(ROOT, attrs["src"])), attrs["src"])
            self.assertNotIn("style", attrs)
            self.assertEqual([k for k in attrs if k.startswith("on")], [])
            href = attrs.get("href")
            if tag == "link" and href:
                self.assertTrue(os.path.isfile(os.path.join(ROOT, href)), href)
        self.assertIn("../index.html", [a.get("href") for t, a in self.tags if t == "a"])

    def test_privacy_page(self):
        # Google ต้องมีลิงก์นโยบายความเป็นส่วนตัว (หน้า Branding) ก่อน Publish app และหน้าแรกของแอปต้องลิงก์ไปหน้านี้
        self.assertIn('href="privacy.html"', self.page)
        page = read("privacy.html")
        parser = _Tags()
        parser.feed(page)
        tags = parser.tags
        csp = [a.get("content") for t, a in tags if t == "meta" and (a.get("http-equiv") or "").lower() == "content-security-policy"]
        self.assertEqual(csp, ["default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"])
        self.assertNotIn("<script", page)
        self.assertNotIn("<style", page)
        for tag, attrs in tags:
            self.assertNotIn("style", attrs)
            self.assertEqual([k for k in attrs if k.startswith("on")], [])
            if tag == "a" and attrs.get("target") == "_blank":
                self.assertEqual(attrs.get("rel"), "noopener noreferrer")
            if tag == "link":
                self.assertTrue(os.path.isfile(os.path.join(ROOT, attrs["href"])), attrs["href"])
        self.assertIn("index.html", [a.get("href") for t, a in tags if t == "a"])
        # เนื้อหาต้องตรงกับที่ระบบทำจริง: สิทธิ์ที่ขอ key ที่เก็บในเครื่อง และข้อความ Limited Use ของ Google
        for text in ("drive.file", "Files.ReadWrite", "User.Read", "file-share:provider", "file-share:auth",
                     "Google API Services User Data Policy", "Limited Use"):
            self.assertIn(text, page)
        self.assertIn("var GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';", read("js", "core.js"))

    def test_file_picker_has_no_accept(self):
        pickers = [a for t, a in self.tags if t == "input" and a.get("type") == "file"]
        self.assertEqual(len(pickers), 1)
        self.assertNotIn("accept", pickers[0])  # Firefox บน Android ล่มเมื่อ accept มีนามสกุล/ชนิดที่ไม่ใช่รูป

    def test_scripts_are_safe(self):
        for name, code in self.js.items():
            with self.subTest(file=name):
                self.assertIsNone(re.search(r"\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|\beval\(|new Function", code))
        app = self.js["app.js"]
        # โทเคนอยู่ในหน่วยความจำเท่านั้น — storage เก็บได้แค่ที่ฝากที่เลือก (localStorage) และ state/PKCE ชั่วคราว (sessionStorage)
        self.assertIn("var AUTH_KEY = 'file-share:auth';", app)
        self.assertIn("var PROVIDER_KEY = 'file-share:provider';", app)
        self.assertEqual(sorted(re.findall(r"(localStorage|sessionStorage)\.setItem\((\w+)", app)),
                         [("localStorage", "PROVIDER_KEY"), ("localStorage", "PROVIDER_KEY"), ("sessionStorage", "AUTH_KEY")])
        self.assertIn("JSON.stringify({ provider: kind, state: state, verifier: verifier, time: Date.now() })", app)
        self.assertNotRegex(app, r"indexedDB|document\.cookie")
        self.assertIn("sessionStorage.removeItem(AUTH_KEY)", app)          # ลบทันทีเมื่อกลับมา
        self.assertIn("history.replaceState(null, '', location.pathname + location.search)", app)  # ลบโทเคนออกจาก URL
        self.assertIn("pending.state !== params.state", app)               # ตรวจ state ทุกครั้ง
        self.assertNotIn("client_secret", app)
        # ลิงก์ที่ได้จาก API ต้องผ่าน safeLink ก่อนแสดง
        providers = self.js["providers.js"]
        self.assertGreaterEqual(providers.count("C.safeLink("), 6)
        # uploadUrl ของ OneDrive ห้ามส่ง Authorization header
        od = providers[providers.index("var onedrive = {"):providers.index("account: async function (session) {\n      var me")]
        put = od[od.index("url: uploadUrl"):od.index("onProgress: (function")]
        self.assertNotIn("Authorization", put)

    def test_config_has_no_secrets(self):
        cfg = self.js["config.js"]
        ids = dict(re.findall(r"(googleClientId|microsoftClientId|microsoftAuthority): '([^']*)'", cfg))
        self.assertEqual(sorted(ids), ["googleClientId", "microsoftAuthority", "microsoftClientId"])
        self.assertRegex(ids["googleClientId"], r"^$|^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$")
        self.assertRegex(ids["microsoftClientId"], r"^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        self.assertNotRegex(cfg, r"(?i)secret\s*[:=]|GOCSPX-|client_secret")
        # authority ต้องเป็นค่าที่ Microsoft รู้จัก และตรงกับการลงทะเบียนแอป (แอปนี้เป็น Personal Microsoft accounts only)
        self.assertRegex(ids["microsoftAuthority"], r"^(common|consumers|organizations|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
        if ids["microsoftClientId"] == "8eeb9af7-8531-429d-83e9-ef647592850a":
            self.assertEqual(ids["microsoftAuthority"], "consumers")  # common → AADSTS9002331 ตอนแลกรหัสเข้าสู่ระบบ

    def test_session_safety(self):
        app = self.js["app.js"]
        # ออกจากระบบแล้วต้องยกเลิกไฟล์ที่ค้างในคิว ไม่ให้อัปโหลดเข้าบัญชีที่เข้าสู่ระบบทีหลัง
        logout = app[app.index("function logout()"):app.index("function handleAuthError")]
        self.assertIn("cancelEntry(x)", logout)
        # 401 จาก session เก่าต้องไม่ทำให้ session ใหม่หลุด
        self.assertIn("if (s && S.sessions[kind] !== s) return true;", app)
        self.assertIn("S.sessions[entry.target] !== entry.session", app)
        self.assertIn('id="ms-accounts"', self.page)
        # พื้นที่ว่างไม่ติดลบ และลากโฟลเดอร์มาวางต้องข้าม (ไม่ส่งโฟลเดอร์ไปอัปโหลด)
        self.assertIn("Math.max(0, s.account.total - s.account.used)", app)
        self.assertIn("if (entry && entry.isDirectory) { folders++; continue; }", app)
        self.assertIn("addFiles(droppedFiles(e.dataTransfer));", app)
        # คำแนะนำเมื่อหน้า login.live.com ขึ้น contextID/cookie error (แสดงเฉพาะเมื่อเลือก OneDrive)
        self.assertIn('id="ms-login-hint" hidden', self.page)
        self.assertIn("$('ms-login-hint').hidden = choice !== 'onedrive';", app)
        providers = self.js["providers.js"]
        # เปิดลิงก์แชร์ไม่ได้ (บัญชีองค์กรห้ามแชร์) ต้องไม่ทำให้การอัปโหลดที่สำเร็จแล้วกลายเป็นล้มเหลว
        google = providers[providers.index("var google = {"):providers.index("account: async function (session) {\n      var a")]
        self.assertIn("warning = 'อัปโหลดสำเร็จ แต่เปิดลิงก์แชร์ไม่ได้", google)
        self.assertIn("if (e.status === 404) return { value: [] };", providers)


if __name__ == "__main__":
    unittest.main()
