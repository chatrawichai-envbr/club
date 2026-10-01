import contextlib
import http.client
import io
import json
import os
import socket
import sys
import threading
import time
import unittest
from unittest import mock
from wsgiref.util import setup_testing_defaults

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import csv2vcf  # noqa: E402
import webapp  # noqa: E402

with open(os.path.join(ROOT, "example.csv"), "rb") as _fh:
    EXAMPLE = _fh.read()


def call(app, method="GET", path="/", body=b"", query="", headers=None, content_length=True):
    """เรียกแอป WSGI โดยตรง คืน (status, headers, body)"""
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "wsgi.input": io.BytesIO(body),
    }
    if content_length:
        environ["CONTENT_LENGTH"] = str(len(body))
    for name, value in (headers or {}).items():
        environ["HTTP_" + name.upper().replace("-", "_")] = value
    setup_testing_defaults(environ)
    captured = {}

    def start_response(status, response_headers, exc_info=None):
        captured["status"] = int(status.split()[0])
        captured["headers"] = dict(response_headers)

    chunks = app(environ, start_response)
    return captured["status"], captured["headers"], b"".join(chunks)


def convert(app, body=EXAMPLE, query="", headers=None):
    headers = {"X-Requested-With": "csv2vcf"} if headers is None else headers
    status, response_headers, raw = call(app, "POST", "/api/convert", body, query, headers)
    return status, response_headers, json.loads(raw.decode("utf-8"))


