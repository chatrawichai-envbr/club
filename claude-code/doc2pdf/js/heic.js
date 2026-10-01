/*
 * HeicDecoder — ถอดรหัสรูป HEIC/HEIF (รูปจาก iPhone และมือถือ Android หลายรุ่น) ที่เบราว์เซอร์ถอดรหัสเองไม่ได้
 * (Chrome, Edge, Firefox และ WebView ของ Android — Safari ถอดรหัสเองได้ จึงไม่ต้องใช้)
 *
 *   HeicDecoder.isHeif(blob) → Promise<boolean>      ตรวจจากส่วนหัวไฟล์ (กล่อง ftyp) ไม่เชื่อชื่อ/ชนิดไฟล์
 *   HeicDecoder.decode(blob, maxPixels) → Promise<ImageData>
 *        error.code: 'too-large' (เกิน maxPixels) | 'not-heif'
 *   HeicDecoder.info() → { mode: 'worker' | 'inline' | null, decoded }   ใช้ตรวจสอบ/ทดสอบ
 *
 * ใช้ libheif (vendor/libheif, โหลดเมื่อต้องใช้เท่านั้น ~2 MB) ใน Web Worker (js/heic-worker.js) — หน้าจอไม่ค้าง
 * เปิดผ่าน file:// หรือเบราว์เซอร์ที่ใช้ Worker ไม่ได้ → ถอดรหัสในหน้าเว็บแทน
 * URL ของไฟล์ได้จาก window.AppPlatform เหมือนไลบรารีอื่น (ใช้โค้ดเดียวกันบน Apps Script และแอป Android)
 */
