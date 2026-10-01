/*
 * PdfActualText — อ่านข้อความแทน (/ActualText) ของ marked content ในไฟล์ PDF ซึ่ง PDF.js ไม่ส่งออกมา
 *
 * ทำไมต้องมี: ไฟล์ PDF จาก Chrome/Android (พิมพ์เป็น PDF), Word และโปรแกรมอื่นหลายตัว วาดสระ/วรรณยุกต์ไทยด้วยรูปอักษร
 * แบบพิเศษ (เช่น วรรณยุกต์ที่ลดระดับลงเมื่อไม่มีสระบน) ที่ไม่มีรหัส Unicode ในฟอนต์ แล้วใส่ข้อความที่ถูกต้องของกลุ่มอักษรนั้น
 * ไว้ใน /Span << /ActualText (...) >> BDC … EMC แทน — PDF.js ให้ข้อความเป็น "\0" สำหรับรูปอักษรเหล่านั้น
 * (เช่น "ที่" → "ที\0") ถ้าไม่ใช้ ActualText วรรณยุกต์จะหายไป
 *
 *   PdfActualText.create(getBytes) → reader
 *     getBytes() → Promise<Uint8Array>  ข้อมูลไฟล์ PDF ทั้งไฟล์ (เรียกเมื่อจำเป็นครั้งเดียว)
 *   reader.forPage(ref) → Promise<Array<{ tag, text }> | null>
 *     ref: { num, gen } ของหน้า (PDFPageProxy.ref) — ผลคือ marked content ทุกอัน (BMC/BDC) ตามลำดับเดียวกับที่
 *     PDF.js ส่งใน getTextContent({ includeMarkedContent: true }) พร้อม ActualText (null ถ้าไม่มี)
 *     null = อ่านไม่ได้ (ไฟล์เข้ารหัส, ตัวกรองที่ไม่รองรับ, โครงสร้างเสีย) — ผู้เรียกต้องตรวจว่าจำนวนและ tag ตรงกับ PDF.js
 *     ก่อนใช้ทุกครั้ง ถ้าไม่ตรงห้ามใช้
 *
 * ตัวอ่าน PDF ขนาดเล็กในไฟล์นี้อ่านเฉพาะที่ต้องใช้: หาวัตถุด้วยการสแกน "N G obj" (และ object stream),
 * คลายการบีบอัด FlateDecode ด้วย DecompressionStream ของเบราว์เซอร์, แยก token ของ content stream และฟอร์ม XObject
 * ทุกขั้นมีเพดาน (ขนาด, จำนวน, ความลึก) — ข้อมูลในไฟล์เป็นข้อมูลที่ไม่น่าเชื่อถือ ไม่มีการรันโค้ดใด ๆ จากไฟล์
 */
