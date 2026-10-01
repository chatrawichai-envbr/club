/*
 * Ocr — อ่านข้อความจากภาพ (OCR) ด้วย Tesseract.js ที่เก็บไว้ในเว็บไซต์ (vendor/tesseract)
 *   - โหลดไลบรารีเฉพาะตอนใช้งานครั้งแรก และรันใน Web Worker (หน้าจอไม่ค้าง)
 *   - ทำทีละงานตามลำดับ ยกเลิกได้ และปิด worker อัตโนมัติเมื่อไม่ได้ใช้ เพื่อคืนหน่วยความจำ
 */
(function () {
  'use strict';

  var BASE = 'vendor/tesseract/';
  var IDLE_MS = 90000;
  var LANGS = ['tha+eng', 'tha', 'eng'];
  var MIN_LINE_CONF = 35;   // บรรทัดที่ความมั่นใจต่ำกว่านี้มักเป็นภาพ/โลโก้ ไม่ใส่ในชั้นข้อความของ PDF
  var INIT_TIMEOUT_MS = 180000; // โหลดตัวอ่าน + ข้อมูลภาษา (~8 MB) บนเน็ตมือถือช้า

  var libPromise = null;
  var worker = null;
  var workerLang = null;
  var idleTimer = null;
  var progressCb = null;
  var chain = Promise.resolve();
  var pending = [];
  var opFail = null;        // reject ของการเริ่ม/เปลี่ยนภาษาที่กำลังทำ (Tesseract แจ้งผ่าน errorHandler)

  function abs(u) { return new URL(u, document.baseURI).href; }

  function platform() {
    if (!window.AppPlatform) throw new Error('ไม่พบ AppPlatform (js/boot.js)');
    return window.AppPlatform;
  }

  /**
   * ภาษาและที่อยู่ไฟล์ของ Tesseract.js — ค่าเริ่มต้นเป็นไฟล์ในเว็บไซต์ (vendor/tesseract)
   * แพลตฟอร์มอื่น (เวอร์ชัน Apps Script) กำหนด AppPlatform.ocrOptions(lang) เองได้
   * @returns {Promise<{langs: string|Array, workerPath: string, corePath: string, langPath: string}>}
   */
  function ocrOptions(lang) {
    var P = platform();
    if (typeof P.ocrOptions === 'function') return P.ocrOptions(lang);
    return P.resolve(BASE + 'worker.min.js', true).then(function (workerPath) {
      return { langs: lang, workerPath: workerPath, corePath: abs(BASE + 'core'), langPath: abs(BASE + 'lang') };
    });
  }

  function isSupported() {
    return typeof Worker === 'function' && typeof WebAssembly === 'object' && location.protocol !== 'file:';
  }

  function loadLib() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!libPromise) {
      var loading;
      try { loading = platform().loadScript(BASE + 'tesseract.min.js', true); } catch (e) { loading = Promise.reject(e); }
      libPromise = loading.then(function () {
        if (window.Tesseract) return window.Tesseract;
        throw new Error('โหลดตัวอ่านข้อความไม่สำเร็จ');
      }, function () {
        throw new Error('โหลดตัวอ่านข้อความไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต');
      });
      libPromise.catch(function () { libPromise = null; }); // ลองใหม่ได้ครั้งหน้า
    }
    return libPromise;
  }

  function logger(m) {
    if (progressCb && m && typeof m.status === 'string') progressCb(m.status, Number(m.progress) || 0);
  }

  async function configure(w) {
    // preserve_interword_spaces: ไม่แทรกช่องว่างระหว่างคำภาษาไทย และคงการจัดคอลัมน์ของตาราง
    // user_defined_dpi: ภาพที่ส่งให้มีความละเอียดประมาณ 300 dpi อยู่แล้ว
    await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300', tessedit_pageseg_mode: '3' });
  }

  /**
   * รอการเริ่มตัวอ่าน/เปลี่ยนภาษา — Tesseract.js ไม่ปิด promise เมื่อเริ่มไม่สำเร็จ (แจ้งแค่ errorHandler)
   * จึงต้องจับจาก errorHandler และมีเวลาจำกัด ไม่ให้ค้างรอตลอดไป
   */
  function guard(p) {
    return new Promise(function (resolve, reject) {
      var done = function (fn, v) { clearTimeout(timer); if (opFail === fail) opFail = null; fn(v); };
      var fail = function (e) { done(reject, e); };
      var timer = setTimeout(function () { fail(new Error('เริ่มตัวอ่านข้อความนานเกินไป')); }, INIT_TIMEOUT_MS);
      opFail = fail;
      p.then(function (v) { done(resolve, v); }, fail);
    });
  }

  function onTesseractError(e) {
    console.warn('OCR', e);
    if (opFail) opFail(new Error('เริ่มตัวอ่านข้อความไม่สำเร็จ'));
  }

  async function getWorker(lang) {
    if (worker && workerLang === lang) return worker;
    var opts = await ocrOptions(lang);
    if (worker) {
      try {
        await guard(worker.reinitialize(opts.langs, 1));
        await configure(worker);
        workerLang = lang;
        return worker;
      } catch (e) {
        terminateWorker();
      }
    }
    var T = await loadLib();
    var w = await guard(T.createWorker(opts.langs, 1 /* LSTM อย่างเดียว */, {
      workerPath: opts.workerPath,
      corePath: opts.corePath,
      langPath: opts.langPath,
      workerBlobURL: false,   // CSP อนุญาตเฉพาะ worker จากไฟล์ในเว็บไซต์
      cacheMethod: 'none',    // ใช้แคชของเบราว์เซอร์แทน IndexedDB (ไม่เก็บข้อมูลค้างเมื่ออัปเดตไฟล์)
      gzip: true,
      logger: logger,
      errorHandler: onTesseractError
    }));
    await configure(w);
    worker = w;
    workerLang = lang;
    return worker;
  }

  function terminateWorker() {
    var w = worker;
    worker = null;
    workerLang = null;
    if (w) { try { w.terminate(); } catch (e) { /* ignore */ } }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!pending.length) terminateWorker();
    }, IDLE_MS);
  }

  /** Tesseract ให้สระอำเป็น นิคหิต + สระอา (ํา) — รวมเป็น ำ ตัวเดียวเพื่อให้ค้นหา/คัดลอกได้ถูกต้อง */
  function fixThai(text) {
    return String(text || '')
      .replace(/ํ([่-๋]?)า/g, '$1ำ')
      .replace(/([่-๋])ํา/g, '$1ำ');
  }

  /** ปรับข้อความภาษาไทยให้ถูกต้อง และจัดบรรทัดว่าง */
  function cleanText(text) {
    // ตัดช่องว่างท้ายบรรทัดโดยไล่จากท้ายแต่ละบรรทัด (/[ \t]+$/gm ช้าแบบกำลังสองกับช่องว่างยาว ๆ กลางบรรทัด)
    // แยกบรรทัดด้วยตัวขึ้นบรรทัดชุดเดียวกับ $ ของ regex แบบ m (\r ถูกแปลงเป็น \n ไปแล้ว)
    var parts = fixThai(String(text || '').replace(/\r\n?/g, '\n')).split(/(\n|\u2028|\u2029)/);
    for (var i = 0; i < parts.length; i += 2) {
      var line = parts[i], end = line.length;
      while (end > 0 && (line.charAt(end - 1) === ' ' || line.charAt(end - 1) === '\t')) end--;
      parts[i] = line.slice(0, end);
    }
    return parts.join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function isBox(b) { return b && isFinite(b.x0) && isFinite(b.y0) && isFinite(b.x1) && isFinite(b.y1) && b.x1 > b.x0 && b.y1 > b.y0; }

  /**
   * แบ่งบรรทัดเป็นช่วงตามช่องว่างยาว (เช่น คอลัมน์ของตาราง) และหาตำแหน่งแนวนอนของแต่ละช่วงจากกรอบของคำ
   * เพื่อให้ข้อความที่ฝังใน PDF ตรงกับตำแหน่งในภาพมากที่สุด
   */
  function lineSegments(raw, words, bb) {
    var whole = [{ t: raw.trim(), x0: bb.x0, x1: bb.x1 }];
    var parts = raw.trim().split(/\s{2,}/);
    if (parts.length < 2) return whole;
    var owner = [];
    for (var i = 0; i < words.length; i++) {
      if (!words[i] || !isBox(words[i].bbox)) return whole;
      var n = String(words[i].text || '').replace(/\s+/g, '').length;
      for (var k = 0; k < n; k++) owner.push(i);
    }
    if (owner.length !== raw.replace(/\s+/g, '').length) return whole;
    var segs = [];
    var pos = 0;
    parts.forEach(function (part) {
      var len = part.replace(/\s+/g, '').length;
      if (!len) return;
      segs.push({ t: part, x0: words[owner[pos]].bbox.x0, x1: words[owner[pos + len - 1]].bbox.x1 });
      pos += len;
    });
    return segs;
  }

  /**
   * ตำแหน่งข้อความจากผล OCR สำหรับทำ PDF ที่ค้นหาข้อความได้
   * พิกัดทั้งหมดเป็นสัดส่วน 0..1 ของภาพ (x เทียบความกว้าง, y และขนาดตัวอักษรเทียบความสูง)
   * @returns {{lines: Array<{base: number, size: number, segs: Array<{t: string, x0: number, x1: number}>}>}|null}
   */
  function buildLayout(blocks, W, H) {
    if (!(W > 0 && H > 0) || !Array.isArray(blocks)) return null;
    var lines = [];
    blocks.forEach(function (b) {
      (b && b.paragraphs || []).forEach(function (p) {
        (p && p.lines || []).forEach(function (l) {
          if (!l || !isBox(l.bbox) || !((Number(l.confidence) || 0) >= MIN_LINE_CONF)) return;
          var raw = String(l.text || '').replace(/[\r\n]+/g, ' ');
          if (!/[0-9A-Za-z\u0E01-\u0E4E]/.test(raw)) return;
          var bb = l.bbox;
          var h = bb.y1 - bb.y0;
          var row = l.rowAttributes || {};
          var size = clamp(Number(row.rowHeight) || h, h * 0.5, h * 1.5);
          var bl = l.baseline;
          var base = bl && isFinite(bl.y0) && isFinite(bl.y1) ? (bl.y0 + bl.y1) / 2 : bb.y1 - h * 0.2;
          base = clamp(base, bb.y0 + h * 0.3, bb.y1 + h * 0.1);
          var segs = lineSegments(raw, Array.isArray(l.words) ? l.words : [], bb).map(function (s) {
            return { t: fixThai(s.t).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim(), x0: clamp(s.x0 / W, 0, 1), x1: clamp(s.x1 / W, 0, 1) };
          }).filter(function (s) { return s.t && s.x1 > s.x0; });
          if (segs.length) lines.push({ base: clamp(base / H, 0, 1), size: size / H, segs: segs });
        });
      });
    });
    return { lines: lines };
  }

  /**
   * อ่านข้อความจากภาพ
   * @param {Blob|HTMLCanvasElement} image
   * @param {string} lang 'tha+eng' | 'tha' | 'eng'
   * @param {Function} onProgress (status, progress 0..1)
   * @param {{width: number, height: number}} [size] ขนาดภาพ (ใช้คำนวณตำแหน่งข้อความ ถ้า image เป็น Blob)
   * @returns {Promise<{text: string, confidence: number, layout: Object|null}>}
   *          (ถูกยกเลิก → reject ด้วย error.cancelled = true)
   */
  function recognize(image, lang, onProgress, size) {
    var W = size ? size.width : image && image.width;
    var H = size ? size.height : image && image.height;
    if (LANGS.indexOf(lang) < 0) lang = 'tha+eng';
    var job = { cancelled: false };
    var p = new Promise(function (resolve, reject) {
      job.reject = reject;
      job.cancelPromise = new Promise(function (_, rej) { job.cancel = rej; });
      job.cancelPromise.catch(function () { /* จัดการผ่าน race */ });
      chain = chain.then(async function () {
        if (job.cancelled) return;
        clearTimeout(idleTimer);
        progressCb = onProgress || null;
        try {
          var w = await Promise.race([getWorker(lang), job.cancelPromise]);
          var res = await Promise.race([w.recognize(image, {}, { text: true, blocks: true }), job.cancelPromise]);
          resolve({
            text: cleanText(res.data.text),
            confidence: Math.round(res.data.confidence || 0),
            layout: buildLayout(res.data.blocks, W, H)
          });
        } catch (e) {
          reject(e);
        } finally {
          progressCb = null;
          var i = pending.indexOf(job);
          if (i >= 0) pending.splice(i, 1);
          scheduleIdle();
        }
      }).catch(function () { /* ไม่ให้ chain ค้าง */ });
    });
    pending.push(job);
    return p;
  }

  /** ยกเลิกงานทั้งหมดที่ค้างอยู่ (ปิด worker ที่กำลังอ่านทันที) */
  function cancelAll() {
    if (!pending.length) return;
    var jobs = pending.splice(0);
    jobs.forEach(function (job) {
      job.cancelled = true;
      var err = new Error('ยกเลิกแล้ว');
      err.cancelled = true;
      job.cancel(err);
      job.reject(err);
    });
    terminateWorker();
  }

  window.Ocr = {
    LANGS: LANGS,
    isSupported: isSupported,
    recognize: recognize,
    cancelAll: cancelAll,
    cleanText: cleanText,
    buildLayout: buildLayout,
    isBusy: function () { return pending.length > 0; }
  };
})();
