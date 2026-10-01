/*
 * BgCore — ฟังก์ชันล้วนของระบบลบพื้นหลัง (ไม่ยุ่งกับหน้าเว็บ ใช้ได้ทั้งหน้าเว็บ, Web Worker และ Node: tests/harness.js)
 *
 *   detectFormat(bytes)            ชนิดรูปจากเนื้อไฟล์ (ไม่เชื่อชื่อ/นามสกุลไฟล์)
 *   svgInfo(text) / svgWithSize()  ขนาดของ SVG และเขียนขนาดลงแท็ก <svg> (Firefox วาด SVG ที่ไม่มีขนาดลง canvas ไม่ได้)
 *   buildInput(rgba, model)        แปลงภาพขนาดอินพุตของโมเดลเป็น Float32 [1,3,S,S]
 *   maskToBytes(mask)              ผลของโมเดล → ความทึบ 0–255
 *   edgeLut(strength)              ตารางปรับความคมของขอบ
 *   fitSize(), outputName(), hexColor()
 */
(function (root) {
  'use strict';

  var MAX_NAME = 100;

  // โมเดล: file = path จากโฟลเดอร์ของระบบ, size = ด้านของภาพอินพุต, scale = วิธีหารค่าสี ('255' หรือ 'max' แบบ rembg)
  var MODELS = {
    isnet: {
      label: 'ละเอียด (IS-Net)',
      file: 'vendor/models/isnet/isnet-general-use-quint8.onnx',
      bytes: 44342436,
      size: 1024,
      scale: '255',
      mean: [0.5, 0.5, 0.5],
      std: [1, 1, 1]
    },
    u2netp: {
      label: 'เร็ว (U\u00B2-Netp)',
      file: 'vendor/models/u2netp/u2netp.onnx',
      bytes: 4574861,
      size: 320,
      scale: 'max',
      mean: [0.485, 0.456, 0.406],
      std: [0.229, 0.224, 0.225]
    }
  };

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function model(name) {
    return own(MODELS, name) ? MODELS[name] : null;
  }

  // ---------------------------------------------------------------- ชนิดไฟล์

  function ascii(b, start, len) {
    var s = '';
    for (var i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  var HEIF_BRANDS = { heic: 1, heix: 1, hevc: 1, hevx: 1, heim: 1, heis: 1, hevm: 1, hevs: 1 };
  var AVIF_BRANDS = { avif: 1, avis: 1 };

  /** กล่อง ftyp ของ HEIF/AVIF: [size][ftyp][major][minor][compatible...] → 'heif' | 'avif' | null */
  function ftypKind(b) {
    if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return null;
    var size = b[0] * 16777216 + (b[1] << 16) + (b[2] << 8) + b[3];
    var end = Math.min(b.length, Math.max(16, Math.min(size, 256)));
    var brands = [ascii(b, 8, 4)];
    for (var i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, 4));
    if (AVIF_BRANDS[brands[0]]) return 'avif';
    for (var j = 0; j < brands.length; j++) if (HEIF_BRANDS[brands[j]]) return 'heif';
    for (var k = 0; k < brands.length; k++) if (AVIF_BRANDS[brands[k]]) return 'avif';
    if (brands.indexOf('mif1') >= 0 || brands.indexOf('msf1') >= 0) return 'heif';
    return null;
  }

  /** ข้าม BOM, ช่องว่าง, <?xml ?>, คอมเมนต์ และ <!DOCTYPE> แล้วดูว่าเริ่มด้วย <svg หรือไม่ → ตำแหน่งของ <svg หรือ -1 */
  function svgStart(text) {
    var t = str(text);
    var i = 0;
    if (t.charCodeAt(0) === 0xfeff) i = 1;
    for (var guard = 0; guard < 64; guard++) {
      while (i < t.length && /\s/.test(t.charAt(i))) i++;
      if (t.startsWith('<?', i)) { var e1 = t.indexOf('?>', i); if (e1 < 0) return -1; i = e1 + 2; continue; }
      if (t.startsWith('<!--', i)) { var e2 = t.indexOf('-->', i); if (e2 < 0) return -1; i = e2 + 3; continue; }
      if (t.substr(i, 9).toUpperCase() === '<!DOCTYPE') { var e3 = doctypeEnd(t, i); if (e3 < 0) return -1; i = e3; continue; }
      break;
    }
    if (t.substr(i, 4).toLowerCase() !== '<svg') return -1;
    var next = t.charAt(i + 4);
    return next === '>' || next === '/' || /\s/.test(next) ? i : -1;
  }

  // <!DOCTYPE svg ... [ ... ]> อาจมี [] ภายใน
  function doctypeEnd(t, i) {
    var depth = 0;
    for (var j = i; j < t.length; j++) {
      var c = t.charAt(j);
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return j + 1;
    }
    return -1;
  }

  /** ชนิดรูปจากส่วนหัวไฟล์ → 'jpeg'|'png'|'gif'|'bmp'|'webp'|'heif'|'avif'|'tiff'|'ico'|'svg'|null */
  function detectFormat(bytes) {
    var b = bytes;
    if (!b || !b.length) return null;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b.length >= 8 && ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
    if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
    if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d) {
      var dib = b[14] | (b[15] << 8) | (b[16] << 16) | (b[17] << 24);
      if (dib === 12 || dib === 40 || dib === 52 || dib === 56 || dib === 64 || dib === 108 || dib === 124) return 'bmp';
    }
    if (b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) ||
        (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff';
    if (b.length >= 6 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && (b[4] | (b[5] << 8)) > 0) return 'ico';
    var ft = ftypKind(b);
    if (ft) return ft;
    // SVG เป็นข้อความ: ดูเฉพาะ 4 KB แรก
    var head = '';
    var n = Math.min(b.length, 4096);
    for (var i = 0; i < n; i++) head += String.fromCharCode(b[i]);
    if (head.charCodeAt(0) === 0xef && head.charCodeAt(1) === 0xbb && head.charCodeAt(2) === 0xbf) head = head.slice(3);
    return svgStart(head) >= 0 ? 'svg' : null;
  }

  // ---------------------------------------------------------------- SVG

  /** แท็ก <svg ...> ตัวแรก (ข้ามเครื่องหมายคำพูดในค่า attribute) → { start, end, attrs } หรือ null */
  function svgRoot(text) {
    var t = str(text);
    var start = svgStart(t);
    if (start < 0) return null;
    var quote = '';
    for (var i = start + 4; i < t.length && i < start + 20000; i++) {
      var c = t.charAt(i);
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return { start: start, end: i + 1, attrs: parseAttrs(t.slice(start + 4, t.charAt(i - 1) === '/' ? i - 1 : i)) };
    }
    return null;
  }

  function parseAttrs(s) {
    var attrs = {};
    // ชื่อ attribute ต้องขึ้นต้นหลังช่องว่าง — จุดเริ่มค้นมีเท่าจำนวนช่องว่าง regex จึงไม่ช้าแบบกำลังสองกับแท็กยาว ๆ
    var re = /\s([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var m;
    var count = 0;
    while ((m = re.exec(s)) && count++ < 500) {
      var name = m[1].toLowerCase();
      if (!own(attrs, name)) attrs[name] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
  }

  var UNIT_PX = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

  /** ความยาวของ SVG เป็นพิกเซล — % และหน่วยที่ไม่รู้จักคืน null */
  function svgLength(v) {
    var s = str(v).trim();
    if (!s || s.length > 40) return null;
    var m = /^([0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e([-+]?[0-9]{1,3}))?\s*(px|pt|pc|mm|cm|in)?$/i.exec(s);
    if (!m) return null;
    var n = Number(m[1]) * Math.pow(10, Number(m[2] || 0)) * UNIT_PX[(m[3] || '').toLowerCase()];
    return isFinite(n) && n > 0 ? n : null;
  }

  /** ขนาดของ SVG → { width, height, viewBox: [x,y,w,h] | null } (width/height เป็น null ถ้าไม่ได้ระบุ) */
  function svgInfo(text) {
    var r = svgRoot(text);
    if (!r) return null;
    var vb = null;
    if (own(r.attrs, 'viewbox')) {
      var p = r.attrs.viewbox.trim().split(/[\s,]+/).map(Number);
      if (p.length === 4 && p.every(isFinite) && p[2] > 0 && p[3] > 0) vb = p;
    }
    var w = own(r.attrs, 'width') ? svgLength(r.attrs.width) : null;
    var h = own(r.attrs, 'height') ? svgLength(r.attrs.height) : null;
    if (w && !h && vb) h = w * vb[3] / vb[2];
    if (h && !w && vb) w = h * vb[2] / vb[3];
    return { width: w, height: h, viewBox: vb };
  }

  /**
   * ขนาดที่จะวาด SVG (ด้านยาวอย่างน้อย minSide ไม่เกิน maxSide) — SVG ขยายได้ไม่เสียความคมชัด
   * ไม่มีทั้งขนาดและ viewBox → minSide × minSide
   */
  function svgRenderSize(info, minSide, maxSide) {
    var w = info && info.width, h = info && info.height;
    if (!(w && h) && info && info.viewBox) { w = info.viewBox[2]; h = info.viewBox[3]; }
    if (!(w > 0 && h > 0)) { w = minSide; h = minSide; }
    var long = Math.max(w, h);
    var s = long < minSide ? minSide / long : (long > maxSide ? maxSide / long : 1);
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
  }

  /**
   * เขียน width/height ใหม่ลงแท็ก <svg> (ลบของเดิม) และเติม viewBox ถ้าไม่มี (ให้ภาพขยายตาม ไม่ใช่แค่พื้นที่ว่างเพิ่ม)
   * ใช้กับข้อความ SVG ที่จะแสดงผ่าน <img> เท่านั้น (สคริปต์ใน SVG ไม่ทำงานใน <img>)
   */
  function svgWithSize(text, width, height) {
    var t = str(text);
    var r = svgRoot(t);
    if (!r) return null;
    var info = svgInfo(t);
    var tag = t.slice(r.start, r.end);
    var body = tag.slice(4); // หลัง "<svg"
    body = body.replace(/\s(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
    var extra = ' width="' + Math.round(width) + '" height="' + Math.round(height) + '"';
    if (!info.viewBox) {
      var w0 = info.width || width, h0 = info.height || height;
      extra += ' viewBox="0 0 ' + round3(w0) + ' ' + round3(h0) + '" preserveAspectRatio="none"';
    }
    return t.slice(0, r.start) + '<svg' + extra + body + t.slice(r.end);
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  // ---------------------------------------------------------------- โมเดล

  /**
   * ภาพ RGBA ขนาด S×S (พื้นหลังโปร่งใสถูกวางบนสีขาวแล้ว) → Float32Array [1,3,S,S] ตามที่โมเดลต้องการ
   * scale 'max' = หารด้วยค่าสีสูงสุดของทั้งภาพ (แบบ rembg กับ U²-Net), '255' = หารด้วย 255
   */
  function buildInput(rgba, spec) {
    var S = spec.size;
    var n = S * S;
    if (!rgba || rgba.length !== n * 4) throw new Error('ขนาดภาพอินพุตไม่ถูกต้อง');
    var div = 255;
    if (spec.scale === 'max') {
      div = 0;
      for (var i = 0; i < n * 4; i++) if ((i & 3) !== 3 && rgba[i] > div) div = rgba[i];
      if (!div) div = 1;
    }
    var out = new Float32Array(3 * n);
    for (var c = 0; c < 3; c++) {
      var mean = spec.mean[c], std = spec.std[c], base = c * n;
      for (var p = 0; p < n; p++) out[base + p] = (rgba[p * 4 + c] / div - mean) / std;
    }
    return out;
  }

  /** ผลของโมเดล (ค่าความน่าจะเป็น) → 0–255 ปรับช่วงต่ำสุด–สูงสุดแบบ rembg (ทั้งภาพเท่ากันหมด: ≥0.5 = วัตถุ) */
  function maskToBytes(mask) {
    var n = mask.length;
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < n; i++) {
      var v = mask[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var out = new Uint8ClampedArray(n);
    if (!(max - min > 1e-6)) {
      out.fill(min >= 0.5 ? 255 : 0);
      return out;
    }
    var k = 255 / (max - min);
    for (var j = 0; j < n; j++) out[j] = (mask[j] - min) * k + 0.5;
    return out;
  }

  /** ตารางความคมของขอบ: 0 = ตามโมเดล (ขอบนุ่ม), 100 = ตัดขาด/ขาดชัด */
  function edgeLut(strength) {
    var s = Math.min(100, Math.max(0, Number(strength) || 0)) / 100;
    var lo = s * 120, hi = 255 - s * 120;
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) lut[v] = Math.round((v - lo) * 255 / (hi - lo));
    return lut;
  }

  // ---------------------------------------------------------------- อื่น ๆ

  /** ย่อให้ไม่เกิน maxPixels และด้านยาวไม่เกิน maxSide (คงสัดส่วน) */
  function fitSize(width, height, maxPixels, maxSide) {
    var s = 1;
    if (width * height > maxPixels) s = Math.sqrt(maxPixels / (width * height));
    if (Math.max(width, height) * s > maxSide) s = maxSide / Math.max(width, height);
    return { width: Math.max(1, Math.floor(width * s)), height: Math.max(1, Math.floor(height * s)), scale: s };
  }

  /**
   * ย่อภาพ RGBA แบบเฉลี่ยพื้นที่ (ใช้ใน worker กับภาพ HEIC/TIFF ที่ใหญ่เกิน) — ทำงาน O(พิกเซลต้นฉบับ + ปลายทาง)
   * ขยายภาพไม่ได้ (dw, dh ต้องไม่เกินต้นฉบับ)
   */
  function resizeRGBA(src, sw, sh, dw, dh) {
    if (dw > sw || dh > sh || dw < 1 || dh < 1) throw new Error('ขนาดปลายทางไม่ถูกต้อง');
    var out = new Uint8ClampedArray(dw * dh * 4);
    var acc = new Float64Array(dw * 4);
    var cnt = new Float64Array(dw);
    var colOf = new Int32Array(sw);
    for (var x = 0; x < sw; x++) colOf[x] = Math.min(dw - 1, Math.floor(x * dw / sw));
    var dy = 0;
    for (var y = 0; y < sh; y++) {
      var row = Math.min(dh - 1, Math.floor(y * dh / sh));
      if (row !== dy) { flush(dy); dy = row; }
      var base = y * sw * 4;
      for (var sx = 0; sx < sw; sx++) {
        var d = colOf[sx], s = base + sx * 4;
        acc[d * 4] += src[s]; acc[d * 4 + 1] += src[s + 1]; acc[d * 4 + 2] += src[s + 2]; acc[d * 4 + 3] += src[s + 3];
        cnt[d]++;
      }
    }
    flush(dy);
    return out;

    function flush(r) {
      for (var i = 0; i < dw; i++) {
        var n = cnt[i] || 1, o = (r * dw + i) * 4;
        out[o] = acc[i * 4] / n; out[o + 1] = acc[i * 4 + 1] / n; out[o + 2] = acc[i * 4 + 2] / n; out[o + 3] = acc[i * 4 + 3] / n;
      }
      acc.fill(0);
      cnt.fill(0);
    }
  }

  /** ชื่อไฟล์ที่ดาวน์โหลด: ชื่อเดิม (ตัดนามสกุล) + suffix — ตัดโฟลเดอร์ อักขระควบคุม/กลับทิศ และอักขระต้องห้าม */
  function outputName(name, suffix) {
    var base = str(name).split(/[\\/]/).pop();
    var dot = base.lastIndexOf('.');
    if (dot > 0) base = base.slice(0, dot);
    base = base.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF<>:"|?*\\/]+/g, '_');
    base = base.replace(/^[\s.]+/, '');
    if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME);
    var end = base.length;
    while (end > 0 && /[\s.]/.test(base.charAt(end - 1))) end--;
    return (base.slice(0, end) || 'image') + str(suffix);
  }

  function hexColor(v, fallback) {
    var s = str(v).trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : (fallback === undefined ? '#ffffff' : fallback);
  }

  var api = {
    MODELS: MODELS,
    model: model,
    detectFormat: detectFormat,
    svgStart: svgStart,
    svgInfo: svgInfo,
    svgLength: svgLength,
    svgRenderSize: svgRenderSize,
    svgWithSize: svgWithSize,
    buildInput: buildInput,
    maskToBytes: maskToBytes,
    edgeLut: edgeLut,
    fitSize: fitSize,
    resizeRGBA: resizeRGBA,
    outputName: outputName,
    hexColor: hexColor
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BgCore = api;
})(typeof self !== 'undefined' ? self : this);