(function () {
  'use strict';

  var LIB = 'vendor/libheif/libheif-bundle.js';
  var WORKER_URL = 'js/heic-worker.js';
  var IDLE_MS = 30000;          // ปิด worker (คืนหน่วยความจำ ~50 MB) เมื่อไม่ได้ใช้
  var TIMEOUT_MS = 120000;
  // แบรนด์ของไฟล์ HEIF ที่มีภาพ HEVC (HEIC) — AVIF เบราว์เซอร์ถอดรหัสเองได้อยู่แล้ว
  var BRANDS = { heic: 1, heix: 1, hevc: 1, hevx: 1, heim: 1, heis: 1, hevm: 1, hevs: 1, mif1: 1, msf1: 1 };

  var worker = null, idleTimer = null, nextId = 1;
  var jobs = {};
  var inlineLib = null;
  var stats = { mode: null, decoded: 0 };

  function done(mode) {
    return function (img) { stats.mode = mode; stats.decoded++; return img; };
  }

  function platform() {
    if (!window.AppPlatform) throw new Error('ไม่พบ AppPlatform (js/boot.js)');
    return window.AppPlatform;
  }

  function codeError(message, code) {
    var e = new Error(message);
    if (code) e.code = code;
    return e;
  }

  /** ส่วนหัวไฟล์: [size][ftyp][major brand][minor][compatible brands...] */
  function isHeif(blob) {
    if (!blob || typeof blob.slice !== 'function' || blob.size < 12) return Promise.resolve(false);
    return blob.slice(0, 64).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      var str = function (i) { return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); };
      if (str(4) !== 'ftyp') return false;
      var size = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
      var end = Math.min(b.length, size >= 16 ? size : 16);
      if (BRANDS[str(8)]) return true;
      for (var i = 16; i + 4 <= end; i += 4) if (BRANDS[str(i)]) return true;
      return false;
    }, function () { return false; });
  }

  // ---------------------------------------------------------------- Worker

  /**
   * ยกเลิกทุกงานที่ค้างใน worker (worker ถูกปิดแล้ว)
   * blame: 'load' = โหลด worker ไม่ได้ → ให้ decode() ลองในหน้าเว็บ
   *        'crash' = worker ล่มระหว่างถอดรหัส → ไฟล์ที่กำลังถอดรหัส (งานเก่าสุด) ห้ามลองซ้ำ ไฟล์ที่รอคิวลองใหม่ใน worker ตัวใหม่
   *        'others' = ปิด worker เพราะไฟล์อื่นค้าง → ทุกงานที่เหลือลองใหม่ใน worker ตัวใหม่
   */
  function failAll(message, blame) {
    var pending = jobs;
    jobs = {};
    Object.keys(pending).map(Number).sort(function (a, b) { return a - b; }).forEach(function (id, i) {
      var job = pending[id];
      clearTimeout(job.timer); // ไม่งั้นครบเวลาภายหลังแล้วไปปิด worker ตัวใหม่
      var err = codeError(message);
      if (blame === 'crash' && i === 0) err.fromWorker = true;
      else if (blame !== 'load') err.retryWorker = true;
      job.reject(err);
    });
  }

  function stopWorker() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
    worker = null;
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { if (!Object.keys(jobs).length) stopWorker(); }, IDLE_MS);
  }

  function getWorker() {
    if (worker) return Promise.resolve(worker);
    return platform().resolve(WORKER_URL).then(function (url) {
      if (worker) return worker;
      var w = new Worker(url); // file:// ในบางเบราว์เซอร์โยน error → ใช้แบบในหน้าเว็บแทน
      w.onmessage = function (e) {
        var m = e.data || {};
        var job = m.type === 'result' && jobs[m.id];
        if (!job) return;
        delete jobs[m.id];
        clearTimeout(job.timer);
        touch();
        if (m.error) { var err = codeError(m.error, m.code); err.fromWorker = true; job.reject(err); }
        else if (!(m.width > 0 && m.height > 0) || !(m.data instanceof ArrayBuffer) || m.data.byteLength !== m.width * m.height * 4) {
          job.reject(codeError('ผลการถอดรหัส HEIC ไม่ถูกต้อง'));
        } else job.resolve(new ImageData(new Uint8ClampedArray(m.data), m.width, m.height));
      };
      w.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        stopWorker();
        // มีข้อความ = worker ทำงานแล้วล่มระหว่างถอดรหัส (เช่น หน่วยความจำไม่พอกับไฟล์นั้น) ห้ามถอดรหัสไฟล์เดิมซ้ำในหน้าเว็บ
        // ไม่งั้นแท็บค้าง/ล่มตาม — ไม่มีข้อความ = โหลดสคริปต์ worker ไม่ได้ → ให้ decode() ลองในหน้าเว็บแทน
        failAll((e && e.message) || 'ตัวถอดรหัส HEIC ทำงานผิดพลาด', e && e.message ? 'crash' : 'load');
      };
      worker = w;
      return w;
    });
  }

  function decodeInWorker(blob, maxPixels) {
    return Promise.all([blob.arrayBuffer(), platform().resolve(LIB, true), getWorker()]).then(function (r) {
      // worker อาจถูกปิดระหว่างรออ่านไฟล์ (ไฟล์อื่นทำให้ค้าง/ล่ม) — ส่งงานให้ worker ที่ปิดแล้วจะไม่มีคำตอบเลย
      return r[2] === worker ? r : getWorker().then(function (w) { r[2] = w; return r; });
    }).then(function (r) {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        var job = { resolve: resolve, reject: reject };
        job.timer = setTimeout(function () {
          delete jobs[id];
          stopWorker();
          failAll('ถอดรหัส HEIC ถูกยกเลิก', 'others');
          // worker ทำงานทีละไฟล์ตามลำดับ งานที่ครบเวลาก่อนคือไฟล์ที่ทำให้ค้าง — ห้ามลองซ้ำในหน้าเว็บ (หน้าเว็บจะค้างแทน)
          var err = codeError('ถอดรหัส HEIC นานเกินไป');
          err.fromWorker = true;
          reject(err);
        }, TIMEOUT_MS);
        jobs[id] = job;
        clearTimeout(idleTimer);
        r[2].postMessage({ type: 'decode', id: id, lib: r[1], buffer: r[0], maxPixels: maxPixels }, [r[0]]);
      });
    });
  }

  // ---------------------------------------------------------------- ในหน้าเว็บ (file://)

  var inlineChain = Promise.resolve();
  var inlineDecoder = null; // ใช้ตัวเดิม: decode ครั้งถัดไปคืนหน่วยความจำของไฟล์ก่อนเอง

  function decodeInline(blob, maxPixels) {
    var run = function () {
      return Promise.all([blob.arrayBuffer(), inlineLib || platform().loadScript(LIB, true).then(function () {
        if (typeof window.libheif !== 'function') throw codeError('โหลดตัวถอดรหัส HEIC ไม่สำเร็จ');
        inlineLib = Promise.resolve(window.libheif());
        return inlineLib;
      })]).then(function (r) {
        return Promise.resolve(inlineLib).then(function (lib) {
          if (!inlineDecoder) inlineDecoder = new lib.HeifDecoder();
          var images = inlineDecoder.decode(new Uint8Array(r[0])) || [];
          var free = function () { images.forEach(function (im) { try { im.free(); } catch (e) { /* ignore */ } }); };
          if (!images.length) { free(); throw codeError('ไม่ใช่ไฟล์ HEIC/HEIF ที่อ่านได้', 'not-heif'); }
          var w = images[0].get_width(), h = images[0].get_height();
          if (!(w > 0 && h > 0)) { free(); throw codeError('ขนาดภาพไม่ถูกต้อง'); }
          if (w * h > maxPixels) { free(); throw codeError('ภาพใหญ่เกินไป', 'too-large'); }
          var out = new ImageData(w, h);
          return new Promise(function (resolve, reject) {
            images[0].display(out, function (d) {
              free();
              if (d) resolve(out); else reject(codeError('ถอดรหัส HEIC ไม่สำเร็จ'));
            });
          });
        });
      });
    };
    var p = inlineChain.then(run, run);
    inlineChain = p.catch(function () { /* ignore */ });
    return p;
  }

  /** ถอดรหัสใน worker — ถ้า worker ถูกปิดเพราะไฟล์อื่น ลองใหม่ใน worker ตัวใหม่อีก 1 ครั้ง */
  function viaWorker(blob, maxPixels, retried) {
    return decodeInWorker(blob, maxPixels).catch(function (e) {
      if (e && e.retryWorker && !retried) return viaWorker(blob, maxPixels, true);
      throw e;
    });
  }

  function decode(blob, maxPixels) {
    var max = maxPixels > 0 ? maxPixels : 40e6;
    return isHeif(blob).then(function (ok) {
      if (!ok) throw codeError('ไม่ใช่ไฟล์ HEIC/HEIF', 'not-heif');
      if (typeof Worker !== 'function' || location.protocol === 'file:') return decodeInline(blob, max).then(done('inline'));
      return viaWorker(blob, max, false).then(done('worker'), function (e) {
        // ไฟล์เสีย/ใหญ่เกิน/ทำให้ worker ค้างหรือล่ม — ถอดรหัสในหน้าเว็บก็ไม่ได้เช่นกัน (และจะทำให้หน้าเว็บค้างแทน)
        if (e && (e.fromWorker || e.retryWorker)) throw e;
        // สร้าง/ใช้ worker ไม่ได้ (เช่น นโยบายของหน้าเว็บ) → ลองถอดรหัสในหน้าเว็บ
        console.warn('HEIC worker', e);
        return decodeInline(blob, max).then(done('inline'));
      });
    });
  }

  window.HeicDecoder = {
    isHeif: isHeif,
    decode: decode,
    info: function () { return { mode: stats.mode, decoded: stats.decoded }; }
  };
})();
