/*
 * หน้าลบพื้นหลังรูปภาพ: เปิดรูป → โมเดล AI (js/ai-worker.js) ทำหน้ากากวัตถุ → ปรับขอบ/แก้ด้วยแปรง → ดาวน์โหลด
 * ทุกอย่างทำงานในเบราว์เซอร์ รูปไม่ถูกส่งออกนอกเครื่อง (CSP ของหน้าอนุญาตเฉพาะไฟล์จากเว็บนี้)
 */
(function () {
  'use strict';

  var C = window.BgCore;

  var UA = navigator.userAgent || '';
  // Android (รวมโหมด "เว็บไซต์เดสก์ท็อป" ที่ UA เป็น Linux แต่จอสัมผัส) — Firefox บน Android ล่มเมื่อ accept มีนามสกุลไฟล์
  var ANDROID = /Android/i.test(UA) ||
    (/Linux/i.test(UA) && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  var IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/i.test(UA) && navigator.maxTouchPoints > 1);
  var MOBILE = ANDROID || IOS;

  var MAX_FILE_BYTES = 60 * 1024 * 1024;
  var MAX_DECODE_PIXELS = 100e6;              // ภาพใหญ่กว่านี้ไม่เปิดเลย (หน่วยความจำไม่พอ)
  var MAX_PIXELS = MOBILE ? 12e6 : 16.7e6;    // ขนาดที่ประมวลผล/ส่งออก — ใหญ่กว่านี้ย่อก่อน
  var MAX_SIDE = MOBILE ? 6000 : 8192;        // canvas ด้านยาวเกินนี้บางเบราว์เซอร์วาดไม่ได้
  var MODEL_KEY = 'bg-remove:model';          // localStorage ใช้ร่วมกับทุกแอปใต้ envburiramclub.github.io — เก็บแค่โหมดที่เลือก
  var ACCEPT_DESKTOP = 'image/*,.jpg,.jpeg,.jfif,.png,.bmp,.webp,.heic,.heif,.svg,.ico,.gif,.tif,.tiff';
  var NATIVE_TYPE = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif' };
  var FORMAT_NAME = { jpeg: 'JPEG', png: 'PNG', gif: 'GIF', bmp: 'BMP', webp: 'WebP', ico: 'ICO', avif: 'AVIF', heif: 'HEIC/HEIF', tiff: 'TIFF', svg: 'SVG' };

  var S = {
    busy: false,
    name: '',
    model: 'isnet',
    width: 0,
    height: 0,
    src: null,        // ImageData ของภาพต้นฉบับ (ขนาดที่ประมวลผล)
    out: null,        // ImageData ของผลลัพธ์ (RGB ต้นฉบับ + ความทึบใหม่)
    base: null,       // ความทึบจากโมเดล (ขยายเป็นขนาดภาพแล้ว)
    orig: null,       // ความทึบเดิมของภาพ (รูปที่โปร่งใสอยู่แล้ว)
    edits: null,      // การแก้ด้วยแปรง: 0 = ตามโมเดล, 1 = ลบ, 2 = คืน
    lut: null,
    bg: 'transparent',
    tool: 'none',
    undo: [],
    comparing: false
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function toast(message, kind) {
    var box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 6000 : 3500);
  }

  function userError(message) {
    var e = new Error(message);
    e.userMessage = message;
    return e;
  }

  function errorText(e) {
    return String((e && (e.userMessage || e.message)) || e || 'เกิดข้อผิดพลาด').slice(0, 300);
  }

  function setStatus(text, opts) {
    opts = opts || {};
    $('status-text').textContent = text;
    var bar = $('status-progress');
    if (typeof opts.progress === 'number') { bar.classList.remove('hidden'); bar.value = Math.round(opts.progress * 100); }
    else bar.classList.add('hidden');
    $('status').classList.toggle('error', !!opts.error);
    $('status').classList.toggle('done', !!opts.done);
  }

  // ---------------------------------------------------------------- Workers

  function makeWorker(url) {
    var w = new Worker(url);
    var jobs = {};
    var nextId = 1;
    var api = {
      alive: true,
      request: function (msg, transfer, onProgress) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          jobs[id] = { resolve: resolve, reject: reject, progress: onProgress };
          msg.id = id;
          w.postMessage(msg, transfer || []);
        });
      },
      terminate: function () {
        api.alive = false;
        try { w.terminate(); } catch (e) { /* ignore */ }
        failAll('ยกเลิกแล้ว');
      }
    };
    function failAll(message, crashed) {
      var pending = jobs;
      jobs = {};
      Object.keys(pending).forEach(function (k) {
        var e = new Error(message);
        e.crashed = !!crashed;
        pending[k].reject(e);
      });
    }
    w.onmessage = function (e) {
      var m = e.data || {};
      var job = jobs[m.id];
      if (!job) return;
      if (m.type === 'progress') { if (job.progress) job.progress(m); return; }
      delete jobs[m.id];
      if (m.error) job.reject(userError(m.error));
      else job.resolve(m);
    };
    w.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      api.alive = false;
      try { w.terminate(); } catch (err) { /* ignore */ }
      // worker ล่ม (มักเป็นหน่วยความจำไม่พอ)
      failAll((e && e.message) || 'ตัวประมวลผลหยุดทำงาน (หน่วยความจำอาจไม่พอ)', true);
    };
    return api;
  }

  var aiWorker = null;
  var decodeWorker = null;
  var decodeIdle = null;

  var aiIdle = null;

  function ai() {
    clearTimeout(aiIdle);
    if (!aiWorker || !aiWorker.alive) aiWorker = makeWorker('js/ai-worker.js');
    return aiWorker;
  }

  /** ปิด worker ของโมเดลเมื่อว่าง 60 วินาที — คืนหน่วยความจำ (IS-Net ~1.2 GB) ให้มือถือ รูปถัดไปโหลดโมเดลจากแคชใหม่ */
  function aiDone() {
    clearTimeout(aiIdle);
    aiIdle = setTimeout(function () { if (aiWorker && !S.busy) { aiWorker.terminate(); aiWorker = null; } }, 60000);
  }

  function decoder() {
    clearTimeout(decodeIdle);
    if (!decodeWorker || !decodeWorker.alive) decodeWorker = makeWorker('js/decode-worker.js');
    return decodeWorker;
  }

  /** ปิด worker ถอดรหัสเมื่อว่าง 30 วินาที — นับหลังถอดรหัสเสร็จ (HEIC ใหญ่บนมือถือช้าอาจใช้เวลาเกิน 30 วินาที) */
  function decoderDone() {
    clearTimeout(decodeIdle);
    decodeIdle = setTimeout(function () { if (decodeWorker) { decodeWorker.terminate(); decodeWorker = null; } }, 30000);
  }

  // ---------------------------------------------------------------- เปิดรูป

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** วาดรูปลง canvas ขนาดที่ประมวลผลได้ → { canvas, original: [w, h] } */
  function imageToCanvas(img, w0, h0) {
    var w = w0 || img.naturalWidth, h = h0 || img.naturalHeight;
    if (!(w > 0 && h > 0)) throw userError('เปิดรูปนี้ไม่ได้ (ไม่ทราบขนาดภาพ)');
    if (w * h > MAX_DECODE_PIXELS) throw userError('ภาพใหญ่เกินไป (' + w + '×' + h + ' พิกเซล)');
    var fit = C.fitSize(w, h, MAX_PIXELS, MAX_SIDE);
    var c = newCanvas(fit.width, fit.height);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, fit.width, fit.height);
    return { canvas: c, original: [w, h] };
  }

  async function viaWorker(format, bytes) {
    var r;
    try {
      r = await decoder().request({
        type: 'decode', format: format, buffer: bytes.buffer, maxPixels: MAX_DECODE_PIXELS, fitPixels: MAX_PIXELS, maxSide: MAX_SIDE
      }, [bytes.buffer]);
    } finally {
      decoderDone();
    }
    if (!(r.width > 0 && r.height > 0) || !(r.data instanceof ArrayBuffer) || r.data.byteLength !== r.width * r.height * 4) {
      throw userError('ถอดรหัสรูปไม่สำเร็จ');
    }
    var c = newCanvas(r.width, r.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
    return { canvas: c, original: r.original || [r.width, r.height] };
  }

  /** อ่านไฟล์รูปทุกชนิดที่รองรับ → { canvas, original, format } */
  async function decodeFile(file) {
    if (!file.size) throw userError('ไฟล์ว่างเปล่า');
    if (file.size > MAX_FILE_BYTES) throw userError('ไฟล์ใหญ่เกิน ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB');
    var bytes = new Uint8Array(await file.arrayBuffer());
    var format = C.detectFormat(bytes);
    if (!format) throw userError('ไฟล์ "' + String(file.name || '').slice(0, 60) + '" ไม่ใช่รูปภาพที่รองรับ');
    var result;
    if (NATIVE_TYPE[format]) {
      var img;
      try { img = await loadImage(new Blob([bytes], { type: NATIVE_TYPE[format] })); } catch (e) {
        throw userError('เปิดรูป ' + FORMAT_NAME[format] + ' นี้ไม่ได้ ไฟล์อาจเสียหาย');
      }
      result = imageToCanvas(img);
    } else if (format === 'svg') {
      var text = new TextDecoder('utf-8').decode(bytes);
      var size = C.svgRenderSize(C.svgInfo(text), 1024, 2048);
      var fixed = C.svgWithSize(text, size.width, size.height);
      if (!fixed) throw userError('ไฟล์ SVG นี้อ่านไม่ได้');
      var svgImg;
      try { svgImg = await loadImage(new Blob([fixed], { type: 'image/svg+xml' })); } catch (e2) {
        throw userError('เปิดไฟล์ SVG นี้ไม่ได้ ไฟล์อาจเสียหาย');
      }
      result = imageToCanvas(svgImg, size.width, size.height);
    } else {
      // HEIC/TIFF: Safari เปิดเองได้ เบราว์เซอร์อื่นใช้ตัวถอดรหัสใน worker
      try {
        var nat = await loadImage(new Blob([bytes], { type: format === 'heif' ? 'image/heic' : 'image/tiff' }));
        result = imageToCanvas(nat);
      } catch (e3) {
        if (e3 && e3.userMessage) throw e3;
        result = await viaWorker(format, bytes);
      }
    }
    result.format = format;
    return result;
  }

  // ---------------------------------------------------------------- ลบพื้นหลัง

  /** ภาพขนาดอินพุตของโมเดล (วางบนพื้นขาว — ส่วนที่โปร่งใสอยู่แล้วไม่กลายเป็นสีดำ) */
  function modelInput(canvas, size) {
    var c = newCanvas(size, size);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, size, size);
    return ctx.getImageData(0, 0, size, size).data.buffer;
  }

  /** หน้ากากขนาด S×S → ความทึบขนาดภาพ (ขยายแบบนุ่มด้วย canvas) */
  function upscaleMask(mask, size, w, h) {
    var small = newCanvas(size, size);
    var img = new ImageData(size, size);
    for (var i = 0; i < mask.length; i++) {
      var v = mask[i], o = i * 4;
      img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    small.getContext('2d').putImageData(img, 0, 0);
    var big = newCanvas(w, h);
    var ctx = big.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    var out = new Uint8ClampedArray(w * h);
    for (var p = 0; p < out.length; p++) out[p] = data[p * 4];
    big.width = big.height = 0;
    return out;
  }

  function runModel(name, canvas) {
    var spec = C.model(name);
    var started = Date.now();
    var timer = setInterval(function () {
      setStatus('กำลังลบพื้นหลัง (' + spec.label + ')... ' + Math.round((Date.now() - started) / 1000) + ' วินาที');
    }, 1000);
    setStatus('กำลังเตรียมโมเดล ' + spec.label + '...');
    var input = modelInput(canvas, spec.size);
    return ai().request({ type: 'run', model: name, rgba: input }, [input], function (p) {
      if (p.stage === 'download') {
        setStatus('กำลังดาวน์โหลดโมเดล ' + spec.label + ' (ครั้งแรกเท่านั้น) ' +
          (p.loaded / 1048576).toFixed(1) + ' / ' + (p.total / 1048576).toFixed(1) + ' MB', { progress: p.total ? p.loaded / p.total : 0 });
      } else if (p.stage === 'load') {
        setStatus('กำลังเปิดโมเดล ' + spec.label + '...');
      } else if (p.stage === 'run') {
        started = Date.now();
        setStatus('กำลังลบพื้นหลัง (' + spec.label + ')...');
      }
    }).then(function (r) {
      clearInterval(timer);
      if (!(r.mask instanceof ArrayBuffer) || r.mask.byteLength !== spec.size * spec.size) throw userError('ผลของโมเดลไม่ถูกต้อง');
      return { mask: new Uint8ClampedArray(r.mask), size: spec.size, ms: r.ms };
    }, function (e) {
      clearInterval(timer);
      throw e;
    });
  }

  async function processFile(file) {
    if (S.busy) { toast('รอให้รูปก่อนหน้าเสร็จก่อน', 'error'); return; }
    S.busy = true;
    $('work-card').classList.remove('hidden');
    $('result').classList.add('hidden');
    setStatus('กำลังเปิดรูป ' + String(file.name || '').slice(0, 60) + '...');
    try {
      var decoded = await decodeFile(file);
      var canvas = decoded.canvas;
      var w = canvas.width, h = canvas.height;
      var name = S.model;
      var r;
      try {
        r = await runModel(name, canvas);
      } catch (e) {
        if (name !== 'isnet') throw e;
        // โหมดละเอียดใช้หน่วยความจำมาก — ไม่สำเร็จให้ลองโหมดเร็วอัตโนมัติ
        console.warn(e);
        if (aiWorker) { aiWorker.terminate(); aiWorker = null; }
        toast('โหมดละเอียดทำงานไม่สำเร็จ (' + errorText(e) + ') กำลังลองโหมดเร็ว', 'error');
        name = 'u2netp';
        r = await runModel(name, canvas);
      }
      setStatus('กำลังสร้างภาพผลลัพธ์...');
      var src = canvas.getContext('2d').getImageData(0, 0, w, h);
      var base = upscaleMask(r.mask, r.size, w, h);
      canvas.width = canvas.height = 0;
      showResult(file.name, src, base, {
        format: decoded.format, original: decoded.original, model: name, ms: r.ms
      });
    } catch (e) {
      if (!e || !e.userMessage) console.error(e);
      setStatus(errorText(e), { error: true });
    } finally {
      S.busy = false;
      aiDone();
    }
  }

  // ---------------------------------------------------------------- ผลลัพธ์

  function showResult(name, src, base, meta) {
    var w = src.width, h = src.height, n = w * h;
    S.name = String(name || 'image');
    S.width = w;
    S.height = h;
    S.src = src;
    S.base = base;
    S.orig = new Uint8Array(n);
    S.edits = new Uint8Array(n);
    S.undo = [];
    S.out = new ImageData(new Uint8ClampedArray(src.data), w, h);
    for (var i = 0; i < n; i++) S.orig[i] = src.data[i * 4 + 3];
    S.lut = C.edgeLut($('edge').value);
    var canvas = $('result-canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.classList.toggle('small', Math.max(w, h) < 200); // ไอคอนเล็ก: ขยายให้เห็นชัดแบบพิกเซล
    updateAlpha(0, 0, w, h);
    setTool('none');
    updateUndo();
    var info = FORMAT_NAME[meta.format] + ' ' + meta.original[0] + '×' + meta.original[1];
    if (meta.original[0] !== w) info += ' (ประมวลผลที่ ' + w + '×' + h + ')';
    info += ' · ' + C.model(meta.model).label + ' ' + (meta.ms / 1000).toFixed(1) + ' วินาที';
    $('info').textContent = info;
    setStatus('ลบพื้นหลังเรียบร้อย', { done: true });
    $('result').classList.remove('hidden');
    if (meta.format === 'gif') toast('ไฟล์ GIF ภาพเคลื่อนไหวใช้เฉพาะเฟรมแรก');
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** คำนวณความทึบใหม่ในกรอบ (x, y, w, h) แล้ววาดเฉพาะส่วนนั้น */
  function updateAlpha(x, y, w, h) {
    var W = S.width;
    var d = S.out.data, lut = S.lut, base = S.base, orig = S.orig, edits = S.edits;
    for (var yy = y; yy < y + h; yy++) {
      for (var xx = x, i = yy * W + x; xx < x + w; xx++, i++) {
        var e = edits[i];
        var a = e === 1 ? 0 : (e === 2 ? orig[i] : Math.min(orig[i], lut[base[i]]));
        d[i * 4 + 3] = a;
      }
    }
    if (!S.comparing) $('result-canvas').getContext('2d').putImageData(S.out, 0, 0, x, y, w, h);
  }

  function setBackground(bg) {
    S.bg = bg === 'transparent' ? 'transparent' : C.hexColor(bg);
    var stage = $('stage');
    stage.classList.toggle('checker', S.bg === 'transparent');
    stage.style.backgroundColor = S.bg === 'transparent' ? '' : S.bg;
    Array.prototype.forEach.call(document.querySelectorAll('#bg-swatches .swatch'), function (b) {
      var v = b.getAttribute('data-bg');
      b.classList.toggle('active', v ? v === S.bg : S.bg !== 'transparent' && !isPreset(S.bg));
    });
  }

  function isPreset(color) {
    return !!document.querySelector('#bg-swatches [data-bg="' + color + '"]');
  }

  // ---------------------------------------------------------------- แปรง

  function setTool(tool) {
    S.tool = tool === 'erase' || tool === 'restore' ? tool : 'none';
    Array.prototype.forEach.call(document.querySelectorAll('#tools .seg'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tool') === S.tool);
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tool') === S.tool));
    });
    $('stage').classList.toggle('painting', S.tool !== 'none');
  }

  function updateUndo() {
    $('btn-undo').disabled = !S.undo.length;
    var any = false;
    if (S.edits) for (var i = 0; i < S.edits.length; i += 97) if (S.edits[i]) { any = true; break; }
    $('btn-reset').disabled = !(any || S.undo.length);
  }

  // เก็บสถานะก่อนแต่ละเส้น ไม่เกิน ~64 MB (ภาพใหญ่เก็บได้น้อยครั้งกว่า)
  function pushUndo() {
    var limit = Math.max(3, Math.min(20, Math.floor(64e6 / S.edits.length)));
    S.undo.push(S.edits.slice());
    while (S.undo.length > limit) S.undo.shift();
  }

  function stamp(cx, cy, r, value) {
    var W = S.width, H = S.height;
    var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return null;
    var r2 = r * r;
    for (var y = y0; y <= y1; y++) {
      var dy = y + 0.5 - cy;
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) S.edits[y * W + x] = value;
      }
    }
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }

  var stroke = null;

  function imagePoint(e) {
    var rect = $('result-canvas').getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * S.width / rect.width,
      y: (e.clientY - rect.top) * S.height / rect.height,
      scale: S.width / rect.width
    };
  }

  function paintTo(p) {
    var r = Math.max(1, Number($('brush').value) / 2 * p.scale);
    var value = S.tool === 'erase' ? 1 : 2;
    var from = stroke.last || p;
    var dist = Math.hypot(p.x - from.x, p.y - from.y);
    var steps = Math.max(1, Math.ceil(dist / (r / 2)));
    var box = null;
    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var b = stamp(from.x + (p.x - from.x) * t, from.y + (p.y - from.y) * t, r, value);
      if (!b) continue;
      if (!box) box = b;
      else {
        var x0 = Math.min(box[0], b[0]), y0 = Math.min(box[1], b[1]);
        var x1 = Math.max(box[0] + box[2], b[0] + b[2]), y1 = Math.max(box[1] + box[3], b[1] + b[3]);
        box = [x0, y0, x1 - x0, y1 - y0];
      }
    }
    stroke.last = p;
    if (box) updateAlpha(box[0], box[1], box[2], box[3]);
  }

  function onPointerDown(e) {
    if (S.tool === 'none' || !S.edits || e.button > 0) return;
    e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pushUndo();
    stroke = { id: e.pointerId, last: null };
    paintTo(imagePoint(e));
  }

  function onPointerMove(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.preventDefault();
    paintTo(imagePoint(e));
  }

  function onPointerUp(e) {
    if (!stroke || e.pointerId !== stroke.id) return;
    stroke = null;
    updateUndo();
  }

  function undo() {
    if (!S.undo.length) return;
    S.edits = S.undo.pop();
    updateAlpha(0, 0, S.width, S.height);
    updateUndo();
  }

  function resetEdits() {
    if (!S.edits) return;
    pushUndo();
    S.edits.fill(0);
    updateAlpha(0, 0, S.width, S.height);
    updateUndo();
  }

  function compare(on) {
    if (!S.out || S.comparing === on) return;
    S.comparing = on;
    $('result-canvas').getContext('2d').putImageData(on ? S.src : S.out, 0, 0);
  }

  // ---------------------------------------------------------------- ดาวน์โหลด

  /** กรอบของวัตถุ (ความทึบ > 8) พร้อมขอบ 2% → [x, y, w, h] */
  function contentBox() {
    var W = S.width, H = S.height, d = S.out.data;
    var x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (var y = 0; y < H; y++) {
      for (var x = 0, i = y * W * 4 + 3; x < W; x++, i += 4) {
        if (d[i] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return [0, 0, W, H];
    var pad = Math.round(Math.max(W, H) * 0.02);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  function save(format) {
    if (!S.out) return;
    compare(false);
    var box = $('trim').checked ? contentBox() : [0, 0, S.width, S.height];
    var c = newCanvas(box[2], box[3]);
    var ctx = c.getContext('2d');
    var bg = S.bg !== 'transparent' ? S.bg : (format === 'jpeg' ? '#ffffff' : null);
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage($('result-canvas'), box[0], box[1], box[2], box[3], 0, 0, box[2], box[3]);
    var type = 'image/' + format;
    c.toBlob(function (blob) {
      c.width = c.height = 0;
      if (!blob) { toast('สร้างไฟล์ไม่สำเร็จ (ภาพอาจใหญ่เกินไป)', 'error'); return; }
      var ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
      if (format === 'webp' && ext !== 'webp') toast('เบราว์เซอร์นี้บันทึก WebP ไม่ได้ จึงบันทึกเป็น PNG แทน');
      download(blob, C.outputName(S.name, '-no-bg.' + ext));
      toast('ดาวน์โหลด ' + ext.toUpperCase() + ' เรียบร้อย', 'ok');
    }, type, 0.92);
  }

  // ---------------------------------------------------------------- เริ่มต้น

  function loadModelChoice() {
    var saved = null;
    try { saved = localStorage.getItem(MODEL_KEY); } catch (e) { /* ไม่อนุญาตให้ใช้ storage */ }
    // มือถือเริ่มที่โหมดเร็ว (โหมดละเอียดใช้หน่วยความจำ ~1.2 GB อาจทำให้แท็บปิดตัว)
    var lowMemory = MOBILE || (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4);
    S.model = C.model(saved) ? saved : (lowMemory ? 'u2netp' : 'isnet');
    var radio = document.querySelector('input[name="model"][value="' + S.model + '"]');
    if (radio) radio.checked = true;
  }

  function pick() {
    if (S.busy) { toast('รอให้รูปก่อนหน้าเสร็จก่อน', 'error'); return; }
    var input = $('file-input');
    input.value = '';
    input.click();
  }

  function firstImage(list) {
    for (var i = 0; list && i < list.length; i++) if (list[i]) return list[i];
    return null;
  }

  function init() {
    if (!C) return;
    if (typeof Worker !== 'function' || typeof WebAssembly !== 'object') {
      $('pick-card').appendChild(el('p', 'status-text', 'เบราว์เซอร์นี้ไม่รองรับการประมวลผลภาพ (ต้องใช้ Web Worker และ WebAssembly) กรุณาอัปเดตเบราว์เซอร์'));
      $('btn-pick').disabled = true;
      return;
    }
    // Firefox บน Android ล่มเมื่อ accept มีนามสกุล → มือถือใช้แค่ image/* คอมพิวเตอร์เพิ่มนามสกุลที่ระบบอาจไม่รู้จัก (.heic, .jfif)
    if (!ANDROID) $('file-input').setAttribute('accept', ACCEPT_DESKTOP);
    if (MOBILE) document.querySelector('.drop-hint').classList.add('hidden'); // มือถือไม่มี Ctrl+V
    loadModelChoice();

    $('btn-pick').addEventListener('click', function (e) { e.stopPropagation(); pick(); });
    $('dropzone').addEventListener('click', pick);
    $('btn-new').addEventListener('click', function () { $('pick-card').scrollIntoView({ behavior: 'smooth' }); pick(); });
    $('file-input').addEventListener('change', function (e) {
      var file = firstImage(e.target.files);
      e.target.value = '';
      if (file) processFile(file);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="model"]'), function (r) {
      r.addEventListener('change', function () {
        if (!r.checked || !C.model(r.value)) return;
        S.model = r.value;
        try { localStorage.setItem(MODEL_KEY, S.model); } catch (e) { /* ignore */ }
      });
    });

    // ลากวาง / วางจากคลิปบอร์ด
    var dz = $('dropzone');
    document.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) {
        e.preventDefault();
        dz.classList.add('over');
      }
    });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) dz.classList.remove('over'); });
    document.addEventListener('drop', function (e) {
      dz.classList.remove('over');
      var file = e.dataTransfer && firstImage(e.dataTransfer.files);
      if (!file) return;
      e.preventDefault();
      processFile(file);
    });
    document.addEventListener('paste', function (e) {
      var items = e.clipboardData ? e.clipboardData.items : [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); processFile(f); return; }
        }
      }
    });

    // เครื่องมือ
    Array.prototype.forEach.call(document.querySelectorAll('#bg-swatches [data-bg]'), function (b) {
      if (b.getAttribute('data-bg') !== 'transparent') b.style.backgroundColor = C.hexColor(b.getAttribute('data-bg'));
      b.addEventListener('click', function () { setBackground(b.getAttribute('data-bg')); });
    });
    $('bg-color').addEventListener('input', function (e) { setBackground(e.target.value); });
    $('edge').addEventListener('input', function (e) {
      if (!S.out) return;
      S.lut = C.edgeLut(e.target.value);
      updateAlpha(0, 0, S.width, S.height);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tools .seg'), function (b) {
      b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
    });
    $('btn-undo').addEventListener('click', undo);
    $('btn-reset').addEventListener('click', resetEdits);
    var canvas = $('result-canvas');
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    var cmp = $('btn-compare');
    cmp.addEventListener('pointerdown', function (e) { e.preventDefault(); compare(true); });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(function (ev) { cmp.addEventListener(ev, function () { compare(false); }); });
    cmp.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); compare(true); } });
    cmp.addEventListener('keyup', function () { compare(false); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-format]'), function (b) {
      b.addEventListener('click', function () { save(b.getAttribute('data-format')); });
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && S.out) {
        var tag = e.target && e.target.tagName;
        if (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'radio' && e.target.type !== 'checkbox') return;
        e.preventDefault();
        undo();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
