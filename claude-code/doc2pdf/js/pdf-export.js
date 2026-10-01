/*
 * PdfExport — รวมภาพที่ประมวลผลแล้วเป็นไฟล์ PDF ด้วย jsPDF
 */
(function () {
  'use strict';

  // ขนาดกระดาษ (มม.) แนวตั้ง
  var PAGE_SIZES = {
    a4: [210, 297],
    letter: [215.9, 279.4],
    legal: [215.9, 355.6],
    a5: [148, 210]
  };

  // ฟอนต์สำหรับชั้นข้อความที่มองไม่เห็น (PDF ที่ค้นหาข้อความได้) — ต้องรองรับภาษาไทย
  var FONT_FILE = 'Sarabun-Regular.ttf';
  var FONT_URL = 'vendor/fonts/' + FONT_FILE;
  var FONT_NAME = 'Sarabun';
  var fontPromise = null;
  var JSPDF_URL = 'vendor/jspdf/jspdf.umd.min.js';
  var jspdfPromise = null;

  var QUALITY = {
    high: { maxSide: 2480, jpeg: 0.9 },
    medium: { maxSide: 1800, jpeg: 0.8 },
    low: { maxSide: 1300, jpeg: 0.68 }
  };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** ค่าในตารางเฉพาะชื่อที่มีจริง (ชื่ออย่าง "constructor" ไม่นับ) */
  function own(table, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key); }

  function defaultName() {
    var d = new Date();
    return 'scan-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /** ตัด ช่องว่าง . _ - หน้าชื่อ และช่องว่าง . ท้ายชื่อ — ท้ายชื่อไล่จากท้ายสตริง (/[\s.]+$/ ช้าแบบกำลังสองกับช่องว่างยาว ๆ) */
  function trimName(n) {
    n = n.replace(/^[\s._-]+/, '');
    var end = n.length;
    while (end > 0 && /[\s.]/.test(n.charAt(end - 1))) end--;
    return n.slice(0, end);
  }

  /**
   * ทำความสะอาดชื่อไฟล์: ตัดอักขระต้องห้ามของระบบไฟล์, อักขระควบคุม,
   * อักขระกลับทิศข้อความ (ป้องกันชื่อหลอก เช่น "fdp.exe") และจำกัดความยาว
   */
  function sanitizeFilename(name) {
    var n = String(name == null ? '' : name);
    if (n.normalize) n = n.normalize('NFC');
    // อักขระล่องหน (zero-width, word joiner, BOM) ก็ตัดด้วย — ชื่อที่เห็นต้องตรงกับชื่อจริง
    n = n.replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g, '_');
    // ตัด .pdf ทั้งก่อนและหลังตัดส่วนเกินหน้า/ท้าย ("report.pdf " ต้องได้ report.pdf ไม่ใช่ report.pdf.pdf)
    n = trimName(trimName(n.replace(/\.pdf$/i, '')).replace(/\.pdf$/i, ''));
    if (n.length > 100) {
      n = n.slice(0, 100);
      if (/[\uD800-\uDBFF]$/.test(n)) n = n.slice(0, -1); // ไม่ตัดกลางอักขระ 4 ไบต์ (เช่น อีโมจิ)
      n = n.trim();
    }
    if (!n) n = defaultName();
    return n + '.pdf';
  }

  function canvasToJpegBytes(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) { reject(new Error('แปลงภาพเป็น JPEG ไม่สำเร็จ')); return; }
        blob.arrayBuffer().then(function (buf) { resolve(new Uint8Array(buf)); }, reject);
      }, 'image/jpeg', quality);
    });
  }

  function pageLayout(imgW, imgH, opts) {
    var margin = Math.max(0, Number(opts.margin) || 0);
    var pw, ph;
    if (opts.pageSize === 'fit' || !own(PAGE_SIZES, opts.pageSize)) {
      // หน้ากระดาษขนาดเท่าสัดส่วนภาพ โดยด้านยาวเท่ากับ A4 (297 มม.)
      var k = 297 / Math.max(imgW, imgH);
      pw = imgW * k + margin * 2;
      ph = imgH * k + margin * 2;
    } else {
      var size = PAGE_SIZES[opts.pageSize];
      var landscape = opts.orientation === 'landscape' ||
        (opts.orientation !== 'portrait' && imgW > imgH);
      pw = landscape ? size[1] : size[0];
      ph = landscape ? size[0] : size[1];
    }
    var boxW = pw - margin * 2, boxH = ph - margin * 2;
    var s = Math.min(boxW / imgW, boxH / imgH);
    var w = imgW * s, h = imgH * s;
    return { pw: pw, ph: ph, x: (pw - w) / 2, y: (ph - h) / 2, w: w, h: h };
  }

  function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function hasJsPdf() { return !!(window.jspdf && typeof window.jspdf.jsPDF === 'function'); }

  /** โหลด jsPDF เมื่อต้องใช้ครั้งแรก (ผ่าน AppPlatform — ดู js/boot.js) */
  function ensureJsPdf() {
    if (hasJsPdf()) return Promise.resolve();
    if (!jspdfPromise) {
      try {
        jspdfPromise = window.AppPlatform.loadScript(JSPDF_URL, true);
      } catch (e) {
        jspdfPromise = Promise.reject(e);
      }
      jspdfPromise = jspdfPromise.then(function () {
        if (!hasJsPdf()) throw new Error('jsPDF');
      });
      jspdfPromise.catch(function () { jspdfPromise = null; }); // ลองใหม่ได้ครั้งหน้า
    }
    return jspdfPromise.catch(function () {
      throw new Error('โหลดไลบรารี jsPDF ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ');
    });
  }

  /** โหลดไลบรารีที่ใช้สร้าง PDF ล่วงหน้า (เช่น ตอนเปิดหน้าต่างสร้าง PDF) — ไม่แจ้งข้อผิดพลาด */
  function preload() {
    ensureJsPdf().catch(function () { /* แจ้งตอนกดสร้างจริง */ });
  }

  /** โหลดฟอนต์ (ครั้งเดียว) เป็น binary string สำหรับ jsPDF */
  function loadFont() {
    if (!fontPromise) {
      var resolving;
      try { resolving = window.AppPlatform.resolve(FONT_URL, true); } catch (e) { resolving = Promise.reject(e); }
      fontPromise = resolving.then(function (url) { return fetch(url); }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf);
        if (bytes.length < 12 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) throw new Error('ไฟล์ฟอนต์ไม่ถูกต้อง');
        var out = '';
        for (var i = 0; i < bytes.length; i += 0x8000) {
          out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return out;
      });
      fontPromise.catch(function () { fontPromise = null; }); // ลองใหม่ได้ครั้งหน้า
    }
    return fontPromise.catch(function (e) {
      throw new Error('โหลดฟอนต์สำหรับข้อความใน PDF ไม่สำเร็จ (' + (e && e.message ? e.message : e) + ')');
    });
  }

  /**
   * วางข้อความที่อ่านได้ (OCR) ทับตำแหน่งเดียวกับในภาพแบบมองไม่เห็น (text render mode 3)
   * ภาพที่แสดงไม่เปลี่ยน แต่ค้นหา เลือก และคัดลอกข้อความใน PDF ได้
   * @param layout ผลจาก Ocr.buildLayout — พิกัดเป็นสัดส่วนของภาพ
   * @param L ตำแหน่งภาพบนหน้า (มม.) จาก pageLayout
   * @returns {number} จำนวนช่วงข้อความที่วาง
   */
  function drawTextLayer(doc, layout, L) {
    var count = 0;
    var lines = layout && Array.isArray(layout.lines) ? layout.lines : [];
    doc.setFont(FONT_NAME, 'normal');
    lines.forEach(function (line) {
      var sizePt = Number(line.size) * L.h / 25.4 * 72;
      var y = L.y + Number(line.base) * L.h;
      if (!(sizePt >= 1 && sizePt <= 400) || !isFinite(y) || !Array.isArray(line.segs)) return;
      doc.setFontSize(sizePt);
      line.segs.forEach(function (seg) {
        var text = typeof seg.t === 'string' ? seg.t.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
        var x0 = Number(seg.x0), x1 = Number(seg.x1);
        if (!text || !(x1 > x0) || x0 < 0 || x1 > 1) return;
        var target = (x1 - x0) * L.w;
        var natural = doc.getTextWidth(text);
        if (!(natural > 0)) return;
        doc.text(text, L.x + x0 * L.w, y, {
          baseline: 'alphabetic',
          renderingMode: 'invisible',
          horizontalScale: Math.min(10, Math.max(0.05, target / natural))
        });
        count++;
      });
    });
    return count;
  }

  function cancelledError() {
    var e = new Error('ยกเลิกแล้ว');
    e.cancelled = true;
    return e;
  }

  /**
   * สร้าง PDF
   * @param {Array} pages          รายการหน้า
   * @param {Object} opts          { pageSize, orientation, margin, quality, concurrency,
   *                                 textLayer: (page, index) => Promise<layout|null>  — ใส่ข้อความ OCR (ค้นหาได้)
   *                                 isCancelled: () => boolean }
   * @param {Function} renderPage  (page, maxSide) => Promise<HTMLCanvasElement>
   * @param {Function} onProgress  (done, total) => void
   * @returns {Promise<{blob: Blob, textPages: number, textError: Error|null}>}
   *          ยกเลิก → reject ด้วย error.cancelled = true
   */
  async function build(pages, opts, renderPage, onProgress) {
    if (!pages.length) throw new Error('ยังไม่มีหน้าเอกสาร');
    await ensureJsPdf();
    var q = own(QUALITY, opts.quality) ? QUALITY[opts.quality] : QUALITY.high;
    var n = pages.length;
    var ahead = Math.max(1, Math.min(4, opts.concurrency || 1));
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    function checkCancel() { if (isCancelled()) throw cancelledError(); }

    // ชั้นข้อความ (OCR): อ่านทีละหน้าตามลำดับ และเตรียมหน้าถัดไปล่วงหน้า 1 หน้า
    var withText = typeof opts.textLayer === 'function';
    var textPages = 0;
    var textError = null;
    var font = null;
    if (withText) {
      try {
        font = await loadFont();
      } catch (e) {
        withText = false;
        textError = e;
      }
      checkCancel();
    }
    var texts = new Array(n);
    var nextText = 0;
    function launchText() {
      if (!withText || nextText >= n) return;
      var i = nextText++;
      texts[i] = Promise.resolve().then(function () { return opts.textLayer(pages[i], i); });
      texts[i].catch(function () { /* จัดการตอนรอผลตามลำดับ */ });
    }
    launchText();
    launchText();

    // ประมวลผลล่วงหน้าหลายหน้าพร้อมกัน (ตามจำนวน worker) แต่ใส่ลง PDF ตามลำดับหน้า
    var slots = new Array(n);
    var next = 0;
    function launch() {
      if (next >= n) return;
      var i = next++;
      slots[i] = renderPage(pages[i], q.maxSide).then(function (canvas) {
        var w = canvas.width, h = canvas.height;
        return canvasToJpegBytes(canvas, q.jpeg).then(function (bytes) {
          canvas.width = canvas.height = 0; // คืนหน่วยความจำ canvas (สำคัญบน iOS)
          return { bytes: bytes, w: w, h: h };
        });
      });
      slots[i].catch(function () { /* จัดการตอนรอผลตามลำดับ */ });
    }
    for (var k = 0; k < ahead; k++) launch();

    var doc = null;
    for (var i = 0; i < n; i++) {
      checkCancel();
      var r = await slots[i];
      checkCancel();
      slots[i] = null;
      launch();
      var L = pageLayout(r.w, r.h, opts);
      var orient = L.pw > L.ph ? 'landscape' : 'portrait';
      if (!doc) {
        doc = new window.jspdf.jsPDF({ unit: 'mm', format: [L.pw, L.ph], orientation: orient, compress: true });
        if (withText) {
          doc.addFileToVFS(FONT_FILE, font);
          doc.addFont(FONT_FILE, FONT_NAME, 'normal', 'Identity-H');
        }
      } else {
        doc.addPage([L.pw, L.ph], orient);
      }
      doc.addImage(r.bytes, 'JPEG', L.x, L.y, L.w, L.h, 'page' + i, 'NONE');
      if (withText) {
        var layout = null;
        try {
          layout = await texts[i];
        } catch (e) {
          if (e && e.cancelled) throw e;
          if (!textError) textError = e;
        }
        checkCancel();
        texts[i] = null;
        launchText();
        if (layout && drawTextLayer(doc, layout, L) > 0) textPages++;
      }
      if (onProgress) onProgress(i + 1, n);
      await nextTick();
    }
    doc.setProperties({ creator: 'Doc Scanner PDF' });
    if (textPages && typeof doc.setLanguage === 'function') {
      try { doc.setLanguage('th'); } catch (_) { /* ไม่สำคัญ */ }
    }
    return { blob: doc.output('blob'), textPages: textPages, textError: textError };
  }

  function platformFn(name) {
    var P = window.AppPlatform;
    return P && typeof P[name] === 'function' ? P[name].bind(P) : null;
  }

  /**
   * บันทึกไฟล์ (PDF, .txt, .jpg, .zip, .docx) — คืน Promise<boolean>: false = ผู้ใช้ยกเลิก
   * แพลตฟอร์มที่ดาวน์โหลดแบบเว็บไม่ได้ (เช่น แอป Android) บันทึกเองผ่าน AppPlatform.saveFile(blob, filename)
   */
  function download(blob, filename) {
    var save = platformFn('saveFile');
    if (save) {
      try {
        return Promise.resolve(save(blob, filename)).then(function (ok) { return ok !== false; });
      } catch (e) {
        return Promise.reject(e);
      }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return Promise.resolve(true);
  }

  /** แชร์ไฟล์ได้ไหม — type/name: ชนิดไฟล์ที่จะแชร์ (ค่าเริ่มต้น PDF; เบราว์เซอร์บางตัวแชร์ .zip/.docx ไม่ได้) */
  function canShareFiles(type, name) {
    if (platformFn('shareFile')) return true;
    try {
      if (!navigator.share || !navigator.canShare || typeof File !== 'function') return false;
      var f = new File([new Uint8Array(1)], name || 'test.pdf', { type: type || 'application/pdf' });
      return navigator.canShare({ files: [f] });
    } catch (_) {
      return false;
    }
  }

  function share(blob, filename) {
    var shareFile = platformFn('shareFile');
    if (shareFile) {
      try {
        return Promise.resolve(shareFile(blob, filename));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    var file = new File([blob], filename, { type: blob.type || 'application/pdf' });
    return navigator.share({ files: [file], title: filename });
  }

  /** แชร์ข้อความ (ผลการแปลงภาพเป็นข้อความ) — AppPlatform.shareText ถ้ามี ไม่งั้น Web Share API */
  function canShareText() {
    return !!platformFn('shareText') || typeof navigator.share === 'function';
  }

  function shareText(text, title) {
    var fn = platformFn('shareText');
    try {
      return Promise.resolve(fn ? fn(text, title) : navigator.share({ title: title, text: text }));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  window.PdfExport = {
    QUALITY: QUALITY,
    build: build,
    download: download,
    share: share,
    canShareFiles: canShareFiles,
    canShareText: canShareText,
    shareText: shareText,
    sanitizeFilename: sanitizeFilename,
    defaultName: defaultName,
    pageLayout: pageLayout,
    drawTextLayer: drawTextLayer,
    preload: preload
  };
})();
