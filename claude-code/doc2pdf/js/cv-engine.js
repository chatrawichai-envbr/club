/*
 * CvEngine — ตัวจัดการการประมวลผลภาพด้วย OpenCV.js
 *
 * โหมดการทำงาน (เลือกอัตโนมัติ เร็วที่สุดก่อน):
 *   1. Web Worker + OpenCV.js แบบ SIMD (เร็วที่สุด) — หลาย worker ประมวลผลหลายหน้าพร้อมกัน
 *   2. Web Worker + OpenCV.js แบบพื้นฐาน (เบราว์เซอร์ที่ไม่รองรับ WebAssembly SIMD)
 *   3. ประมวลผลในหน้าเว็บโดยตรง (เปิดไฟล์ผ่าน file:// หรือเบราว์เซอร์ที่ใช้ Worker ไม่ได้)
 * ไฟล์ OpenCV.js ทั้งหมดอยู่ในเว็บไซต์เดียวกัน (vendor/opencv) สร้างจากซอร์สทางการ OpenCV 4.10.0
 * ด้วย .github/workflows/opencv-build.yml — ไม่พึ่ง CDN ภายนอก
 * URL ของไฟล์ทั้งหมดได้จาก window.AppPlatform (js/boot.js) เพื่อให้ใช้โค้ดเดียวกันบน Google Apps Script ได้
 */
