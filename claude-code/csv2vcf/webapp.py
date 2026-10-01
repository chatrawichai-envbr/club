#!/usr/bin/env python3
"""webapp - เว็บไซต์แปลงรายชื่อผู้ติดต่อ .csv เป็นไฟล์ vCard (.vcf)

เซิร์ฟเวอร์ WSGI ที่ใช้เฉพาะ Python standard library ครอบโมดูล csv2vcf ตัวเดียวกับ
command line ผู้ใช้อัปโหลดไฟล์ CSV ผ่านหน้าเว็บ แล้วได้ไฟล์ .vcf กลับไป ไฟล์ถูก
ประมวลผลในหน่วยความจำและไม่ถูกบันทึกลงดิสก์

    python3 webapp.py                      # เปิด http://127.0.0.1:8000
    python3 webapp.py --host 0.0.0.0 --port 8080

ใช้กับ WSGI server อื่นได้ (เช่น waitress, gunicorn) ผ่านตัวแปร ``application``
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import socket
import socketserver
import sys
import threading
import time
import traceback
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs
from wsgiref.simple_server import ServerHandler, WSGIRequestHandler, WSGIServer

import csv2vcf

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(HERE, "web")
EXAMPLE_CSV = os.path.join(HERE, "example.csv")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_MAX_MB = 10
MAX_MAX_MB = 200
DEFAULT_WORKERS = 2  # จำนวนไฟล์ที่แปลงพร้อมกันได้ (แต่ละไฟล์ใช้หน่วยความจำหลายเท่าของขนาดไฟล์)
UPLOADS_PER_WORKER = 4  # จำนวนไฟล์ที่รับเข้ามาพร้อมกันได้ต่อช่องแปลงไฟล์หนึ่งช่อง
CONVERT_WAIT = 15  # วินาที: ไฟล์ที่รับครบแล้วรอช่องแปลงไฟล์ได้นานเท่านี้ก่อนตอบว่าระบบไม่ว่าง
MAX_CONNECTIONS = 64  # จำนวนการเชื่อมต่อพร้อมกันสูงสุด เกินนี้จะถูกตัดทันที
IDLE_TIMEOUT = 30  # วินาที: ไม่มีข้อมูลเคลื่อนไหวนานเกินนี้จะตัดการเชื่อมต่อ
# timeout ของ socket นับทีละครั้งที่อ่าน client ที่ส่งทีละไบต์ช้า ๆ (slowloris) จึงค้างการเชื่อมต่อ
# ได้เป็นวัน ต้องมีเวลารวมสูงสุดด้วย
READ_DEADLINE = 180  # วินาที: เวลารวมในการรับคำขอทั้งหมด (บรรทัดคำขอ, header และไฟล์)
WRITE_DEADLINE = 600  # วินาที: เวลารวมในการส่งผลลัพธ์กลับ (เผื่อผู้ใช้เน็ตช้า)
WRITE_CHUNK = 64 * 1024
MAX_WARNINGS = 100
MAX_IGNORED_COLUMNS = 50
# จำกัด encoding ที่เลือกได้ codec บางตัว (เช่น punycode) ถอดรหัสช้าแบบกำลังสองกับข้อมูลที่จงใจสร้าง
ENCODINGS = ("auto", "utf-8", "cp874", "tis-620", "utf-16", "cp1252")
DELIMITERS = {"": None, "comma": ",", "semicolon": ";", "tab": "\t", "pipe": "|"}
# ต้องมี header นี้ เบราว์เซอร์จะไม่ยอมให้เว็บอื่นส่ง header พิเศษข้ามโดเมนโดยไม่ถามก่อน (CORS preflight)
# ซึ่งเซิร์ฟเวอร์นี้ไม่ตอบ เว็บอื่นจึงส่งไฟล์มาแปลงผ่านเบราว์เซอร์ของผู้ใช้ไม่ได้ (กัน CSRF)
CSRF_HEADER = ("HTTP_X_REQUESTED_WITH", "csv2vcf")

SECURITY_HEADERS: List[Tuple[str, str]] = [
    (
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
]

StartResponse = Callable[..., object]
_DIGITS_RE = re.compile(r"[0-9]{1,100}")  # ตัวเลข ASCII ล้วน (ยาวมากก็ยังเป็น 413 ไม่ใช่รูปแบบผิด)
_STATUS = {
    200: "200 OK", 400: "400 Bad Request", 403: "403 Forbidden", 404: "404 Not Found",
    405: "405 Method Not Allowed", 408: "408 Request Timeout", 411: "411 Length Required",
    413: "413 Payload Too Large", 422: "422 Unprocessable Entity",
    500: "500 Internal Server Error", 503: "503 Service Unavailable",
}


class RequestError(Exception):
    """คำขอที่ไม่ถูกต้อง แจ้งกลับผู้ใช้ด้วย HTTP status และข้อความภาษาไทย"""

    def __init__(self, status: int, message: str, headers: Sequence[Tuple[str, str]] = ()):
        super().__init__(message)
        self.status = status
        self.headers = list(headers)


def _read_file(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


class App:
    """แอป WSGI: หน้าเว็บ + API แปลงไฟล์ (ไม่มีสถานะ ไม่เก็บไฟล์ของผู้ใช้)"""

    def __init__(self, max_bytes: int = DEFAULT_MAX_MB * 1024 * 1024, workers: int = DEFAULT_WORKERS):
        self.max_bytes = max_bytes
        # แยกช่องรับไฟล์ (ใช้หน่วยความจำเท่าขนาดไฟล์) กับช่องแปลงไฟล์ (ใช้หลายเท่า) คนที่อัปโหลดช้า
        # จะได้ไม่กันช่องแปลงไฟล์ไว้จนคนอื่นใช้งานไม่ได้ หน่วยความจำรวมยังมีขอบเขตเสมอ
        self.upload_slots = threading.BoundedSemaphore(workers * UPLOADS_PER_WORKER)
        self.slots = threading.BoundedSemaphore(workers)
        self.convert_wait = CONVERT_WAIT
        index = _read_file(os.path.join(WEB_DIR, "index.html"))
        index = index.replace(b"__MAX_MB__", str(max_bytes // (1024 * 1024)).encode("ascii"))
        # ไฟล์ที่เปิดให้ดาวน์โหลดได้มีเฉพาะในรายการนี้ (จับคู่ path ตรงตัว จึงไม่มีทางไต่ไดเรกทอรี)
        self.static: Dict[str, Tuple[bytes, str, List[Tuple[str, str]]]] = {
            "/": (index, "text/html; charset=utf-8", []),
            "/app.js": (_read_file(os.path.join(WEB_DIR, "app.js")), "text/javascript; charset=utf-8", []),
            "/style.css": (_read_file(os.path.join(WEB_DIR, "style.css")), "text/css; charset=utf-8", []),
            "/example.csv": (
                _read_file(EXAMPLE_CSV),
                "text/csv; charset=utf-8",
                [("Content-Disposition", 'attachment; filename="contacts-example.csv"')],
            ),
        }

    # -- WSGI ---------------------------------------------------------------

    def __call__(self, environ: dict, start_response: StartResponse) -> Iterable[bytes]:
        method = environ.get("REQUEST_METHOD", "GET")
        path = environ.get("PATH_INFO", "") or "/"
        try:
            if path == "/api/convert":
                if method != "POST":
                    raise RequestError(405, "ใช้ได้เฉพาะเมธอด POST", [("Allow", "POST")])
                return self._json(start_response, 200, self._convert(environ))
            if path == "/healthz":
                return self._send(start_response, 200, b"ok", "text/plain; charset=utf-8", method)
            if path in self.static:
                if method not in ("GET", "HEAD"):
                    return self._send(
                        start_response, 405, "ใช้ได้เฉพาะเมธอด GET".encode("utf-8"),
                        "text/plain; charset=utf-8", method, [("Allow", "GET, HEAD")],
                    )
                body, content_type, extra = self.static[path]
                return self._send(start_response, 200, body, content_type, method, extra)
            return self._send(
                start_response, 404, "ไม่พบหน้าที่ต้องการ".encode("utf-8"), "text/plain; charset=utf-8", method
            )
        except RequestError as exc:
            return self._json(start_response, exc.status, {"ok": False, "error": str(exc)}, exc.headers)
        except Exception:  # noqa: BLE001 -- ห้ามส่ง traceback ให้ผู้ใช้ บันทึกลง log ของเซิร์ฟเวอร์แทน
            lines = traceback.format_exc().splitlines()
            sys.stderr.write("".join(csv2vcf.escape_controls(line) + "\n" for line in lines))
            return self._json(start_response, 500, {"ok": False, "error": "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง"})

    # -- API ----------------------------------------------------------------

    def _convert(self, environ: dict) -> dict:
        if environ.get(CSRF_HEADER[0]) != CSRF_HEADER[1]:
            raise RequestError(403, "คำขอต้องส่งมาจากหน้าเว็บของระบบนี้")
        length = self._content_length(environ)
        options, encoding, delimiter = self._options(environ.get("QUERY_STRING", ""))
        busy = RequestError(503, "ระบบกำลังแปลงไฟล์อื่นอยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่", [("Retry-After", "5")])
        if not self.upload_slots.acquire(blocking=False):
            raise busy
        try:
            data = self._read_body(environ["wsgi.input"], length)
            if not self.slots.acquire(timeout=self.convert_wait):
                raise busy
            try:
                return self._run_conversion(data, options, encoding, delimiter)
            finally:
                self.slots.release()
        finally:
            self.upload_slots.release()

    def _content_length(self, environ: dict) -> int:
        value = (environ.get("CONTENT_LENGTH") or "").strip()
        # รับเฉพาะตัวเลข ASCII ล้วน int() ของ Python ยอมรับ "2_4", "+24" และตัวเลขภาษาอื่น
        # ซึ่ง proxy ถือว่าผิดรูปแบบ การตีความไม่ตรงกันเป็นต้นทางของ request smuggling
        if not _DIGITS_RE.fullmatch(value):
            raise RequestError(411, "ต้องระบุขนาดไฟล์ (Content-Length) เป็นตัวเลข")
        length = int(value)
        if length <= 0:
            raise RequestError(400, "ไม่ได้เลือกไฟล์ หรือไฟล์ว่างเปล่า")
        if length > self.max_bytes:
            raise RequestError(413, f"ไฟล์ใหญ่เกิน {self.max_bytes // (1024 * 1024)} MB")
        return length

    @staticmethod
    def _options(query: str) -> Tuple[csv2vcf.Options, str, Optional[str]]:
        try:
            params = parse_qs(query, max_num_fields=10)
        except ValueError:
            raise RequestError(400, "พารามิเตอร์มากเกินไป") from None

        def get(name: str) -> str:
            return params.get(name, [""])[0].strip()[:20]

        country_code = get("country_code") or None
        if country_code:
            try:
                country_code = csv2vcf._country_code_arg(country_code)
            except argparse.ArgumentTypeError as exc:
                raise RequestError(400, f"รหัสประเทศ{exc}") from None
        date_order = get("date_order") or "dmy"
        if date_order not in ("dmy", "mdy"):
            raise RequestError(400, "ลำดับวันที่ต้องเป็น dmy หรือ mdy")
        encoding = get("encoding") or "auto"
        if encoding not in ENCODINGS:
            raise RequestError(400, "การเข้ารหัสอักขระที่เลือกไม่รองรับ")
        delimiter_name = get("delimiter")
        if delimiter_name not in DELIMITERS:
            raise RequestError(400, "ตัวคั่นคอลัมน์ที่เลือกไม่รองรับ")
        options = csv2vcf.Options(country_code=country_code, date_order=date_order)
        return options, encoding, DELIMITERS[delimiter_name]

    @staticmethod
    def _read_body(stream, length: int) -> bytes:
        chunks: List[bytes] = []
        remaining = length
        try:
            while remaining > 0:
                chunk = stream.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        except (socket.timeout, TimeoutError):
            raise RequestError(408, "ส่งไฟล์ช้าเกินไป การเชื่อมต่อหมดเวลา") from None
        except ConnectionError:  # ผู้ใช้ยกเลิกหรือเน็ตหลุดระหว่างอัปโหลด ไม่ใช่ข้อผิดพลาดของระบบ
            raise RequestError(400, "การเชื่อมต่อถูกตัดระหว่างส่งไฟล์") from None
        if remaining:
            raise RequestError(400, "ได้รับไฟล์ไม่ครบ กรุณาลองใหม่อีกครั้ง")
        return b"".join(chunks)

    @staticmethod
    def _run_conversion(
        data: bytes, options: csv2vcf.Options, encoding: str, delimiter: Optional[str]
    ) -> dict:
        warnings: List[dict] = []
        total = 0

        def warn(line: int, message: str) -> None:
            nonlocal total
            total += 1
            if len(warnings) < MAX_WARNINGS:
                warnings.append({"line": line, "message": message})

        stats = csv2vcf.Stats()
        try:
            text, used_encoding = csv2vcf.decode_csv_bytes(data, encoding)
            vcf = "".join(csv2vcf.iter_vcards(text, delimiter, options, warn, stats))
        except csv2vcf.ConversionError as exc:
            raise RequestError(422, str(exc)) from None
        if not stats.written:
            raise RequestError(422, "ไม่มีรายชื่อที่แปลงได้เลย ตรวจสอบว่าไฟล์มีชื่อ เบอร์โทร หรืออีเมล")
        return {
            "ok": True,
            "vcf": vcf,
            "contacts": stats.written,
            "rows": stats.rows,
            "skipped": stats.skipped,
            "encoding": used_encoding,
            "warnings": warnings,
            "warnings_total": total,
            # ชื่อคอลัมน์มาจากไฟล์ของผู้ใช้ จึง escape อักขระควบคุมและจำกัดความยาวก่อนส่งกลับ
            "ignored_columns": [csv2vcf.show(name, 40) for name in stats.ignored_columns[:MAX_IGNORED_COLUMNS]],
            "ignored_columns_total": len(stats.ignored_columns),
        }

    # -- responses ----------------------------------------------------------

    @staticmethod
    def _send(
        start_response: StartResponse,
        status: int,
        body: bytes,
        content_type: str,
        method: str = "GET",
        extra: Sequence[Tuple[str, str]] = (),
    ) -> List[bytes]:
        headers = [("Content-Type", content_type), ("Content-Length", str(len(body)))]
        headers += SECURITY_HEADERS + list(extra)
        if not any(name == "Cache-Control" for name, _ in extra):
            headers.append(("Cache-Control", "no-cache"))
        start_response(_STATUS[status], headers)
        return [b"" if method == "HEAD" else body]

    def _json(
        self, start_response: StartResponse, status: int, payload: dict, extra: Sequence[Tuple[str, str]] = ()
    ) -> List[bytes]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        # ผลลัพธ์เป็นข้อมูลส่วนบุคคล ห้ามเบราว์เซอร์หรือ proxy เก็บ cache
        extra = list(extra) + [("Cache-Control", "no-store")]
        return self._send(start_response, status, body, "application/json; charset=utf-8", "POST", extra)


# ----------------------------------------------------------------------------
# เซิร์ฟเวอร์
# ----------------------------------------------------------------------------


def _time_left(deadline: float, idle: float) -> float:
    left = min(deadline - time.monotonic(), idle)
    if left <= 0:
        raise socket.timeout("หมดเวลา")
    return left


class _DeadlineReader(io.RawIOBase):
    """อ่านจาก socket โดยจำกัดทั้งเวลารอแต่ละครั้งและเวลารวม"""

    def __init__(self, sock: socket.socket, seconds: float, idle: float):
        super().__init__()
        self._sock = sock
        self._idle = idle
        self._deadline = time.monotonic() + seconds

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:  # type: ignore[override]
        self._sock.settimeout(_time_left(self._deadline, self._idle))
        return self._sock.recv_into(buffer)


class _DeadlineWriter(io.RawIOBase):
    """ส่งข้อมูลทีละช่วง แต่ละช่วงรอได้ไม่เกิน timeout ของ handler และรวมไม่เกิน WRITE_DEADLINE

    Python นับ timeout ของ sendall รวมทั้งก้อน ถ้าส่งผลลัพธ์ใหญ่ทีเดียว ผู้ใช้เน็ตช้าจะถูกตัดกลางทาง
    """

    def __init__(self, sock: socket.socket, seconds: float, idle: float):
        super().__init__()
        self._sock = sock
        self._seconds = seconds
        self._idle = idle
        self._deadline: Optional[float] = None

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:  # type: ignore[override]
        if self._deadline is None:  # เริ่มนับเมื่อเริ่มส่งผลลัพธ์
            self._deadline = time.monotonic() + self._seconds
        view = memoryview(data)
        for start in range(0, len(view), WRITE_CHUNK):
            self._sock.settimeout(_time_left(self._deadline, self._idle))
            self._sock.sendall(view[start:start + WRITE_CHUNK])
        return len(view)


class _ServerHandler(ServerHandler):
    server_software = "csv2vcf"  # ไม่บอกรุ่นของ Python ใน header Server

    def log_exception(self, exc_info) -> None:  # type: ignore[no-untyped-def]
        # client ตัดการเชื่อมต่อหรือหมดเวลาระหว่างส่งผลลัพธ์ เขียน log บรรทัดเดียวพอ ไม่ต้องมี traceback
        sys.stderr.write(f"ส่งผลลัพธ์ไม่สำเร็จ: {csv2vcf.escape_controls(repr(exc_info[1]))}\n")


class RequestHandler(WSGIRequestHandler):
    server_version = "csv2vcf"
    sys_version = ""
    # หน้า error ที่ http.server สร้างเอง (400, 414, 431, 505) เป็นข้อความธรรมดาแทน HTML
    error_content_type = "text/plain; charset=utf-8"
    error_message_format = "%(code)d %(message)s\n"
    timeout = IDLE_TIMEOUT
    read_deadline = READ_DEADLINE
    write_deadline = WRITE_DEADLINE

    def setup(self) -> None:
        super().setup()
        original = self.rfile
        self.rfile = io.BufferedReader(_DeadlineReader(self.connection, self.read_deadline, self.timeout))
        self.wfile = _DeadlineWriter(self.connection, self.write_deadline, self.timeout)
        original.close()  # ไม่ปิดจะค้างการอ้างอิง socket ไว้ ทำให้ปิดการเชื่อมต่อไม่ได้จริง

    def handle(self) -> None:
        # เหมือน WSGIRequestHandler.handle แต่ใช้ _ServerHandler (header Server ไม่บอกรุ่น Python)
        # และตัดการเชื่อมต่อเงียบ ๆ เมื่อ client ส่งบรรทัดคำขอช้าเกินไป
        try:
            self.raw_requestline = self.rfile.readline(65537)
        except (socket.timeout, TimeoutError, ConnectionError):
            return
        if len(self.raw_requestline) > 65536:
            self.requestline = self.request_version = self.command = ""
            self.send_error(414)
            return
        try:
            if not self.parse_request():
                return
        except (socket.timeout, TimeoutError, ConnectionError):
            return
        handler = _ServerHandler(self.rfile, self.wfile, self.get_stderr(), self.get_environ(), multithread=True)
        handler.request_handler = self
        handler.run(self.server.get_app())

    def log_message(self, format: str, *args) -> None:  # noqa: A002 -- ชื่อตาม BaseHTTPRequestHandler
        # บรรทัดคำขอมาจาก client escape อักขระควบคุมก่อนเขียน log กันการสั่งการ terminal
        message = csv2vcf.escape_controls(format % args)
        sys.stderr.write(f"{self.address_string()} - [{self.log_date_time_string()}] {message}\n")


class Server(socketserver.ThreadingMixIn, WSGIServer):
    """WSGIServer ที่รับหลายการเชื่อมต่อพร้อมกัน แต่จำกัดจำนวนเธรดสูงสุด"""

    daemon_threads = True

    def __init__(self, *args, max_connections: int = MAX_CONNECTIONS, **kwargs):
        self._connections = threading.BoundedSemaphore(max_connections)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):  # type: ignore[no-untyped-def]
        # ไม่สร้างเธรดใหม่ไม่จำกัด (คนละการเชื่อมต่อละหนึ่งเธรด ใช้หน่วยความจำหมดเครื่องได้)
        if not self._connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._connections.release()
            raise

    def process_request_thread(self, request, client_address):  # type: ignore[no-untyped-def]
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._connections.release()

    def handle_error(self, request, client_address):  # type: ignore[no-untyped-def]
        # ข้อความของ exception อาจมีข้อมูลจาก client escape อักขระควบคุมทีละบรรทัดก่อนเขียน log
        lines = [f"เกิดข้อผิดพลาดระหว่างจัดการคำขอจาก {client_address[0]}"]
        lines += traceback.format_exc().splitlines()
        sys.stderr.write("".join(csv2vcf.escape_controls(line) + "\n" for line in lines))


def make_server(
    host: str,
    port: int,
    app: App,
    max_connections: int = MAX_CONNECTIONS,
    handler: type = RequestHandler,
) -> Server:
    server_class = type("_Server", (Server,), {"address_family": socket.AF_INET6 if ":" in host else socket.AF_INET})
    server = server_class((host, port), handler, max_connections=max_connections)
    server.set_app(app)
    return server


def _port_arg(value: str) -> int:
    if not _DIGITS_RE.fullmatch(value) or not 0 <= int(value) <= 65535:
        raise argparse.ArgumentTypeError("ต้องเป็นตัวเลข 0-65535")
    return int(value)


def _bounded_int_arg(low: int, high: int) -> Callable[[str], int]:
    def parse(value: str) -> int:
        if not _DIGITS_RE.fullmatch(value) or not low <= int(value) <= high:
            raise argparse.ArgumentTypeError(f"ต้องเป็นจำนวนเต็ม {low}-{high}")
        return int(value)

    return parse


def build_parser() -> argparse.ArgumentParser:
    parser = csv2vcf._ThaiArgumentParser(
        prog="webapp",
        description="เปิดเว็บไซต์แปลงไฟล์รายชื่อ .csv เป็นไฟล์ vCard (.vcf)",
        formatter_class=csv2vcf._ThaiHelpFormatter,
        add_help=False,
    )
    options = parser.add_argument_group("ตัวเลือก")
    options.add_argument("-h", "--help", action="help", help="แสดงข้อความช่วยเหลือนี้แล้วออก")
    options.add_argument("--host", default=DEFAULT_HOST, metavar="ที่อยู่", help=f"ที่อยู่ที่รอรับการเชื่อมต่อ (ค่าเริ่มต้น: {DEFAULT_HOST} คือเฉพาะเครื่องนี้, 0.0.0.0 คือทุกเครื่องในเครือข่าย)")
    options.add_argument("--port", type=_port_arg, default=DEFAULT_PORT, metavar="พอร์ต", help=f"พอร์ต (ค่าเริ่มต้น: {DEFAULT_PORT})")
    options.add_argument("--max-size", type=_bounded_int_arg(1, MAX_MAX_MB), default=DEFAULT_MAX_MB, metavar="เมกะไบต์", help=f"ขนาดไฟล์ที่อัปโหลดได้สูงสุด (ค่าเริ่มต้น: {DEFAULT_MAX_MB} เมกะไบต์)")
    options.add_argument("--workers", type=_bounded_int_arg(1, 32), default=DEFAULT_WORKERS, metavar="จำนวน", help=f"จำนวนไฟล์ที่แปลงพร้อมกันได้ (ค่าเริ่มต้น: {DEFAULT_WORKERS})")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    args = build_parser().parse_args(argv)
    app = App(max_bytes=args.max_size * 1024 * 1024, workers=args.workers)
    try:
        server = make_server(args.host, args.port, app)
    except OSError as exc:
        print(f"webapp: ผิดพลาด: เปิดพอร์ต {args.port} ไม่ได้ ({exc.strerror or exc})", file=sys.stderr)
        return 1
    host, port = server.server_address[:2]
    shown = f"[{host}]" if ":" in host else host
    print(f"เปิดเว็บไซต์แล้วที่ http://{shown}:{port}  (กด Ctrl+C เพื่อปิด)", file=sys.stderr)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            "คำเตือน: เครื่องอื่นในเครือข่ายเข้าถึงได้ ถ้าเปิดสู่อินเทอร์เน็ตควรใช้ผ่าน HTTPS "
            "(เช่น วางหลัง nginx หรือ Caddy)",
            file=sys.stderr,
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nปิดเว็บไซต์แล้ว", file=sys.stderr)
    finally:
        server.server_close()
    return 0


def _env_int(name: str, default: int, low: int, high: int) -> int:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    if not _DIGITS_RE.fullmatch(value) or not low <= int(value) <= high:
        raise SystemExit(f"webapp: ผิดพลาด: {name} ต้องเป็นจำนวนเต็ม {low}-{high}")
    return int(value)


# สำหรับ WSGI server อื่น เช่น: waitress-serve --listen=127.0.0.1:8000 webapp:application
# ตั้งค่าได้ด้วย environment variable CSV2VCF_MAX_MB และ CSV2VCF_WORKERS
application = App(
    max_bytes=_env_int("CSV2VCF_MAX_MB", DEFAULT_MAX_MB, 1, MAX_MAX_MB) * 1024 * 1024,
    workers=_env_int("CSV2VCF_WORKERS", DEFAULT_WORKERS, 1, 32),
)

if __name__ == "__main__":
    sys.exit(main())