(function () {
  'use strict';

  var MAX_STREAM_BYTES = 64 * 1024 * 1024;   // content stream หนึ่งอันหลังคลายการบีบอัด
  var MAX_MARKERS = 200000;                  // marked content ต่อหน้า
  var MAX_FORM_DEPTH = 8;
  var MAX_NESTING = 64;                      // array/dict ซ้อนกัน
  var MAX_SEARCH_BYTES = 512 * 1024 * 1024;  // รวมที่ค้นหา "endstream" เองทั้งไฟล์ (สตรีมที่ /Length ผิด)
  var MAX_OBJSTM_BYTES = 256 * 1024 * 1024;  // รวม object stream ที่คลายแล้วทั้งไฟล์
  var MAX_FORM_CALLS = 10000;                // Do ของฟอร์มต่อหน้า
  // รวมข้อมูลที่ไล่ต่อหน้า (ฟอร์มที่ถูกเรียกซ้ำนับทุกครั้ง) เท่ากับ content stream อันเดียวที่ใหญ่ที่สุดที่รับได้
  // ไม่งั้นฟอร์มเล็ก ๆ ที่คลายแล้วใหญ่ (zip bomb) ถูกเรียกซ้ำได้ถึง MAX_FORM_CALLS ครั้ง จนหน้าเว็บค้างเป็นชั่วโมง
  var MAX_WALK_BYTES = MAX_STREAM_BYTES;
  // เพดานจำนวน token: ไฟล์ที่อัด token เล็ก ๆ ไว้แน่น (เช่น "0 0 m " ซ้ำ) ไม่เกินเพดานไบต์ แต่แยก token นานหลายสิบวินาที
  // และโค้ดนี้ทำงานในหน้าเว็บ (หน้าค้าง) — หน้าเอกสารจริงที่ซับซ้อนมากมีราว 1 ล้าน token
  var MAX_WALK_TOKENS = 2000000;             // ต่อหน้า
  var MAX_HEAVY_PAGES = 3;                   // หน้าที่เกินเพดานข้างบนกี่หน้าแล้วเลิกอ่านทั้งไฟล์ (ทุกหน้าเรียกฟอร์มหนักอันเดียวกัน)
  var MAX_DOC_TOKENS = 60000000;             // รวมทุกหน้า (หนังสือ 500 หน้าจริงใช้ราว 25 ล้าน) — ชั้นสุดท้ายถ้าทุกหน้าหนักเกือบถึงเพดาน
  var YIELD_EVERY = 0x3FFFF;                 // คืนเวลาให้หน้าเว็บทุก ~260,000 token (ปุ่มยกเลิก/ความคืบหน้ายังทำงาน)

  function isWS(c) { return c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09 || c === 0x0C || c === 0x00; }
  function isDelim(c) {
    return c === 0x28 || c === 0x29 || c === 0x3C || c === 0x3E || c === 0x5B || c === 0x5D ||
      c === 0x7B || c === 0x7D || c === 0x2F || c === 0x25;
  }
  function isDigit(c) { return c >= 0x30 && c <= 0x39; }
  function latin1(b, s, e) {
    var out = '';
    for (var i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)));
    return out;
  }
  function fail(msg) { throw new Error('ActualText: ' + msg); }

  // ------------------------------------------------------------------ lexer / values

  function Lexer(b, pos, end, noRefs) {
    this.b = b; this.p = pos || 0; this.end = end == null ? b.length : end; this.noRefs = !!noRefs;
  }
  Lexer.prototype.skipWS = function () {
    var b = this.b;
    while (this.p < this.end) {
      var c = b[this.p];
      if (isWS(c)) this.p++;
      else if (c === 0x25) { while (this.p < this.end && b[this.p] !== 0x0A && b[this.p] !== 0x0D) this.p++; }
      else break;
    }
  };
  Lexer.prototype.literal = function () {
    var b = this.b, out = [], depth = 1;
    this.p++;
    while (this.p < this.end) {
      var c = b[this.p++];
      if (c === 0x5C) {
        var e = b[this.p++];
        if (e === 0x6E) out.push(10); else if (e === 0x72) out.push(13); else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8); else if (e === 0x66) out.push(12);
        else if (e === 0x0D) { if (b[this.p] === 0x0A) this.p++; }      // \ + EOL: ต่อบรรทัด
        else if (e === 0x0A) { /* ต่อบรรทัด */ }
        else if (e >= 0x30 && e <= 0x37) {
          var v = e - 0x30;
          for (var k = 0; k < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37; k++) v = v * 8 + (b[this.p++] - 0x30);
          out.push(v & 0xFF);
        } else if (e !== undefined) out.push(e);
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return new Uint8Array(out);
  };
  Lexer.prototype.hex = function () {
    var b = this.b, out = [], hi = -1;
    this.p++;
    while (this.p < this.end) {
      var c = b[this.p++];
      if (c === 0x3E) break;
      var v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return new Uint8Array(out);
  };
  /** token ถัดไป: { t: 'num'|'name'|'str'|'kw'|'['|']'|'<<'|'>>'|'{'|'}'|'?', v } หรือ null เมื่อหมด */
  Lexer.prototype.next = function () {
    this.skipWS();
    if (this.p >= this.end) return null;
    var b = this.b, c = b[this.p];
    if (c === 0x2F) {
      var s = '';
      this.p++;
      while (this.p < this.end && !isWS(b[this.p]) && !isDelim(b[this.p])) {
        var ch = b[this.p++];
        if (ch === 0x23 && this.p + 1 < this.end) {
          var h = parseInt(String.fromCharCode(b[this.p], b[this.p + 1]), 16);
          if (!isNaN(h)) { s += String.fromCharCode(h); this.p += 2; continue; }
        }
        s += String.fromCharCode(ch);
      }
      return { t: 'name', v: s };
    }
    if (c === 0x28) return { t: 'str', v: this.literal() };
    if (c === 0x3C) {
      if (b[this.p + 1] === 0x3C) { this.p += 2; return { t: '<<' }; }
      return { t: 'str', v: this.hex() };
    }
    if (c === 0x3E) {
      if (b[this.p + 1] === 0x3E) { this.p += 2; return { t: '>>' }; }
      this.p++;
      return { t: '?' };
    }
    if (c === 0x5B || c === 0x5D || c === 0x7B || c === 0x7D) { this.p++; return { t: String.fromCharCode(c) }; }
    if (c === 0x29) { this.p++; return { t: '?' }; }
    var start = this.p;
    while (this.p < this.end && !isWS(b[this.p]) && !isDelim(b[this.p])) this.p++;
    var word = latin1(b, start, this.p);
    // ห้ามใช้ \d+\.?\d* — backtrack แบบกำลังสองกับตัวเลขยาว ๆ ที่ตามด้วยอักขระอื่น (ไฟล์ที่จงใจสร้างทำให้หน้าเว็บค้าง)
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(word)) return { t: 'num', v: parseFloat(word) };
    return { t: 'kw', v: word };
  };
  /** ค่าของ PDF ที่เริ่มด้วย token tok: number, { name }, { str }, array, dict (ไม่มี prototype), { ref, gen }, { kw } */
  Lexer.prototype.value = function (tok, depth) {
    depth = depth || 0;
    if (!tok) return undefined;
    if (depth > MAX_NESTING) fail('nesting');
    switch (tok.t) {
      case 'num':
        if (!this.noRefs && Number.isInteger(tok.v) && tok.v >= 0) {
          var save = this.p, t2 = this.next();
          if (t2 && t2.t === 'num' && Number.isInteger(t2.v)) {
            var t3 = this.next();
            if (t3 && t3.t === 'kw' && t3.v === 'R') return { ref: tok.v, gen: t2.v };
          }
          this.p = save;
        }
        return tok.v;
      case 'name': return { name: tok.v };
      case 'str': return { str: tok.v };
      case '[': {
        var arr = [];
        for (;;) {
          var t = this.next();
          if (!t || t.t === ']') break;
          arr.push(this.value(t, depth + 1));
        }
        return arr;
      }
      case '<<': {
        var d = Object.create(null);
        for (;;) {
          var k = this.next();
          if (!k || k.t === '>>') break;
          if (k.t !== 'name') continue;
          d[k.v] = this.value(this.next(), depth + 1);
        }
        return d;
      }
      case 'kw':
        return tok.v === 'true' ? true : tok.v === 'false' ? false : tok.v === 'null' ? null : { kw: tok.v };
      default:
        return null;
    }
  };

  function isDict(v) { return v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === null; }

  /** ข้อความ PDF (text string): UTF-16BE (BOM FE FF), UTF-8 (BOM EF BB BF) หรือ PDFDocEncoding (≈ Latin-1) */
  function textString(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      var s = '';
      for (var i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    return latin1(bytes, 0, bytes.length);
  }

  async function inflate(data) {
    var ds = new DecompressionStream('deflate');
    var reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    var parts = [], total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > MAX_STREAM_BYTES) { try { reader.cancel(); } catch (e) { /* ignore */ } fail('stream too large'); }
      parts.push(r.value);
    }
    var out = new Uint8Array(total), p = 0;
    parts.forEach(function (x) { out.set(x, p); p += x.length; });
    return out;
  }

  // ------------------------------------------------------------------ document

  function Doc(bytes) {
    this.b = bytes;
    this.offsets = new Map();      // "num gen" → offset ของ "num gen obj"
    this.cache = new Map();
    this.objStm = null;            // num → { data, at } จาก object stream (โหลดเมื่อจำเป็น)
    this.searchBudget = MAX_SEARCH_BYTES;
    this.tokens = 0;               // token ที่ไล่ไปแล้วรวมทุกหน้า (เพดาน MAX_DOC_TOKENS)
    this.heavyPages = 0;           // หน้าที่เกินเพดาน token ต่อหน้า (เพดาน MAX_HEAVY_PAGES)
    if (this.isEncrypted()) fail('encrypted');
    this.scan();
  }

  Doc.prototype.isEncrypted = function () {
    // trailer (หรือ xref stream) ที่มี /Encrypt — สตรีมถูกเข้ารหัส อ่านเองไม่ได้
    var b = this.b, tail = latin1(b, Math.max(0, b.length - 4096), b.length);
    if (/\/Encrypt\s/.test(tail)) return true;
    var head = latin1(b, 0, Math.min(b.length, 4096));
    return /\/Encrypt\s+\d+\s+\d+\s+R/.test(head);
  };

  /** หาตำแหน่ง "N G obj" ทั้งไฟล์ — อันหลังทับอันก่อน (incremental update) */
  Doc.prototype.scan = function () {
    var b = this.b, n = b.length;
    for (var i = 1; i + 3 <= n; i++) {
      if (b[i] !== 0x6F || b[i + 1] !== 0x62 || b[i + 2] !== 0x6A) continue;
      if (i + 3 < n && !isWS(b[i + 3]) && !isDelim(b[i + 3])) continue;
      var j = i - 1;
      if (!isWS(b[j])) continue;
      while (j >= 0 && isWS(b[j])) j--;
      var ge = j;
      while (j >= 0 && isDigit(b[j])) j--;
      if (j === ge || ge - j > 5 || j < 0 || !isWS(b[j])) continue;
      var gen = +latin1(b, j + 1, ge + 1);
      while (j >= 0 && isWS(b[j])) j--;
      var ne = j;
      while (j >= 0 && isDigit(b[j])) j--;
      if (j === ne || ne - j > 10 || (j >= 0 && !isWS(b[j]) && !isDelim(b[j]))) continue;
      this.offsets.set(latin1(b, j + 1, ne + 1) + ' ' + gen, i + 3);
    }
  };

  /** วัตถุ num gen: ค่า หรือ { dict, start, end } สำหรับ stream */
  Doc.prototype.get = async function (num, gen) {
    var key = num + ' ' + gen;
    if (this.cache.has(key)) return this.cache.get(key);
    var val;
    var off = this.offsets.get(key);
    if (off != null) {
      var lx = new Lexer(this.b, off);
      val = lx.value(lx.next());
      if (isDict(val)) {
        var save = lx.p, t = lx.next();
        if (t && t.t === 'kw' && t.v === 'stream') {
          var p = lx.p;
          if (this.b[p] === 0x0D) p++;
          if (this.b[p] === 0x0A) p++;
          var len = await this.resolve(val.Length);
          var end = typeof len === 'number' && len >= 0 && p + len <= this.b.length ? p + len : -1;
          if (end < 0 || latin1(this.b, end, Math.min(this.b.length, end + 12)).indexOf('endstream') < 0) {
            end = this.find('endstream', p);
            if (end < 0) fail('no endstream');
          }
          val = { dict: val, start: p, end: end };
        } else {
          lx.p = save;
        }
      }
    } else if (gen === 0) {
      val = await this.fromObjStm(num);
    }
    this.cache.set(key, val);
    return val;
  };

  Doc.prototype.find = function (word, from) {
    var b = this.b, w = [];
    for (var k = 0; k < word.length; k++) w.push(word.charCodeAt(k));
    var stop = Math.min(b.length, from + MAX_STREAM_BYTES);
    outer: for (var i = from; i + w.length <= stop; i++) {
      if (--this.searchBudget < 0) fail('search budget');
      for (var m = 0; m < w.length; m++) if (b[i + m] !== w[m]) continue outer;
      return i;
    }
    return -1;
  };

  Doc.prototype.resolve = async function (v, depth) {
    depth = depth || 0;
    while (v && typeof v === 'object' && typeof v.ref === 'number') {
      if (++depth > 32) fail('reference loop');
      v = await this.get(v.ref, v.gen);
    }
    return v;
  };

  Doc.prototype.decode = async function (stream) {
    if (!stream || !isDict(stream.dict)) fail('not a stream');
    var filters = await this.resolve(stream.dict.Filter);
    var parms = await this.resolve(stream.dict.DecodeParms);
    if (filters && !Array.isArray(filters)) filters = [filters];
    if (parms && !Array.isArray(parms)) parms = [parms];
    var data = this.b.subarray(stream.start, stream.end);
    for (var i = 0; filters && i < filters.length; i++) {
      var f = await this.resolve(filters[i]);
      var parm = parms && await this.resolve(parms[i]);
      if (!f || (f.name !== 'FlateDecode' && f.name !== 'Fl')) fail('filter ' + (f && f.name));
      if (isDict(parm) && typeof parm.Predictor === 'number' && parm.Predictor > 1) fail('predictor');
      data = await inflate(data);
    }
    if (data.length > MAX_STREAM_BYTES) fail('stream too large');
    return data;
  };

  /** วัตถุที่เก็บใน object stream (PDF 1.5) — อ่าน object stream ทั้งหมดครั้งแรกที่ต้องใช้ */
  Doc.prototype.fromObjStm = async function (num) {
    if (!this.objStm) {
      this.objStm = new Map();
      var self = this, keys = Array.from(this.offsets.keys()), total = 0;
      for (var k = 0; k < keys.length; k++) {
        var off = this.offsets.get(keys[k]);
        if (latin1(this.b, off, Math.min(this.b.length, off + 400)).indexOf('/ObjStm') < 0) continue;
        var parts = keys[k].split(' ');
        var stm = await this.get(+parts[0], +parts[1]);
        if (!stm || !isDict(stm.dict) || !stm.dict.Type || stm.dict.Type.name !== 'ObjStm') continue;
        var data;
        try { data = await self.decode(stm); } catch (e) { continue; }
        total += data.length;
        if (total > MAX_OBJSTM_BYTES) break;
        var first = await this.resolve(stm.dict.First), n = await this.resolve(stm.dict.N);
        if (typeof first !== 'number' || typeof n !== 'number') continue;
        var lx = new Lexer(data, 0, Math.min(first, data.length), true);
        for (var i = 0; i < n && i < 100000; i++) {
          var a = lx.next(), o = lx.next();
          if (!a || !o || a.t !== 'num' || o.t !== 'num') break;
          if (!this.objStm.has(a.v)) this.objStm.set(a.v, { data: data, at: first + o.v });
        }
      }
    }
    var e = this.objStm.get(num);
    if (!e || e.at >= e.data.length) return undefined;
    var lx2 = new Lexer(e.data, e.at);
    return lx2.value(lx2.next());
  };

  Doc.prototype.dictOf = async function (v) {
    v = await this.resolve(v);
    return isDict(v) ? v : v && isDict(v.dict) ? v.dict : null;
  };

  /** Resources ของหน้า (สืบทอดจาก Pages ต้นทางได้) */
  Doc.prototype.pageResources = async function (page) {
    for (var node = page, i = 0; node && i < 32; i++) {
      if (node.Resources) return this.dictOf(node.Resources);
      node = await this.dictOf(node.Parent);
    }
    return null;
  };

  Doc.prototype.contentData = async function (contents) {
    contents = await this.resolve(contents);
    var list = Array.isArray(contents) ? contents : contents ? [contents] : [];
    var parts = [], total = 0;
    for (var i = 0; i < list.length; i++) {
      var s = await this.resolve(list[i]);
      if (!s || !isDict(s.dict)) continue;
      var d = await this.decode(s);
      total += d.length + 1;
      if (total > MAX_STREAM_BYTES) fail('content too large');
      parts.push(d);
    }
    var out = new Uint8Array(total), p = 0;
    parts.forEach(function (x) { out.set(x, p); p += x.length; out[p++] = 0x0A; });
    return out;
  };

  /** ไล่ content stream แบบเดียวกับ PDF.js getTextContent: BMC/BDC ตามลำดับ และเข้าไปในฟอร์ม XObject (Do) */
  Doc.prototype.walk = async function (data, resources, out, depth, chain, calls) {
    calls = calls || { n: 0, bytes: 0, tokens: 0, limit: MAX_WALK_TOKENS };
    calls.bytes += data.length;
    if (calls.bytes > MAX_WALK_BYTES) fail('page too large');
    var lx = new Lexer(data, 0, data.length, true);
    var ops = [];
    for (;;) {
      var tok = lx.next();
      if (!tok) break;
      if (++calls.tokens > calls.limit) fail('page too complex');
      if ((calls.tokens & YIELD_EVERY) === 0) await new Promise(function (r) { setTimeout(r, 0); });
      if (tok.t !== 'kw') {
        ops.push(lx.value(tok));
        if (ops.length > 10000) ops = [];
        continue;
      }
      var op = tok.v;
      if (op === 'BI') {
        // ภาพ inline: ข้ามข้อมูลไบนารีจนถึง EI ที่มีช่องว่างคั่น
        var id = -1;
        for (var q = lx.p; q + 2 <= data.length; q++) {
          if (data[q] === 0x49 && data[q + 1] === 0x44 && isWS(data[q - 1] | 0) && (q + 2 === data.length || isWS(data[q + 2]))) { id = q + 3; break; }
        }
        if (id < 0) break;
        var ei = -1;
        for (var r = id; r + 2 <= data.length; r++) {
          if (data[r] === 0x45 && data[r + 1] === 0x49 && isWS(data[r - 1]) && (r + 2 === data.length || isWS(data[r + 2]) || isDelim(data[r + 2]))) { ei = r + 2; break; }
        }
        if (ei < 0) break;
        lx.p = ei;
      } else if (op === 'BMC') {
        out.push({ tag: ops.length && ops[0] && typeof ops[0].name === 'string' ? ops[0].name : null, text: null });
      } else if (op === 'BDC') {
        var tag = ops.length >= 2 && ops[0] && typeof ops[0].name === 'string' ? ops[0].name : null;
        var props = ops.length >= 2 ? ops[1] : null;
        if (props && typeof props.name === 'string') {
          var table = resources && await this.dictOf(resources.Properties);
          props = table ? await this.dictOf(table[props.name]) : null;
        } else {
          props = isDict(props) ? props : null;
        }
        var at = props ? await this.resolve(props.ActualText) : null;
        out.push({ tag: tag, text: at && at.str ? textString(at.str) : null });
      } else if (op === 'Do' && depth < MAX_FORM_DEPTH && ops.length && ops[0] && typeof ops[0].name === 'string') {
        if (++calls.n > MAX_FORM_CALLS) fail('too many forms');
        var xobjs = resources && await this.dictOf(resources.XObject);
        var ref = xobjs && xobjs[ops[0].name];
        var key = ref && typeof ref.ref === 'number' ? ref.ref + ' ' + ref.gen : null;
        if (ref && (!key || chain.indexOf(key) < 0)) {
          var form = await this.resolve(ref);
          if (form && isDict(form.dict) && form.dict.Subtype && form.dict.Subtype.name === 'Form') {
            var formRes = form.dict.Resources ? await this.dictOf(form.dict.Resources) : resources;
            await this.walk(await this.decode(form), formRes, out, depth + 1, key ? chain.concat([key]) : chain, calls);
          }
        }
      }
      if (out.length > MAX_MARKERS) fail('too many marked contents');
      ops = [];
    }
  };

  function create(getBytes) {
    var docPromise = null;
    function doc() {
      if (!docPromise) {
        docPromise = Promise.resolve().then(getBytes).then(function (bytes) { return new Doc(bytes); });
      }
      return docPromise;
    }
    var reader = {
      lastError: null,
      forPage: async function (ref) {
        try {
          if (!ref || typeof ref.num !== 'number') return null;
          var d = await doc();
          if (d.tokens >= MAX_DOC_TOKENS || d.heavyPages >= MAX_HEAVY_PAGES) fail('document too complex');
          var page = await d.dictOf({ ref: ref.num, gen: ref.gen || 0 });
          if (!page) return null;
          var out = [];
          var calls = { n: 0, bytes: 0, tokens: 0, limit: Math.min(MAX_WALK_TOKENS, MAX_DOC_TOKENS - d.tokens) };
          try {
            await d.walk(await d.contentData(page.Contents), await d.pageResources(page), out, 0, [], calls);
          } finally {
            d.tokens += calls.tokens;
            if (calls.tokens > calls.limit) d.heavyPages++;
          }
          return out;
        } catch (e) {
          reader.lastError = e && e.message ? e.message : String(e); // ไฟล์เข้ารหัส/รูปแบบที่ไม่รองรับ — ผู้เรียกใช้ข้อความจาก PDF.js ตามเดิม
          return null;
        }
      }
    };
    return reader;
  }

  window.PdfActualText = { create: create, _textString: textString };
})();