(function () {
  'use strict';

  var BUILDS = {
    simd: { script: 'vendor/opencv/simd/opencv.js', wasm: 'vendor/opencv/simd/opencv_js.wasm' },
    basic: { script: 'vendor/opencv/basic/opencv.js' } // ไฟล์เดียว (.wasm ฝังอยู่ใน .js)
  };
  var WORKER_URL = 'js/cv-worker.js';
  var CORE_URL = 'js/cv-core.js';
  var INIT_TIMEOUT_MS = 180000; // ไฟล์ขนาดใหญ่บนเน็ตมือถือช้าอาจใช้เวลานาน

  // โมดูล WebAssembly ขนาดเล็กที่ใช้คำสั่ง SIMD (ตรวจว่าเบราว์เซอร์รองรับหรือไม่)
  var SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

  var state = 'idle';            // idle | loading | ready | error
  var listeners = [];
  var mode = null;               // 'worker' | 'inline'
  var buildName = null;          // 'simd' | 'basic'
  var poolSize = 1;
  var workers = [];              // { worker, ready, busy, job }
  var spawning = false;
  var queue = { high: [], low: [] };
  var inlineScript = null;
  var generation = 0;            // เพิ่มค่าเมื่อเริ่มโหลดใหม่ เพื่อไม่สนผลจากรอบเก่า

  function platform() {
    if (!window.AppPlatform) throw new Error('ไม่พบ AppPlatform (js/boot.js)');
    return window.AppPlatform;
  }

  /** URL ของไฟล์ (Promise) — lib: ไลบรารีใน vendor/ */
  function resolve(path, lib) {
    try { return platform().resolve(path, lib); } catch (e) { return Promise.reject(e); }
  }

  function emit(s, detail) {
    state = s;
    listeners.forEach(function (fn) { try { fn(s, detail); } catch (e) { console.error(e); } });
  }

  function supportsSimd() {
    try { return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE); } catch (e) { return false; }
  }

  function computePoolSize() {
    var cores = navigator.hardwareConcurrency || 2;
    var mem = navigator.deviceMemory; // GB (มีเฉพาะ Chromium)
    var n = Math.max(1, Math.min(4, cores - 1));
    if (mem) n = mem <= 2 ? 1 : mem <= 4 ? Math.min(n, 2) : n;
    else n = Math.min(n, 2); // ไม่ทราบหน่วยความจำ: ใช้แบบประหยัด
    return n;
  }

  // ---------------------------------------------------------------------
  //  Worker pool
  // ---------------------------------------------------------------------

  function spawnWorker(build) {
    var entry = { worker: null, ready: false, busy: false, job: null, removed: false };
    var gen = generation;
    entry.whenReady = Promise.all([
      resolve(WORKER_URL), resolve(CORE_URL), resolve(build.script, true), build.wasm ? resolve(build.wasm, true) : null
    ]).then(function (urls) {
      if (entry.removed) throw new Error('ยกเลิกแล้ว');
      return startWorker(entry, gen, urls);
    });
    entry.whenReady.catch(function () { removeWorker(entry); });
    workers.push(entry);
    return entry;
  }

  function startWorker(entry, gen, urls) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker(urls[0]); } catch (e) { reject(e); return; }
      entry.worker = w;
      var timer = setTimeout(function () { reject(new Error('โหลด OpenCV นานเกินไป')); }, INIT_TIMEOUT_MS);
      w.onmessage = function (e) {
        var m = e.data || {};
        if (m.type === 'ready') { clearTimeout(timer); entry.ready = true; resolve(entry); }
        else if (m.type === 'init-error') { clearTimeout(timer); reject(new Error(m.message)); }
        else if (m.type === 'result' && gen === generation) onResult(entry, m);
      };
      w.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        clearTimeout(timer);
        var err = new Error((e && e.message) || 'Worker ทำงานผิดพลาด');
        if (!entry.ready) reject(err); else onCrash(entry, err);
      };
      w.postMessage({ type: 'init', core: urls[1], script: urls[2], wasm: urls[3] });
    });
  }

  function removeWorker(entry) {
    entry.removed = true;
    var i = workers.indexOf(entry);
    if (i >= 0) workers.splice(i, 1);
    try { if (entry.worker) entry.worker.terminate(); } catch (e) { /* ignore */ }
  }

  function onResult(entry, m) {
    var job = entry.job;
    entry.job = null;
    entry.busy = false;
    if (job) {
      if (m.error) job.reject(new Error(m.error)); else job.resolve(m.result);
    }
    if (m.fatal) recycle(entry);
    dispatch();
  }

  function onCrash(entry, err) {
    var job = entry.job;
    entry.job = null;
    if (job) job.reject(err);
    recycle(entry);
  }

  /** worker ที่หน่วยความจำเสียหาย/ล่ม: ปิดทิ้งแล้วสร้างใหม่ */
  function recycle(entry) {
    removeWorker(entry);
    if (!workers.length && state === 'ready') {
      var fresh = spawnWorker(BUILDS[buildName]);
      fresh.whenReady.then(dispatch, function () { failAll(new Error('ตัวประมวลผลภาพหยุดทำงาน')); });
    }
    dispatch();
  }

  function failAll(err) {
    ['high', 'low'].forEach(function (p) {
      while (queue[p].length) queue[p].shift().reject(err);
    });
  }

  function dispatch() {
    while (queue.high.length || queue.low.length) {
      var idle = null;
      for (var i = 0; i < workers.length; i++) {
        if (workers[i].ready && !workers[i].busy) { idle = workers[i]; break; }
      }
      if (!idle) { maybeGrow(); return; }
      var job = queue.high.shift() || queue.low.shift();
      idle.busy = true;
      idle.job = job;
      try {
        idle.worker.postMessage({ type: 'run', id: job.id, op: job.op, args: job.args }, job.transfer || []);
      } catch (e) {
        idle.busy = false;
        idle.job = null;
        job.reject(e);
      }
    }
  }

  /** มีงานรออยู่และ worker ไม่ว่าง: เปิด worker เพิ่ม (ทีละตัว ไม่เกิน poolSize) */
  function maybeGrow() {
    if (spawning || state !== 'ready' || mode !== 'worker' || workers.length >= poolSize) return;
    spawning = true;
    var entry = spawnWorker(BUILDS[buildName]);
    entry.whenReady.then(function () { spawning = false; dispatch(); },
      function () { spawning = false; poolSize = Math.max(1, workers.length); });
  }

  var nextId = 1;

  function run(op, args, transfer, priority) {
    if (state !== 'ready') return Promise.reject(new Error('ตัวประมวลผลภาพยังไม่พร้อม'));
    if (mode === 'inline') {
      return new Promise(function (resolve, reject) {
        try {
          var a = args;
          var r = op === 'detect' ? ScanCore.detect(a.img)
            : op === 'warp' ? ScanCore.warp(a.img, a.quad, a.outW, a.outH)
              : op === 'process' ? ScanCore.process(a.img, a.settings)
                : ScanCore.warpProcess(a.img, a.quad, a.outW, a.outH, a.settings);
          resolve(r);
        } catch (e) { reject(ScanCore.toError(e)); }
      });
    }
    return new Promise(function (resolve, reject) {
      queue[priority === 'high' ? 'high' : 'low'].push({
        id: nextId++, op: op, args: args, transfer: transfer, resolve: resolve, reject: reject
      });
      dispatch();
    });
  }

  // ---------------------------------------------------------------------
  //  โหมดประมวลผลในหน้าเว็บ (file:// หรือไม่มี Worker)
  // ---------------------------------------------------------------------

  function waitForWindowCv() {
    return new Promise(function (resolve, reject) {
      var c = window.cv;
      if (!c) { reject(new Error('ไม่พบ OpenCV')); return; }
      if (c instanceof Promise) { c.then(function (m) { window.cv = m; resolve(); }, reject); return; }
      // emscripten 2.x: `cv` เป็น thenable ที่ resolve เป็นตัวเอง ห้าม await ตรง ๆ
      var done = false;
      var finish = function () { if (!done && typeof window.cv.Mat === 'function') { done = true; clearInterval(timer); resolve(); } };
      var prev = c.onRuntimeInitialized;
      c.onRuntimeInitialized = function () { if (typeof prev === 'function') prev(); finish(); };
      var timer = setInterval(finish, 100);
      finish();
    });
  }

  function startInline() {
    mode = 'inline';
    buildName = 'basic';
    poolSize = 1;
    if (typeof window.cv === 'object' && window.cv && typeof window.cv.Mat === 'function') return Promise.resolve();
    if (inlineScript) inlineScript.remove();
    var loading;
    try { loading = platform().loadScript(BUILDS.basic.script, true); } catch (e) { loading = Promise.reject(e); }
    return loading.then(function (s) {
      inlineScript = s;
      return waitForWindowCv();
    });
  }

  function withTimeout(p, ms, message) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(message)); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function load() {
    if (state === 'loading' || state === 'ready') return;
    var gen = ++generation;
    emit('loading');
    var t0 = Date.now();

    var canUseWorker = typeof Worker === 'function' && location.protocol !== 'file:';
    var attempt;
    if (canUseWorker) {
      mode = 'worker';
      poolSize = computePoolSize();
      var order = supportsSimd() ? ['simd', 'basic'] : ['basic'];
      attempt = order.reduce(function (p, name) {
        return p.catch(function (prevErr) {
          if (prevErr) console.warn('OpenCV build "' + buildName + '" ใช้ไม่ได้:', prevErr.message);
          buildName = name;
          return spawnWorker(BUILDS[name]).whenReady;
        });
      }, Promise.reject(null)).catch(function (err) {
        console.warn('Web Worker ใช้ไม่ได้ เปลี่ยนเป็นประมวลผลในหน้าเว็บ:', err && err.message);
        return withTimeout(startInline(), INIT_TIMEOUT_MS, 'โหลด OpenCV นานเกินไป');
      });
    } else {
      attempt = withTimeout(startInline(), INIT_TIMEOUT_MS, 'โหลด OpenCV นานเกินไป');
    }

    attempt.then(function () {
      if (gen !== generation) return;
      emit('ready', { mode: mode, build: buildName, workers: poolSize, ms: Date.now() - t0 });
      dispatch();
    }, function (err) {
      if (gen !== generation) return;
      console.error('โหลด OpenCV ไม่สำเร็จ', err);
      emit('error', 'โหลดตัวประมวลผลภาพไม่สำเร็จ');
    });
  }

  function reset() {
    generation++;
    workers.slice().forEach(removeWorker);
    spawning = false;
    failAll(new Error('ตัวประมวลผลภาพถูกเริ่มใหม่'));
  }

  // ---------------------------------------------------------------------
  //  API ระดับสูง (รับ/คืน canvas)
  // ---------------------------------------------------------------------

  function getImage(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  function toCanvas(res) {
    var c = Scanner.makeCanvas(res.width, res.height);
    c.getContext('2d').putImageData(new ImageData(res.data, res.width, res.height), 0, 0);
    return c;
  }

  function toRotatedCanvas(res, settings) {
    var c = toCanvas(res);
    var r = Scanner.rotateCanvas(c, (settings && settings.rotation) || 0);
    if (r !== c) Scanner.releaseCanvas(c);
    return r;
  }

  /** ตรวจจับขอบกระดาษ คืนมุม 4 จุดในพิกัดของ src หรือ null */
  function detect(src, priority) {
    var sc = Scanner.scaledCanvas(src, ScanCore.DETECT_SIDE);
    var img = getImage(sc.canvas);
    Scanner.releaseCanvas(sc.canvas);
    return run('detect', { img: img }, [img.data.buffer], priority).then(function (q) {
      if (!q) return null;
      var sz = Scanner.sourceSize(src), inv = 1 / sc.scale;
      var quad = q.map(function (p) {
        return { x: Math.min(sz.w, Math.max(0, p.x * inv)), y: Math.min(sz.h, Math.max(0, p.y * inv)) };
      });
      return Scanner.isValidQuad(quad) ? quad : null;
    });
  }

  /** เตรียมข้อมูลสำหรับครอป: ย่อภาพต้นทางให้ใหญ่กว่าผลลัพธ์เล็กน้อย (ลด aliasing และหน่วยความจำ) */
  function prepareWarp(src, quad, maxSide) {
    var out = Scanner.outputSize(quad);
    var s = Math.min(1, maxSide / Math.max(out.w, out.h));
    var outW = Math.max(1, Math.round(out.w * s));
    var outH = Math.max(1, Math.round(out.h * s));
    var sz = Scanner.sourceSize(src);
    var sc = Scanner.scaledCanvas(src, Math.max(64, Math.max(sz.w, sz.h) * Math.min(1, s * 1.25)));
    var img = getImage(sc.canvas);
    Scanner.releaseCanvas(sc.canvas);
    var k = sc.scale;
    return {
      img: img,
      quad: quad.map(function (p) { return { x: p.x * k, y: p.y * k }; }),
      outW: outW,
      outH: outH
    };
  }

  /** ครอปตามกรอบ quad คืน canvas (ด้านยาวไม่เกิน maxSide) */
  function warp(src, quad, maxSide, priority) {
    var a = prepareWarp(src, quad, maxSide);
    return run('warp', a, [a.img.data.buffer], priority).then(toCanvas);
  }

  /** ปรับภาพ (ฟิลเตอร์ + หมุน) คืน canvas ใหม่ */
  function process(canvas, settings, priority) {
    var img = getImage(canvas);
    return run('process', { img: img, settings: settings }, [img.data.buffer], priority).then(function (res) {
      return toRotatedCanvas(res, settings);
    });
  }

  /** ครอป + ปรับภาพ + หมุน ในครั้งเดียว */
  function warpProcess(src, quad, maxSide, settings, priority) {
    var a = prepareWarp(src, quad, maxSide);
    a.settings = settings;
    return run('warpProcess', a, [a.img.data.buffer], priority).then(function (res) {
      return toRotatedCanvas(res, settings);
    });
  }

  window.CvEngine = {
    load: load,
    retry: function () {
      if (state === 'error') { reset(); state = 'idle'; load(); }
    },
    isReady: function () { return state === 'ready'; },
    getState: function () { return state; },
    onChange: function (fn) { listeners.push(fn); fn(state); },
    /** จำนวนงานที่ควรส่งพร้อมกัน */
    concurrency: function () { return mode === 'worker' ? poolSize : 1; },
    info: function () { return { mode: mode, build: buildName, workers: workers.length, poolSize: poolSize }; },
    /** ปิด worker ที่ว่างอยู่ (เหลือไว้ 1 ตัว) เพื่อคืนหน่วยความจำ เช่น หลังสร้าง PDF */
    trim: function () {
      workers.filter(function (w) { return w.ready && !w.busy; }).slice(1).forEach(removeWorker);
    },
    detect: detect,
    warp: warp,
    process: process,
    warpProcess: warpProcess,
    /** ขนาดหน่วยความจำ WebAssembly ของ worker หนึ่งตัว (สำหรับตรวจสอบ/ทดสอบ) */
    memory: function () {
      if (mode === 'inline') {
        var m = new cv.Mat(1, 1, cv.CV_8UC1);
        try { return Promise.resolve({ heap: m.data.buffer.byteLength }); } finally { m.delete(); }
      }
      return run('memory', {}, [], 'high');
    }
  };
})();
