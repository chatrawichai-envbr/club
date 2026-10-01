// csv2vcf.js - แปลงไฟล์รายชื่อผู้ติดต่อ .csv เป็นไฟล์ vCard 3.0 (.vcf) ในเบราว์เซอร์
//
// port จาก csv2vcf.py ให้ได้ผลลัพธ์เหมือนกันทุกไบต์ รวมถึงคำเตือนและข้อความผิดพลาด
// (tests/test_static_site.py รันไฟล์ชุดเดียวกันผ่านทั้งสองภาษาแล้วเทียบผล)
// ตารางข้อมูลอยู่ใน csv2vcf-data.js ซึ่งสร้างจาก Python ด้วย tools/build_js_data.py
"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./csv2vcf-data.js"));
  else root.CSV2VCF = factory(root.CSV2VCF_DATA);
})(typeof self !== "undefined" ? self : this, function (DATA) {
  // ---------------------------------------------------------------------------
  // ตัวช่วยให้ทำงานเหมือน Python
  // ---------------------------------------------------------------------------

  // อักขระที่ str.split() / str.strip() ของ Python ถือเป็นช่องว่าง (ต่างจาก \s ของ JavaScript)
  const PY_WS_CODES = [9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  const PY_WS = new Set(PY_WS_CODES.map((code) => String.fromCharCode(code)));
  const PY_WS_CLASS = PY_WS_CODES.map((code) => "\\u" + code.toString(16).padStart(4, "0")).join("");
  const WS_RUN = new RegExp("[" + PY_WS_CLASS + "]+", "gu");

  // ตัดช่องว่างหัวท้ายด้วยการไล่ index (regex แบบ [ช่องว่าง]+$ ใช้เวลาแบบกำลังสองกับช่องว่างยาว ๆ)
  function stripSet(value, set, left, right) {
    let start = 0;
    let end = value.length;
    if (left) while (start < end && set.has(value[start])) start++;
    if (right) while (end > start && set.has(value[end - 1])) end--;
    return value.slice(start, end);
  }
  const pyStrip = (value) => stripSet(value, PY_WS, true, true);
  const stripChars = (value, chars) => stripSet(value, new Set(chars), true, true);
  const lstripChars = (value, chars) => stripSet(value, new Set(chars), true, false);
  const rstripChars = (value, chars) => stripSet(value, new Set(chars), false, true);

  function pySplit(value) {
    const parts = [];
    for (const part of value.split(WS_RUN)) if (part) parts.push(part);
    return parts;
  }

  // str.lower() ของ Python ใช้กฎของ Unicode เดียวกับ toLowerCase (รวมถึง Σ ท้ายคำเป็น ς)
  const pyLower = (value) => value.toLowerCase();

  function codePointLength(value) {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
      }
      count++;
    }
    return count;
  }

  // ตัดเหลือ limit code point แรก (เหมือน value[:limit] ของ Python) คืน null ถ้าสั้นกว่านั้นอยู่แล้ว
  function codePointPrefix(value, limit) {
    let count = 0;
    for (let i = 0; i < value.length; ) {
      if (count === limit) return value.slice(0, i);
      const cp = value.codePointAt(i);
      i += cp > 0xffff ? 2 : 1;
      count++;
    }
    return null;
  }

  function formatThousands(number) {
    return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  // ใช้ Map แทน object เพื่อไม่ให้หัวคอลัมน์ชื่อ "constructor" หรือ "__proto__" ไปเจอของใน prototype
  const toMap = (object) => new Map(Object.keys(object).map((key) => [key, object[key]]));

  class ConversionError extends Error {
    constructor(message) {
      super(message);
      this.name = "ConversionError";
    }
  }

  // ---------------------------------------------------------------------------
  // ฟังก์ชันช่วยจัดการข้อความ
  // ---------------------------------------------------------------------------

  const NEWLINE_RE = /\r\n|[\r\n\x0b\x0c\x85\u2028\u2029]/g;
  // เหมือน _STRIP_RE ของ Python: อักขระควบคุม C0/C1, surrogate เดี่ยว, BOM และอักขระควบคุมทิศทางข้อความ
  // (ใน regex แบบ u คลาส [\ud800-\udfff] ตรงเฉพาะ surrogate เดี่ยว ไม่ตรงคู่ที่เป็นอักขระจริง)
  const STRIP_RE = /[\x00-\x08\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufeff\u202a-\u202e\u2066-\u2069]/gu;

  function cleanText(value, multiline) {
    value = value.replace(NEWLINE_RE, "\n").replace(STRIP_RE, "").normalize("NFC");
    if (multiline) {
      const lines = value.split("\n").map((line) => pySplit(line).join(" "));
      return stripChars(lines.join("\n"), "\n");
    }
    return pySplit(value).join(" ");
  }

  function escapeText(value) {
    return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(NEWLINE_RE, "\\n");
  }

  const encoder = new TextEncoder();
  const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

  function foldLine(line, limit) {
    if (limit === undefined) limit = DATA.foldLimit;
    const data = encoder.encode(line);
    if (data.length <= limit) return line;
    // ตำแหน่งที่ห้ามตัด: ไบต์ที่ตามหลัง backslash ของ escape (\n, \\, ...) จับคู่จากซ้ายไปขวา
    const noCut = new Uint8Array(data.length);
    for (let i = 0; i < data.length; ) {
      if (data[i] === 0x5c && i + 1 < data.length) {
        noCut[i + 1] = 1;
        i += 2;
      } else {
        i += 1;
      }
    }
    const pieces = [];
    let start = 0;
    let room = limit;
    while (data.length - start > room) {
      let end = start + room;
      // ถอยจุดตัดออกจากกลางอักขระ UTF-8 (ไบต์ 10xxxxxx) และกลาง escape
      while (end > start + 1 && ((data[end] & 0xc0) === 0x80 || noCut[end])) end--;
      pieces.push(utf8Decoder.decode(data.subarray(start, end)));
      start = end;
      room = limit - 1; // บรรทัดต่อเนื่องขึ้นต้นด้วยช่องว่างหนึ่งตัว
    }
    pieces.push(utf8Decoder.decode(data.subarray(start)));
    return pieces.join("\r\n ");
  }

  function pyUnicodeEscape(ch) {
    if (ch === "\t") return "\\t";
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    const cp = ch.codePointAt(0);
    if (cp < 0x100) return "\\x" + cp.toString(16).padStart(2, "0");
    if (cp < 0x10000) return "\\u" + cp.toString(16).padStart(4, "0");
    return "\\U" + cp.toString(16).padStart(8, "0");
  }

  // แปลงอักขระควบคุมและอักขระจัดรูปแบบเป็น escape ก่อนแสดงผล (เหมือน escape_controls)
  function escapeControls(value) {
    return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, pyUnicodeEscape);
  }

  function show(value, limit) {
    if (limit === undefined) limit = 60;
    const prefix = codePointPrefix(value, limit);
    if (prefix !== null) value = prefix + "...";
    return '"' + escapeControls(value) + '"';
  }

  // มีอักขระที่มองไม่เห็น เช่น ช่องว่าง อักขระควบคุม หรือ zero-width (หมวด C*/Z* ของ Unicode) หรือไม่
  const HIDDEN_RE = /[\p{C}\p{Z}]/u;
  const hasHiddenChars = (value) => HIDDEN_RE.test(value);

  function digitValue(cp) {
    const zeros = DATA.digitZeros;
    let lo = 0;
    let hi = zeros.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (zeros[mid] <= cp) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0 || cp - zeros[found] > 9) return null;
    return cp - zeros[found];
  }

  // ทำ NFKC แล้วแปลงตัวเลขทุกแบบ (เลขไทย ๐-๙ ...) เป็นเลข ASCII (เหมือน _ascii_digits)
  function asciiDigits(value) {
    return value.normalize("NFKC").replace(/\p{Nd}/gu, (ch) => {
      const digit = digitValue(ch.codePointAt(0));
      return digit === null ? ch : String(digit);
    });
  }

  const ISDIGIT_EXTRA = new Set(DATA.isdigitNotNd);
  // str.isdigit() ของ Python: ตัวเลขทศนิยม (Nd) และอักขระที่มีค่าเป็นหลักเดียว เช่น ตัวยก
  function pyIsDigit(value) {
    if (!value) return false;
    for (const ch of value) {
      const cp = ch.codePointAt(0);
      if (!(/\p{Nd}/u.test(ch) && digitValue(cp) !== null) && !ISDIGIT_EXTRA.has(cp)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // ปรับรูปแบบข้อมูลแต่ละช่อง
  // ---------------------------------------------------------------------------

  const PHONE_SPLIT_RE = /:::|[;,/|\n]/;
  // ใช้ \s? ไม่ใช่ \s*: cleanText ยุบช่องว่างเหลือตัวเดียวแล้ว และ \s* ใช้เวลาแบบกำลังสองกับช่องว่างยาว ๆ
  const PHONE_EXT_RE = /\s?(?:ต่อ|extension|ext\.?|x)\s?(?=\d)/giu;
  const EXCEL_SCI_RE = /^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/;
  const PHONE_ALLOWED = new Set("0123456789+-(). *#,");
  const PHONE_PAREN_PLUS_RE = /^\(\s*\+\s*(\d{1,4})\s*\)/;
  const PHONE_TRUNK_ZERO_RE = /\(\s*0\s*\)/g;

  function normalizePhone(raw, countryCode) {
    let value = cleanText(asciiDigits(raw));
    if (!value) return [null, null];
    if (EXCEL_SCI_RE.test(value)) {
      return [null, `เบอร์โทร ${show(raw)} ถูก Excel แปลงเป็นเลขวิทยาศาสตร์ (ให้ตั้งคอลัมน์เป็น Text แล้ว export ใหม่)`];
    }
    value = value.replace(PHONE_EXT_RE, ","); // "ต่อ 12" / "ext 12" -> หยุดรอ (pause) แล้วกดเบอร์ต่อ
    let total = 0;
    let kept = "";
    for (const ch of value) {
      total++;
      if (PHONE_ALLOWED.has(ch)) kept += ch;
    }
    const dropped = kept.length !== total;
    let phone = pySplit(kept).join(" ").replace(PHONE_PAREN_PLUS_RE, "+$1 ");
    // "+" มีความหมายเฉพาะเมื่อเป็นอักขระตัวแรกเท่านั้น
    phone = phone.slice(0, 1) + phone.slice(1).replace(/\+/g, "");
    if (phone.startsWith("+")) phone = phone.replace(PHONE_TRUNK_ZERO_RE, " ");
    phone = stripChars(pySplit(phone).join(" "), " -.,");
    const digits = (phone.match(/[0-9]/g) || []).length;
    if (digits < 3 || phone.length > DATA.maxPhoneLen) return [null, `ข้ามเบอร์โทรที่ไม่ถูกต้อง ${show(raw)}`];
    if (countryCode && phone.startsWith("0") && !phone.startsWith("00")) {
      phone = `+${countryCode} ` + lstripChars(phone.slice(1), " -.");
    }
    return [phone, dropped ? `ตัดอักขระที่ไม่ใช่เบอร์โทรออกจาก ${show(raw)}` : null];
  }

  const EMAIL_SPLIT_RE = /:::|[;,]/;
  // ทั้งสองฝั่งห้ามมี "@" ไม่เช่นนั้น "<@@@@..." จะ backtrack แบบกำลังสอง
  const EMAIL_BRACKET_RE = new RegExp("<([^<>" + PY_WS_CLASS + "@]+@[^<>" + PY_WS_CLASS + "@]+)>", "gu");
  const EMAIL_NOT = PY_WS_CLASS + '@<>()\\[\\]\\\\,;:"';
  const EMAIL_RE = new RegExp("^[^" + EMAIL_NOT + "]+@[^" + EMAIL_NOT + ".]+(?:\\.[^" + EMAIL_NOT + ".]+)+$", "u");

  function splitEmails(raw) {
    const parts = [];
    for (const segment of cleanText(raw).split(EMAIL_SPLIT_RE)) {
      const found = Array.from(segment.matchAll(EMAIL_BRACKET_RE), (match) => match[1]);
      for (const part of found.length ? found : pySplit(segment)) parts.push(part);
    }
    return parts;
  }

  function normalizeEmail(raw) {
    let value = pyStrip(raw);
    if (pyLower(value.slice(0, 7)) === "mailto:") value = value.slice(7);
    // อักขระล่องหนทำให้ที่อยู่ปลอมดูเหมือน admin@bank.co.th แต่เป็นคนละที่อยู่
    if (codePointLength(value) > DATA.maxEmailLen || hasHiddenChars(value) || !EMAIL_RE.test(value)) return null;
    return value;
  }

  const URL_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\d)/;
  const URL_FORBIDDEN = new Set('<>"\\`{}|^');

  // ส่วนที่จำเป็นของ urllib.parse.urlsplit / hostname / port ของ Python 3.11+
  function urlNetloc(url) {
    const colon = url.indexOf(":");
    if (colon > 0 && /^[A-Za-z]/.test(url) && /^[A-Za-z0-9+.-]+$/.test(url.slice(0, colon))) url = url.slice(colon + 1);
    if (url.slice(0, 2) !== "//") return "";
    let delim = url.length;
    for (const ch of "/?#") {
      const at = url.indexOf(ch, 2);
      if (at >= 0) delim = Math.min(delim, at);
    }
    const netloc = url.slice(2, delim);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if (open !== close) throw new Error("Invalid IPv6 URL");
    if (open && close) checkBracketedNetloc(netloc);
    checkNetlocNfkc(netloc);
    return netloc;
  }

  function checkNetlocNfkc(netloc) {
    // อักขระอย่าง ℀ กลายเป็น "a/c" หลัง NFKC ทำให้ชื่อโดเมนเปลี่ยนความหมาย
    if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
    const stripped = netloc.replace(/[@:#?]/g, "");
    const normalized = stripped.normalize("NFKC");
    if (stripped === normalized) return;
    for (const ch of "/?#@:") if (normalized.includes(ch)) throw new Error("invalid characters under NFKC normalization");
  }

  function partition(value, separator) {
    const at = value.indexOf(separator);
    return at < 0 ? [value, "", ""] : [value.slice(0, at), separator, value.slice(at + separator.length)];
  }

  function rpartition(value, separator) {
    const at = value.lastIndexOf(separator);
    return at < 0 ? ["", "", value] : [value.slice(0, at), separator, value.slice(at + separator.length)];
  }

  function checkBracketedNetloc(netloc) {
    const hostAndPort = rpartition(netloc, "@")[2];
    const [before, open, bracketed] = partition(hostAndPort, "[");
    if (!open) return;
    if (before) throw new Error("Invalid IPv6 URL");
    const [hostname, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw new Error("Invalid IPv6 URL");
    if (hostname.startsWith("v")) {
      if (!/^v[a-fA-F0-9]+\.[^\n]+$/u.test(hostname)) throw new Error("IPvFuture address is invalid");
    } else if (parseIPv4(hostname) !== null || !isIPv6(hostname)) {
      throw new Error("invalid bracketed host");
    }
  }

  function parseIPv4(value) {
    if (!value || value.includes("/")) return null;
    const octets = value.split(".");
    if (octets.length !== 4) return null;
    let result = 0;
    for (const octet of octets) {
      if (!/^[0-9]{1,3}$/.test(octet)) return null;
      if (octet !== "0" && octet[0] === "0") return null;
      const number = Number(octet);
      if (number > 255) return null;
      result = result * 256 + number;
    }
    return result;
  }

  function isIPv6(value) {
    if (value.includes("/")) return false;
    const [address, percent, scope] = partition(value, "%");
    if (percent && (!scope || scope.includes("%"))) return false;
    if (!address) return false;
    const parts = address.split(":");
    if (parts.length < 3) return false;
    if (parts[parts.length - 1].includes(".")) {
      if (parseIPv4(parts.pop()) === null) return false;
      parts.push("0", "0");
    }
    if (parts.length > 9) return false;
    let skip = null;
    for (let i = 1; i < parts.length - 1; i++) {
      if (!parts[i]) {
        if (skip !== null) return false;
        skip = i;
      }
    }
    let hi;
    let lo;
    if (skip !== null) {
      hi = skip;
      lo = parts.length - skip - 1;
      if (!parts[0] && --hi) return false;
      if (!parts[parts.length - 1] && --lo) return false;
      if (8 - (hi + lo) < 1) return false;
    } else {
      if (parts.length !== 8 || !parts[0] || !parts[parts.length - 1]) return false;
      hi = parts.length;
      lo = 0;
    }
    const hextets = parts.slice(0, hi).concat(lo ? parts.slice(parts.length - lo) : []);
    return hextets.every((hextet) => /^[0-9a-fA-F]{1,4}$/.test(hextet));
  }

  function urlHostAndPort(netloc) {
    const hostinfo = rpartition(netloc, "@")[2];
    const [, open, bracketed] = partition(hostinfo, "[");
    let hostname;
    let port;
    if (open) {
      let rest;
      [hostname, , rest] = partition(bracketed, "]");
      port = partition(rest, ":")[2];
    } else {
      [hostname, , port] = partition(hostinfo, ":");
    }
    if (port) {
      if (!/^[0-9]+$/.test(port) || Number(port) > 65535) throw new Error("bad port");
    }
    return hostname;
  }

  function normalizeUrl(raw) {
    let value = cleanText(raw);
    if (!value || codePointLength(value) > DATA.maxUrlLen || hasHiddenChars(value)) return null;
    for (const ch of value) if (URL_FORBIDDEN.has(ch)) return null;
    const match = URL_SCHEME_RE.exec(value);
    if (match) {
      const scheme = match[1].toLowerCase();
      if ((scheme !== "http" && scheme !== "https") || !value.slice(match[0].length).startsWith("//")) return null;
    } else {
      value = "https://" + lstripChars(value, "/");
    }
    let netloc;
    let host;
    try {
      netloc = urlNetloc(value);
      host = urlHostAndPort(netloc);
    } catch (error) {
      return null;
    }
    // "https://www.bank.co.th@evil.example" แสดงเหมือนลิงก์ธนาคาร แต่จริง ๆ พาไป evil.example
    if (!host || netloc.includes("@")) return null;
    return value;
  }

  const DATE_YMD_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T][^\n]*)?$/u;
  const DATE_COMPACT_RE = /^(\d{4})(\d{2})(\d{2})$/;
  const DATE_XY_RE = new RegExp("^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})(?:[" + PY_WS_CLASS + "][^\\n]*)?$", "u");

  function daysInMonth(year, month) {
    if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function normalizeBirthday(raw, dateOrder) {
    const value = cleanText(asciiDigits(raw));
    let year;
    let month;
    let day;
    const match = DATE_YMD_RE.exec(value) || DATE_COMPACT_RE.exec(value);
    if (match) {
      [year, month, day] = match.slice(1, 4).map(Number);
    } else {
      const other = DATE_XY_RE.exec(value);
      if (!other) return null;
      const [first, second] = other.slice(1, 3).map(Number);
      year = Number(other[3]);
      [day, month] = dateOrder === "mdy" ? [second, first] : [first, second];
    }
    if (year > 2400) year -= 543; // ปี พ.ศ.
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------------------------
  // จดจำชื่อคอลัมน์
  // ---------------------------------------------------------------------------

  const SIMPLE_COLUMNS = toMap(DATA.simpleColumns);
  const TYPE_PREFIXES = toMap(DATA.typePrefixes);
  const GOOGLE_KIND = toMap(DATA.googleKind);
  const GOOGLE_ATTRS = toMap(DATA.googleAttrs);
  const GOOGLE_RE = /^(phone|email|address|website|organization) ?(\p{Nd}+) ?- ?([^\n]+)$/u;
  const HEADER_WS_RE = new RegExp("[" + PY_WS_CLASS + "_]+", "gu");

  function normalizeHeader(name) {
    name = name.normalize("NFKC").replace(/\ufeff/g, "");
    name = pyLower(pyStrip(stripChars(pyStrip(name), "\"'")));
    name = pyStrip(rstripChars(name.replace(HEADER_WS_RE, " "), ".:"));
    return name.split("e-mail").join("email");
  }

  const stripNumbers = (name) => pySplit(name).filter((word) => !pyIsDigit(word)).join(" ");

  function makeColumn(kind, attr, types, index) {
    let group = [];
    if (kind === "tel" || kind === "email" || kind === "url") group = [kind, "column", index];
    else if (kind === "adr") group = ["adr"].concat(types);
    return { kind, attr, group, types };
  }

  function classifyHeader(header, index) {
    const name = normalizeHeader(header);
    if (!name) return null;
    const match = GOOGLE_RE.exec(name);
    if (match) {
      const [, section, number, sub] = match;
      const attrs = GOOGLE_ATTRS.get(section);
      const key = pyStrip(sub);
      if (!hasOwn(attrs, key)) return null;
      const kind = GOOGLE_KIND.get(section);
      if (kind === "org") return { kind: "org", attr: attrs[key], group: [], types: [] };
      return { kind, attr: attrs[key], group: [kind, "google", number], types: [] };
    }
    for (const candidate of new Set([name, stripNumbers(name)])) {
      let hit = SIMPLE_COLUMNS.get(candidate);
      if (hit) return makeColumn(hit[0], hit[1], hit[2], index);
      const [word, , rest] = partition(candidate, " ");
      hit = SIMPLE_COLUMNS.get(rest);
      if (TYPE_PREFIXES.has(word) && hit && ["tel", "email", "adr"].includes(hit[0])) {
        return makeColumn(hit[0], hit[1], TYPE_PREFIXES.get(word).concat(hit[2]), index);
      }
    }
    return null;
  }

  function typesFromLabel(label, kind) {
    const text = pyLower(cleanText(label));
    const types = [];
    for (const [type, words, kinds] of DATA.labelTypes) {
      if (kinds.includes(kind) && words.some((word) => text.includes(word))) types.push(type);
    }
    if (text.startsWith("*")) types.push("PREF"); // Google ทำเครื่องหมายค่าหลักด้วย "* "
    return types;
  }

  // ---------------------------------------------------------------------------
  // ข้อมูลผู้ติดต่อและการสร้าง vCard
  // ---------------------------------------------------------------------------

  const dedupe = (types) => Array.from(new Set(types));

  function newContact() {
    return {
      full_name: "", given: "", family: "", middle: "", prefix: "", suffix: "", nickname: "",
      org: "", dept: "", title: "", phones: [], emails: [], addresses: [], urls: [], birthday: "", note: "",
    };
  }

  function displayName(contact) {
    const structured = [contact.prefix, contact.given, contact.middle, contact.family, contact.suffix]
      .filter((part) => part).join(" ");
    return contact.full_name || structured || contact.nickname || contact.org ||
      (contact.emails.length ? contact.emails[0][0] : "") || (contact.phones.length ? contact.phones[0][0] : "");
  }

  function buildAddress(fields, types) {
    const part = (name, multiline) => (fields.get(name) || [])
      .map((value) => cleanText(value, multiline)).filter((value) => value).join(", ");
    let street = part("street", true) || part("address", true);
    const subdistrict = part("subdistrict");
    if (subdistrict) street = pyStrip(`${street} ${subdistrict}`);
    const address = {
      types: types.filter((type) => type === "HOME" || type === "WORK" || type === "PREF"),
      components: [part("pobox"), part("extended"), street, part("city"), part("region"), part("postal"), part("country")],
    };
    // "Address N - Formatted" ของ Google ซ้ำกับส่วนย่อย จึงใช้เฉพาะเมื่อส่วนย่อยว่างทั้งหมด
    if (!address.components.some((value) => value)) address.components[2] = part("formatted", true);
    return address.components.some((value) => value) ? address : null;
  }

  function buildContact(row, columns, options, warn, line) {
    const contact = newContact();
    const groups = new Map();
    const notes = [];
    for (const [index, column] of columns) {
      // columns เรียงตาม index หยุดเมื่อเลยช่องสุดท้ายของแถว (ไม่เช่นนั้นเวลาเป็นกำลังสอง)
      if (index >= row.length) break;
      const raw = row[index];
      if (!pyStrip(raw)) continue;
      if (column.kind === "name" || column.kind === "org") {
        if (!contact[column.attr]) contact[column.attr] = cleanText(raw);
      } else if (column.kind === "bday") {
        if (!contact.birthday) {
          const birthday = normalizeBirthday(raw, options.dateOrder);
          if (birthday) contact.birthday = birthday;
          else warn(line, `ข้ามวันเกิดที่อ่านไม่ออก ${show(raw)} (ใช้รูปแบบ YYYY-MM-DD หรือ DD/MM/YYYY)`);
        }
      } else if (column.kind === "note") {
        const text = cleanText(raw, true);
        if (text) notes.push(text);
      } else {
        const key = JSON.stringify(column.group);
        if (!groups.has(key)) groups.set(key, [column, new Map()]);
        const fields = groups.get(key)[1];
        if (!fields.has(column.attr)) fields.set(column.attr, []);
        fields.get(column.attr).push(raw);
      }
    }
    contact.note = notes.join("\n");
    const seenPhones = new Set();
    const seenEmails = new Set();
    const seenUrls = new Set();
    for (const [column, fields] of groups.values()) {
      let types = column.types.slice();
      for (const label of fields.get("type") || []) types = types.concat(typesFromLabel(label, column.kind));
      types = dedupe(types);
      if (column.kind === "tel") {
        for (const raw of fields.get("value") || []) {
          for (const part of raw.split(PHONE_SPLIT_RE)) {
            const [phone, problem] = normalizePhone(part, options.countryCode);
            if (problem) warn(line, problem);
            if (phone) {
              const key = phone.replace(/[^0-9+,]/g, "");
              if (!seenPhones.has(key)) {
                seenPhones.add(key);
                contact.phones.push([phone, types]);
              }
            }
          }
        }
      } else if (column.kind === "email") {
        for (const raw of fields.get("value") || []) {
          for (const part of splitEmails(raw)) {
            const email = normalizeEmail(part);
            if (email === null) warn(line, `ข้ามอีเมลที่ไม่ถูกต้อง ${show(part)}`);
            else if (!seenEmails.has(pyLower(email))) {
              seenEmails.add(pyLower(email));
              contact.emails.push([email, types]);
            }
          }
        }
      } else if (column.kind === "url") {
        for (const raw of fields.get("value") || []) {
          for (const part of raw.split(":::")) {
            if (!pyStrip(part)) continue;
            const url = normalizeUrl(part);
            if (url === null) {
              warn(line, `ข้าม URL ที่ไม่ปลอดภัยหรือไม่ถูกต้อง ${show(part)} (รองรับเฉพาะ http/https)`);
            } else if (!seenUrls.has(url)) {
              seenUrls.add(url);
              contact.urls.push(url);
            }
          }
        }
      } else if (column.kind === "adr") {
        const address = buildAddress(fields, types);
        if (address) contact.addresses.push(address);
      }
    }
    if (!displayName(contact)) {
      warn(line, "ข้ามแถวนี้เพราะไม่มีชื่อ องค์กร เบอร์โทร หรืออีเมล");
      return null;
    }
    return contact;
  }

  function contentLine(name, value, types) {
    const head = name + (types && types.length ? ";TYPE=" + types.join(",") : "");
    return foldLine(`${head}:${value}`);
  }

  function contactToVcard(contact) {
    let nameParts = [contact.family, contact.given, contact.middle, contact.prefix, contact.suffix];
    // โทรศัพท์หลายรุ่นสร้างชื่อที่แสดงจาก N ไม่ใช่ FN
    if (!nameParts.some((part) => part) && contact.full_name) nameParts = ["", contact.full_name, "", "", ""];
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      contentLine("N", nameParts.map(escapeText).join(";")),
      contentLine("FN", escapeText(displayName(contact))),
    ];
    if (contact.nickname) lines.push(contentLine("NICKNAME", escapeText(contact.nickname)));
    if (contact.org || contact.dept) {
      lines.push(contentLine("ORG", escapeText(contact.org) + (contact.dept ? ";" + escapeText(contact.dept) : "")));
    }
    if (contact.title) lines.push(contentLine("TITLE", escapeText(contact.title)));
    // ค่าเบอร์โทรมีเฉพาะอักขระใน PHONE_ALLOWED
    for (const [phone, types] of contact.phones) lines.push(contentLine("TEL", phone, types));
    for (const [email, types] of contact.emails) lines.push(contentLine("EMAIL", escapeText(email), dedupe(["INTERNET"].concat(types))));
    for (const address of contact.addresses) lines.push(contentLine("ADR", address.components.map(escapeText).join(";"), address.types));
    // URL เป็นค่าชนิด URI (ไม่ใช่ TEXT) และ normalizeUrl ไม่รับช่องว่าง
    for (const url of contact.urls) lines.push(contentLine("URL", url));
    if (contact.birthday) lines.push(contentLine("BDAY", contact.birthday));
    if (contact.note) lines.push(contentLine("NOTE", escapeText(contact.note)));
    lines.push("END:VCARD");
    return lines.join("\r\n") + "\r\n";
  }

  // ---------------------------------------------------------------------------
  // ถอดรหัสไฟล์
  // ---------------------------------------------------------------------------

  const EXCEL_SIGNATURES = [[0x50, 0x4b, 0x03, 0x04], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]];
  const startsWithBytes = (data, prefix) => data.length >= prefix.length && prefix.every((byte, i) => data[i] === byte);

  function decodeError(encoding, position) {
    return new ConversionError(
      `ถอดรหัสไฟล์ด้วย ${encoding} ไม่ได้ (ตำแหน่งไบต์ ${position}) ลองระบุ --encoding เช่น utf-8, cp874, tis-620, utf-16`);
  }

  // ตำแหน่งเริ่มต้นของลำดับไบต์ UTF-8 ที่ผิดตัวแรก (ตามตาราง 3-7 ของ Unicode เหมือน Python)
  function utf8ErrorPosition(data) {
    for (let i = 0; i < data.length; ) {
      const lead = data[i];
      if (lead < 0x80) {
        i++;
        continue;
      }
      let need;
      let lo = 0x80;
      let hi = 0xbf;
      if (lead >= 0xc2 && lead <= 0xdf) need = 1;
      else if (lead === 0xe0) { need = 2; lo = 0xa0; }
      else if ((lead >= 0xe1 && lead <= 0xec) || lead === 0xee || lead === 0xef) need = 2;
      else if (lead === 0xed) { need = 2; hi = 0x9f; }
      else if (lead === 0xf0) { need = 3; lo = 0x90; }
      else if (lead >= 0xf1 && lead <= 0xf3) need = 3;
      else if (lead === 0xf4) { need = 3; hi = 0x8f; }
      else return i;
      for (let k = 1; k <= need; k++) {
        if (i + k >= data.length) return i;
        const byte = data[i + k];
        if (k === 1 ? byte < lo || byte > hi : byte < 0x80 || byte > 0xbf) return i;
      }
      i += need + 1;
    }
    return -1;
  }

  function decodeUtf8(data, offset, name) {
    const body = data.subarray(offset);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch (error) {
      throw decodeError(name, utf8ErrorPosition(body) + offset);
    }
  }

  function decodeUtf16(data, name) {
    let littleEndian = true;
    let start = 0;
    if (data[0] === 0xff && data[1] === 0xfe) start = 2;
    else if (data[0] === 0xfe && data[1] === 0xff) { littleEndian = false; start = 2; }
    const unitAt = (i) => (littleEndian ? data[i] | (data[i + 1] << 8) : (data[i] << 8) | data[i + 1]);
    for (let i = start; i < data.length; i += 2) {
      if (i + 1 >= data.length) throw decodeError(name, i);
      const unit = unitAt(i);
      if (unit >= 0xdc00 && unit <= 0xdfff) throw decodeError(name, i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (i + 3 >= data.length) throw decodeError(name, i);
        const low = unitAt(i + 2);
        if (low < 0xdc00 || low > 0xdfff) throw decodeError(name, i);
        i += 2;
      }
    }
    return new TextDecoder(littleEndian ? "utf-16le" : "utf-16be", { ignoreBOM: true }).decode(data.subarray(start));
  }

  function decodeSingleByte(data, name) {
    const table = DATA.codecs[name];
    const chunks = [];
    const buffer = new Uint16Array(8192);
    for (let i = 0; i < data.length; i += buffer.length) {
      const size = Math.min(buffer.length, data.length - i);
      for (let k = 0; k < size; k++) {
        const byte = data[i + k];
        const code = byte < 0x80 ? byte : table[byte - 0x80];
        if (code === null) throw decodeError(name, i + k);
        buffer[k] = code;
      }
      chunks.push(String.fromCharCode.apply(null, buffer.subarray(0, size)));
    }
    return chunks.join("");
  }

  function decodeWith(data, encoding) {
    if (encoding === "utf-8") return decodeUtf8(data, 0, encoding);
    if (encoding === "utf-8-sig") return decodeUtf8(data, startsWithBytes(data, [0xef, 0xbb, 0xbf]) ? 3 : 0, encoding);
    if (encoding === "utf-16") return decodeUtf16(data, encoding);
    if (hasOwn(DATA.codecs, encoding)) return decodeSingleByte(data, encoding);
    throw new ConversionError(`ไม่รู้จัก encoding ${show(encoding)}`);
  }

  function decodeCsvBytes(data, encoding) {
    if (encoding === undefined) encoding = "auto";
    if (EXCEL_SIGNATURES.some((signature) => startsWithBytes(data, signature))) {
      throw new ConversionError('ไฟล์นี้เป็นไฟล์ Excel (.xlsx/.xls) หรือไฟล์บีบอัด ไม่ใช่ CSV ให้เปิดใน Excel แล้วบันทึกเป็น "CSV UTF-8" ก่อน');
    }
    if (encoding !== "auto") return [decodeWith(data, encoding), encoding];
    if (startsWithBytes(data, [0xef, 0xbb, 0xbf])) return [decodeWith(data, "utf-8-sig"), "utf-8-sig"];
    if (startsWithBytes(data, [0xff, 0xfe]) || startsWithBytes(data, [0xfe, 0xff])) return [decodeWith(data, "utf-16"), "utf-16"];
    try {
      return [decodeWith(data, "utf-8"), "utf-8"];
    } catch (error) {
      return [decodeWith(data, "cp874"), "cp874"];
    }
  }

  // ---------------------------------------------------------------------------
  // อ่าน CSV (port จากตัวอ่าน C ของ Python: csv.reader(..., strict=True) อ่านทีละบรรทัดแบบ newline="")
  // ---------------------------------------------------------------------------

  class CsvError extends Error {}
  const START_RECORD = 0;
  const START_FIELD = 1;
  const IN_FIELD = 2;
  const IN_QUOTED_FIELD = 3;
  const QUOTE_IN_QUOTED_FIELD = 4;
  const EAT_CRNL = 5;
  const EOL = null;

  class CsvReader {
    constructor(text, delimiter) {
      this.text = text;
      this.delimiter = delimiter;
      this.pos = 0;
      this.lineNum = 0;
      this.lineEnd = /\r\n|\r|\n/g;
    }

    // คืนแถวถัดไป หรือ null เมื่อหมดไฟล์
    next() {
      this.fields = [];
      this.field = "";
      this.fieldLen = 0;
      this.state = START_RECORD;
      do {
        if (this.pos >= this.text.length) {
          if (this.fieldLen !== 0 || this.state === IN_QUOTED_FIELD) throw new CsvError("unexpected end of data");
          return null;
        }
        this.lineEnd.lastIndex = this.pos;
        const found = this.lineEnd.exec(this.text);
        const end = found ? found.index + found[0].length : this.text.length;
        const line = this.text.slice(this.pos, end);
        this.pos = end;
        this.lineNum++;
        for (const ch of line) this.process(ch);
        this.process(EOL);
      } while (this.state !== START_RECORD);
      return this.fields;
    }

    addChar(ch) {
      if (this.fieldLen >= DATA.fieldLimit) throw new CsvError(`field larger than field limit (${DATA.fieldLimit})`);
      this.field += ch;
      this.fieldLen++;
    }

    saveField() {
      this.fields.push(this.field);
      this.field = "";
      this.fieldLen = 0;
    }

    process(c) {
      const newline = c === "\n" || c === "\r";
      switch (this.state) {
        case START_RECORD:
          if (c === EOL) return;
          if (newline) {
            this.state = EAT_CRNL;
            return;
          }
          this.state = START_FIELD;
        // falls through
        case START_FIELD:
          if (newline || c === EOL) {
            this.saveField();
            this.state = c === EOL ? START_RECORD : EAT_CRNL;
          } else if (c === '"') {
            this.state = IN_QUOTED_FIELD;
          } else if (c === this.delimiter) {
            this.saveField();
          } else {
            this.addChar(c);
            this.state = IN_FIELD;
          }
          return;
        case IN_FIELD:
          if (newline || c === EOL) {
            this.saveField();
            this.state = c === EOL ? START_RECORD : EAT_CRNL;
          } else if (c === this.delimiter) {
            this.saveField();
            this.state = START_FIELD;
          } else {
            this.addChar(c);
          }
          return;
        case IN_QUOTED_FIELD:
          if (c === EOL) return;
          if (c === '"') this.state = QUOTE_IN_QUOTED_FIELD;
          else this.addChar(c);
          return;
        case QUOTE_IN_QUOTED_FIELD:
          if (c === '"') {
            this.addChar(c);
            this.state = IN_QUOTED_FIELD;
          } else if (c === this.delimiter) {
            this.saveField();
            this.state = START_FIELD;
          } else if (newline || c === EOL) {
            this.saveField();
            this.state = c === EOL ? START_RECORD : EAT_CRNL;
          } else {
            throw new CsvError(`'${this.delimiter}' expected after '"'`);
          }
          return;
        case EAT_CRNL:
          if (newline) return;
          if (c === EOL) this.state = START_RECORD;
          else throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
          return;
      }
    }
  }

  function translateCsvError(message) {
    if (message.includes("field larger than field limit")) return `ข้อมูลในช่องเดียวยาวเกิน ${formatThousands(DATA.fieldLimit)} ตัวอักษร`;
    if (message.includes("unexpected end of data")) return 'ไฟล์จบกลางข้อมูล อาจมีเครื่องหมายคำพูด " ที่ไม่ได้ปิด';
    if (message.includes("expected after")) return 'มีข้อความต่อท้ายเครื่องหมายคำพูดปิด (ถ้าข้อความมี " ต้องเขียนเป็น "")';
    return escapeControls(message);
  }

  const SEP_HINT_RE = /^sep=([^\n])\r?\n/u;
  const QUOTED_RE = /"[^"]*"/g;

  function detectDelimiter(text) {
    // ไม่นับตัวคั่นที่อยู่ในเครื่องหมายคำพูด เช่น "Name, Full";Phone ใช้ ; เป็นตัวคั่น
    const header = text.split("\n", 1)[0].replace(QUOTED_RE, "");
    let best = DATA.delimiters[0];
    let bestCount = -1;
    for (const delimiter of DATA.delimiters) {
      const count = header.split(delimiter).length - 1;
      if (count > bestCount) {
        best = delimiter;
        bestCount = count;
      }
    }
    return bestCount ? best : ",";
  }

  function newStats() {
    return { rows: 0, written: 0, skipped: 0, ignoredColumns: [] };
  }

  const blankRow = (row) => !row.some((cell) => pyStrip(cell));

  // แปลงข้อความ CSV เป็นรายการ vCard (เหมือน iter_vcards ของ Python)
  function iterVcards(text, delimiter, options, warn, stats) {
    options = options || {};
    warn = warn || (() => {});
    stats = stats || newStats();
    if (text.includes("\x00")) {
      throw new ConversionError("ไฟล์มีอักขระ NUL อาจเป็นไฟล์ UTF-16 ที่ไม่มี BOM ลองระบุ --encoding utf-16-le");
    }
    if (text.startsWith("\ufeff")) text = text.slice(1);
    const hint = SEP_HINT_RE.exec(text); // บรรทัดแรก "sep=;" ของ Excel
    if (hint && DATA.delimiters.includes(hint[1])) {
      text = text.slice(hint[0].length);
      delimiter = delimiter || hint[1];
    }
    delimiter = delimiter || detectDelimiter(text);
    if (typeof delimiter !== "string" || codePointLength(delimiter) !== 1 || '"\r\n'.includes(delimiter)) {
      throw new ConversionError(`ตัวคั่นคอลัมน์ไม่ถูกต้อง ${show(String(delimiter))}`);
    }
    const reader = new CsvReader(text, delimiter);
    const cards = [];
    try {
      let header = [];
      for (let row = reader.next(); row !== null; row = reader.next()) {
        header = row;
        if (!blankRow(row)) break;
      }
      const columns = [];
      header.forEach((name, index) => {
        const column = classifyHeader(name, index);
        if (column) columns.push([index, column]);
        else if (pyStrip(name)) stats.ignoredColumns.push(name);
      });
      if (!columns.length) {
        const found = header.slice(0, 10).map((name) => show(name, 30)).join(", ") || "(ว่าง)";
        throw new ConversionError(
          `ไม่พบคอลัมน์ที่รู้จักในแถวหัวตาราง (เช่น Name, Phone, Email, ชื่อ, เบอร์โทร, อีเมล) หัวตารางที่พบ: ${found}`);
      }
      for (let row = reader.next(); row !== null; row = reader.next()) {
        if (blankRow(row)) continue;
        stats.rows++;
        const contact = buildContact(row, columns, options, warn, reader.lineNum);
        if (contact === null) {
          stats.skipped++;
          continue;
        }
        stats.written++;
        cards.push(contactToVcard(contact));
      }
    } catch (error) {
      if (error instanceof CsvError) {
        throw new ConversionError(`อ่านไฟล์ CSV ไม่ได้ที่บรรทัด ${reader.lineNum}: ${translateCsvError(error.message)}`);
      }
      throw error;
    }
    return cards;
  }

  // ---------------------------------------------------------------------------
  // แปลงไฟล์ทั้งไฟล์ (ผลลัพธ์รูปแบบเดียวกับ API ของ webapp.py)
  // ---------------------------------------------------------------------------

  function option(value) {
    const text = pyStrip(value === undefined || value === null ? "" : String(value));
    const prefix = codePointPrefix(text, 20);
    return prefix === null ? text : prefix;
  }

  function countryCodeArg(value) {
    value = lstripChars(pyStrip(asciiDigits(value)), "+");
    if (!/^[1-9][0-9]{0,2}$/.test(value)) throw new ConversionError("รหัสประเทศต้องเป็นตัวเลข 1-3 หลัก เช่น 66");
    return value;
  }

  function convert(data, settings) {
    settings = settings || {};
    let countryCode = option(settings.countryCode) || null;
    if (countryCode) countryCode = countryCodeArg(countryCode);
    const dateOrder = option(settings.dateOrder) || "dmy";
    if (dateOrder !== "dmy" && dateOrder !== "mdy") throw new ConversionError("ลำดับวันที่ต้องเป็น dmy หรือ mdy");
    const encoding = option(settings.encoding) || "auto";
    if (!DATA.encodings.includes(encoding)) throw new ConversionError("การเข้ารหัสอักขระที่เลือกไม่รองรับ");
    const delimiterName = option(settings.delimiter);
    if (!hasOwn(DATA.delimiterNames, delimiterName)) throw new ConversionError("ตัวคั่นคอลัมน์ที่เลือกไม่รองรับ");

    const warnings = [];
    let total = 0;
    const warn = (line, message) => {
      total++;
      if (warnings.length < DATA.maxWarnings) warnings.push({ line, message });
    };
    const stats = newStats();
    const [text, usedEncoding] = decodeCsvBytes(data, encoding);
    const vcf = iterVcards(text, DATA.delimiterNames[delimiterName], { countryCode, dateOrder }, warn, stats).join("");
    if (!stats.written) throw new ConversionError("ไม่มีรายชื่อที่แปลงได้เลย ตรวจสอบว่าไฟล์มีชื่อ เบอร์โทร หรืออีเมล");
    return {
      ok: true,
      vcf,
      contacts: stats.written,
      rows: stats.rows,
      skipped: stats.skipped,
      encoding: usedEncoding,
      warnings,
      warnings_total: total,
      // ชื่อคอลัมน์มาจากไฟล์ของผู้ใช้ จึง escape อักขระควบคุมและจำกัดความยาวก่อนแสดง
      ignored_columns: stats.ignoredColumns.slice(0, DATA.maxIgnoredColumns).map((name) => show(name, 40)),
      ignored_columns_total: stats.ignoredColumns.length,
    };
  }

  return {
    VERSION: DATA.version,
    ConversionError,
    convert,
    // ส่งออกฟังก์ชันย่อยไว้ให้เทสต์เทียบผลกับ Python ทีละฟังก์ชัน
    cleanText, escapeText, foldLine, show, escapeControls, asciiDigits, normalizePhone, splitEmails,
    normalizeEmail, normalizeUrl, normalizeBirthday, normalizeHeader, classifyHeader, typesFromLabel,
    decodeCsvBytes, detectDelimiter, iterVcards, countryCodeArg, pyStrip, pySplit, pyLower,
  };
});