class StaticPagesTest(unittest.TestCase):
    def setUp(self):
        self.app = webapp.App(max_bytes=1024 * 1024)

    def test_index(self):
        status, headers, body = call(self.app)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        page = body.decode("utf-8")
        self.assertIn("แปลงรายชื่อ CSV เป็น vCard", page)
        self.assertIn('data-max-mb="1"', page)
        self.assertNotIn("__MAX_MB__", page)

    def test_security_headers_everywhere(self):
        for method, path in (("GET", "/"), ("GET", "/app.js"), ("GET", "/nope"), ("POST", "/api/convert")):
            _, headers, _ = call(self.app, method, path)
            csp = headers["Content-Security-Policy"]
            self.assertIn("default-src 'none'", csp)
            self.assertIn("frame-ancestors 'none'", csp)
            self.assertNotIn("unsafe-inline", csp)
            self.assertNotIn("unsafe-eval", csp)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(headers["X-Frame-Options"], "DENY")
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")

    def test_static_files(self):
        expected = {
            "/app.js": "text/javascript; charset=utf-8",
            "/style.css": "text/css; charset=utf-8",
            "/example.csv": "text/csv; charset=utf-8",
        }
        for path, content_type in expected.items():
            status, headers, body = call(self.app, "GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(headers["Content-Type"], content_type)
            self.assertEqual(int(headers["Content-Length"]), len(body))
        self.assertIn("attachment", call(self.app, "GET", "/example.csv")[1]["Content-Disposition"])

    def test_head(self):
        status, headers, body = call(self.app, "HEAD", "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)

    def test_unknown_and_traversal_paths(self):
        for path in (
            "/nope", "/../csv2vcf.py", "/csv2vcf.py", "/webapp.py", "/web/index.html", "/index.html",
            "/app.js/", "//app.js", "/app.js/../webapp.py", "/csv2vcf/example.csv", "/.git/config",
        ):
            status, headers, body = call(self.app, "GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"import", body)

    def test_wrong_methods(self):
        status, headers, _ = call(self.app, "POST", "/")
        self.assertEqual((status, headers["Allow"]), (405, "GET, HEAD"))
        status, headers, _ = call(self.app, "GET", "/api/convert")
        self.assertEqual((status, headers["Allow"]), (405, "POST"))

    def test_healthz(self):
        self.assertEqual(call(self.app, "GET", "/healthz")[2], b"ok")


class ConvertApiTest(unittest.TestCase):
    def setUp(self):
        self.app = webapp.App(max_bytes=1024 * 1024, workers=2)

    def test_success(self):
        status, headers, data = convert(self.app)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertEqual(headers["Cache-Control"], "no-store")  # ผลลัพธ์เป็นข้อมูลส่วนบุคคล
        self.assertTrue(data["ok"])
        self.assertEqual((data["contacts"], data["skipped"], data["encoding"]), (3, 0, "utf-8"))
        self.assertTrue(data["vcf"].startswith("BEGIN:VCARD\r\nVERSION:3.0\r\n"))
        self.assertEqual(data["vcf"].count("BEGIN:VCARD"), 3)

    def test_options(self):
        _, _, data = convert(self.app, query="country_code=66&date_order=dmy")
        self.assertIn("TEL;TYPE=CELL:+66 81-234-5678", data["vcf"])
        _, _, data = convert(self.app, query="country_code=%E0%B9%96%E0%B9%96")  # ๖๖
        self.assertIn("+66 81-234-5678", data["vcf"])
        _, _, data = convert(self.app, b"Name,Birthday\nA,05/12/1990\n", "date_order=mdy")
        self.assertIn("BDAY:1990-05-12", data["vcf"])
        _, _, data = convert(self.app, "ชื่อ,เบอร์โทร\nสมชาย,0811111111\n".encode("cp874"), "encoding=cp874")
        self.assertIn("FN:สมชาย", data["vcf"])
        _, _, data = convert(self.app, b"Name;Phone\nA;0811111111\n", "delimiter=semicolon")
        self.assertIn("TEL:0811111111", data["vcf"])

    def test_invalid_options(self):
        for query in (
            "country_code=abc", "country_code=0", "date_order=ymd", "encoding=punycode",
            "encoding=rot13", "delimiter=x", "delimiter=%2C%2C",
            "&".join("a%d=1" % i for i in range(20)),
        ):
            status, _, data = convert(self.app, query=query)
            self.assertEqual(status, 400, query)
            self.assertFalse(data["ok"])
            self.assertTrue(data["error"])

    def test_requires_csrf_header(self):
        for headers in ({}, {"X-Requested-With": "XMLHttpRequest"}):
            status, _, data = convert(self.app, headers=headers)
            self.assertEqual(status, 403)
            self.assertFalse(data["ok"])

    def test_body_size_checks(self):
        headers = {"X-Requested-With": "csv2vcf"}
        status, _, _ = call(self.app, "POST", "/api/convert", EXAMPLE, "", headers, content_length=False)
        self.assertEqual(status, 411)
        for length in ("", "abc", "-5", "0"):
            environ_headers = dict(headers)
            status, _, _ = self._raw(length, environ_headers)
            self.assertIn(status, (400, 411), length)
        status, _, _ = self._raw(str(1024 * 1024 + 1), headers)
        self.assertEqual(status, 413)
        status, _, _ = self._raw("99999999999999999999999", headers)
        self.assertEqual(status, 413)

    def _raw(self, content_length, headers, body=b""):
        environ = {
            "REQUEST_METHOD": "POST", "PATH_INFO": "/api/convert", "QUERY_STRING": "",
            "CONTENT_LENGTH": content_length, "wsgi.input": io.BytesIO(body),
        }
        for name, value in headers.items():
            environ["HTTP_" + name.upper().replace("-", "_")] = value
        setup_testing_defaults(environ)
        result = {}

        def start_response(status, response_headers, exc_info=None):
            result["status"] = int(status.split()[0])

        body = b"".join(self.app(environ, start_response))
        return result["status"], None, body

    def test_content_length_must_be_plain_digits(self):
        # int() ของ Python รับค่าเหล่านี้ได้ แต่ proxy ถือว่าผิดรูปแบบ (ต้นทางของ request smuggling)
        headers = {"X-Requested-With": "csv2vcf"}
        for value in ("2_4", "+24", "24.0", "0x18", "\u0e52\u0e54", "\u0968\u096a", "1e3", "9" * 101):
            status, _, body = self._raw(value, headers, b"Name,Phone\nA,0811111111\n")
            self.assertEqual(status, 411, value)
            self.assertFalse(json.loads(body)["ok"])
        status, _, _ = self._raw(" 24 ", headers, b"Name,Phone\nA,0811111111\n")
        self.assertEqual(status, 200)

    def test_truncated_body(self):
        status, _, body = self._raw("500", {"X-Requested-With": "csv2vcf"}, b"Name,Phone\n")
        self.assertEqual(status, 400)
        self.assertIn("ไม่ครบ", json.loads(body)["error"])

    def test_conversion_errors(self):
        for body in (b"foo,bar\n1,2\n", b"PK\x03\x04" + b"\x00" * 20, b'Name,Phone\n"Bob,1\n', b"Name,Phone\n,\n"):
            status, _, data = convert(self.app, body)
            self.assertEqual(status, 422, body[:20])
            self.assertFalse(data["ok"])
            self.assertTrue(data["error"])

    def test_warnings_are_capped_and_columns_sanitised(self):
        body = ("Name,Email,\x1b[31mCol\u202e\n" + "A,bad,x\n" * 150).encode("utf-8")
        _, _, data = convert(self.app, body)
        self.assertEqual(len(data["warnings"]), webapp.MAX_WARNINGS)
        self.assertEqual(data["warnings_total"], 150)
        self.assertEqual(data["warnings"][0]["line"], 2)
        self.assertEqual(data["ignored_columns_total"], 1)
        self.assertNotIn("\x1b", data["ignored_columns"][0])
        self.assertNotIn("\u202e", data["ignored_columns"][0])

    def test_script_in_data_stays_data(self):
        status, headers, data = convert(self.app, b'Name,Email\n"<script>alert(1)</script>",x@y.co\n')
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("FN:<script>alert(1)</script>", data["vcf"])

    def test_busy_server_answers_503(self):
        app = webapp.App(max_bytes=1024 * 1024, workers=1)
        app.convert_wait = 0.2
        for slots in (app.slots, app.upload_slots):  # ช่องแปลงไฟล์เต็ม / ช่องรับไฟล์เต็ม
            held = 0
            while slots.acquire(blocking=False):
                held += 1
            try:
                status, headers, data = convert(app)
            finally:
                for _ in range(held):
                    slots.release()
            self.assertEqual(status, 503)
            self.assertEqual(headers["Retry-After"], "5")
            self.assertEqual(convert(app)[0], 200)  # คืนช่องแล้วใช้ต่อได้

    def test_waits_briefly_for_a_conversion_slot(self):
        app = webapp.App(max_bytes=1024 * 1024, workers=1)
        app.convert_wait = 5
        app.slots.acquire()
        threading.Timer(0.3, app.slots.release).start()
        self.assertEqual(convert(app)[0], 200)

    def test_client_disconnect_is_not_an_internal_error(self):
        class Broken(io.RawIOBase):
            def readable(self):
                return True

            def readinto(self, buffer):
                raise ConnectionResetError("reset by peer")

        environ = {
            "REQUEST_METHOD": "POST", "PATH_INFO": "/api/convert", "QUERY_STRING": "",
            "CONTENT_LENGTH": "100", "wsgi.input": io.BufferedReader(Broken()),
            "HTTP_X_REQUESTED_WITH": "csv2vcf",
        }
        setup_testing_defaults(environ)
        seen = {}
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.app(environ, lambda status, headers, exc_info=None: seen.setdefault("status", status))
        self.assertTrue(seen["status"].startswith("400"))
        self.assertEqual(err.getvalue(), "")  # ไม่มี traceback ใน log

    def test_slots_are_released_after_errors(self):
        app = webapp.App(max_bytes=1024 * 1024, workers=1)
        for _ in range(3):
            self.assertEqual(convert(app, b"foo,bar\n1,2\n")[0], 422)
        self.assertEqual(convert(app)[0], 200)

    def test_internal_errors_do_not_leak_details(self):
        original = csv2vcf.iter_vcards

        def boom(*args, **kwargs):
            raise RuntimeError("secret /etc/passwd details")

        csv2vcf.iter_vcards = boom
        try:
            with contextlib.redirect_stderr(io.StringIO()) as err:
                status, _, data = convert(self.app)
        finally:
            csv2vcf.iter_vcards = original
        self.assertEqual(status, 500)
        self.assertNotIn("secret", data["error"])
        self.assertIn("secret", err.getvalue())  # แต่ยังอยู่ใน log ของเซิร์ฟเวอร์


class RealServerTest(unittest.TestCase):
    """เปิดเซิร์ฟเวอร์จริงบนพอร์ตว่างของเครื่อง แล้วทดสอบผ่าน socket"""

    def setUp(self):
        # เซิร์ฟเวอร์เขียน log หลังส่งผลลัพธ์แล้ว จึงเก็บ log ไว้ตลอดทั้งเทสต์ ไม่ให้ปนกับผลเทสต์
        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.addCleanup(stack.close)

    def start(self, handler=webapp.RequestHandler, max_connections=webapp.MAX_CONNECTIONS):
        server = webapp.make_server("127.0.0.1", 0, webapp.App(max_bytes=1024 * 1024), max_connections, handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def request(self, port, method="GET", path="/", body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_end_to_end(self):
        port = self.start()
        with contextlib.redirect_stderr(io.StringIO()):
            status, headers, body = self.request(port)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Server"], "csv2vcf")  # ไม่บอกรุ่นของ Python
            status, _, body = self.request(
                port, "POST", "/api/convert?country_code=66", EXAMPLE,
                {"X-Requested-With": "csv2vcf", "Content-Type": "application/octet-stream"},
            )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["contacts"], 3)

    def test_log_lines_escape_control_characters(self):
        port = self.start()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
                sock.sendall(b"GET /\x1b[2J\x07 HTTP/1.0\r\n\r\n")
                while sock.recv(4096):
                    pass
            for _ in range(50):
                if "GET" in err.getvalue():
                    break
                time.sleep(0.05)
        self.assertIn("GET", err.getvalue())
        self.assertNotIn("\x1b", err.getvalue())
        self.assertNotIn("\x07", err.getvalue())

    def test_slow_headers_are_cut_off(self):
        # slowloris: ส่งทีละไบต์ช้า ๆ ไม่ให้เกิน timeout ต่อครั้ง แต่นานเกินเวลารวม
        handler = type("FastHandler", (webapp.RequestHandler,), {"timeout": 2, "read_deadline": 1})
        port = self.start(handler)
        start = time.monotonic()
        with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
            closed = False
            for byte in b"GET / HTTP/1.1\r\nX-Slow: " + b"a" * 200:
                try:
                    sock.sendall(bytes([byte]))
                    time.sleep(0.1)
                except OSError:
                    closed = True
                    break
                if time.monotonic() - start > 5:
                    break
            if not closed:
                sock.settimeout(3)
                try:
                    closed = sock.recv(1) == b""
                except OSError:
                    closed = True
        self.assertTrue(closed)
        self.assertLess(time.monotonic() - start, 5)

    def test_stalled_upload_gets_408(self):
        handler = type("FastHandler", (webapp.RequestHandler,), {"timeout": 0.5})
        port = self.start(handler)
        with contextlib.redirect_stderr(io.StringIO()):
            with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
                sock.sendall(
                    b"POST /api/convert HTTP/1.1\r\nHost: x\r\nX-Requested-With: csv2vcf\r\n"
                    b"Content-Length: 1000\r\n\r\nName,Phone\n"
                )
                response = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    response += chunk
        self.assertTrue(response.startswith(b"HTTP/1.0 408"), response[:40])
        self.assertIn("หมดเวลา".encode("utf-8"), response)

    def test_connection_limit(self):
        handler = type("FastHandler", (webapp.RequestHandler,), {"timeout": 3})
        port = self.start(handler, max_connections=1)
        with socket.create_connection(("127.0.0.1", port), timeout=5) as idle:
            time.sleep(0.2)  # การเชื่อมต่อแรกค้างไว้ ใช้ช่องที่มีอยู่ช่องเดียว
            with socket.create_connection(("127.0.0.1", port), timeout=5) as extra:
                extra.sendall(b"GET / HTTP/1.0\r\n\r\n")
                try:
                    data = extra.recv(100)
                except ConnectionResetError:
                    data = b""
            self.assertEqual(data, b"")  # ถูกตัดทันที ไม่มีเธรดใหม่
            idle.close()
        time.sleep(3.5)  # รอให้การเชื่อมต่อแรกหมดเวลาและคืนช่อง
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.request(port)[0], 200)

    def test_builtin_error_pages_are_plain_text(self):
        port = self.start()
        for request in (b"GET /" + b"a" * 70000 + b" HTTP/1.1\r\n\r\n", b"GET / HTTP/1.1\r\n" + b"X: 1\r\n" * 150 + b"\r\n"):
            with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
                sock.sendall(request)
                response = b""
                while True:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    response += chunk
            head = response.split(b"\r\n\r\n", 1)[0].lower()
            self.assertIn(b"content-type: text/plain", head)
            self.assertNotIn(b"<html", response.lower())

    def test_server_errors_are_logged_escaped(self):
        server = webapp.make_server("127.0.0.1", 0, webapp.App())
        self.addCleanup(server.server_close)
        err = io.StringIO()
        try:
            raise ValueError("bad \x1b[2J\x07 input")
        except ValueError:
            with contextlib.redirect_stderr(err):
                server.handle_error(None, ("192.0.2.1", 5555))
        self.assertIn("192.0.2.1", err.getvalue())
        self.assertIn("ValueError", err.getvalue())
        self.assertNotIn("\x1b", err.getvalue())
        self.assertNotIn("\x07", err.getvalue())

    def test_large_result_is_sent_in_chunks(self):
        # ผลลัพธ์ใหญ่กว่าหนึ่งช่วงของการส่ง ต้องมาครบ
        port = self.start()
        body = ("Name,Notes\n" + "".join("P%d,%s\n" % (i, "x" * 300) for i in range(1500))).encode()
        with contextlib.redirect_stderr(io.StringIO()):
            status, _, raw = self.request(
                port, "POST", "/api/convert", body, {"X-Requested-With": "csv2vcf"}
            )
        self.assertEqual(status, 200)
        self.assertGreater(len(raw), webapp.WRITE_CHUNK * 3)
        self.assertEqual(json.loads(raw)["contacts"], 1500)


class CommandLineTest(unittest.TestCase):
    def test_environment_settings(self):
        self.assertEqual(webapp._env_int("CSV2VCF_TEST_UNSET", 7, 1, 10), 7)
        for value, ok in (("5", True), ("0", False), ("abc", False), ("11", False), ("\u0e55", False), ("\u00b2", False), ("1_0", False)):
            os.environ["CSV2VCF_TEST_VALUE"] = value
            try:
                if ok:
                    self.assertEqual(webapp._env_int("CSV2VCF_TEST_VALUE", 7, 1, 10), 5)
                else:
                    with self.assertRaises(SystemExit):
                        webapp._env_int("CSV2VCF_TEST_VALUE", 7, 1, 10)
            finally:
                del os.environ["CSV2VCF_TEST_VALUE"]

    def test_bad_arguments(self):
        for argv in (
            ["--port", "70000"], ["--port", "x"], ["--max-size", "0"], ["--workers", "99"],
            ["--port", "\u00b2"], ["--port", "8_000"], ["--max-size", "\u0e51\u0e50"], ["--workers", "+2"],
        ):
            err = io.StringIO()
            # ถ้าค่าผิดหลุดผ่านไปได้ ให้ fail ทันที ไม่ใช่เปิดเซิร์ฟเวอร์จริงค้างไว้
            no_server = AssertionError("ไม่ควรเปิดเซิร์ฟเวอร์ด้วย %r" % (argv,))
            with mock.patch.object(webapp, "make_server", side_effect=no_server), \
                    contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as ctx:
                webapp.main(argv)
            self.assertEqual(ctx.exception.code, 2, argv)
            self.assertIn("ผิดพลาด", err.getvalue())

    def test_port_in_use(self):
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            port = busy.getsockname()[1]
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = webapp.main(["--port", str(port)])
        self.assertEqual(code, 1)
        self.assertIn("เปิดพอร์ต", err.getvalue())


if __name__ == "__main__":
    unittest.main()
