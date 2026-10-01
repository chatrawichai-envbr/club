/*
 * pdf-convert.js — หน้าต่าง "แปลงไฟล์ PDF": เลือกไฟล์ PDF แล้วแปลงเป็นรูป JPG (small/standard/high) หรือไฟล์ Word
 * งานแปลงอยู่ใน js/pdf-tools.js — ไฟล์นี้ดูแลหน้าต่าง ตัวเลือก ความคืบหน้า การยกเลิก และการบันทึก/แชร์ผลลัพธ์
 *
 *   PdfConvert.open(file)   เปิดหน้าต่างพร้อมไฟล์ (ใช้ตอนลากไฟล์ PDF มาวางที่หน้าหลัก)
 *   PdfConvert.isPdf(file)
 *   PdfConvert.isBusy()
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var OCR_LANGS = ['tha+eng', 'tha', 'eng'];
  // localStorage ใช้ร่วมกับทุกแอปใต้ envburiramclub.github.io: key ขึ้นต้นด้วยชื่อโฟลเดอร์เสมอ
  // ยังไม่มีค่าใหม่ → อ่าน key เดิมที่ไม่มีคำนำหน้า (ผู้ใช้ไม่เสียค่าที่ตั้งไว้) แต่ไม่ลบ เพราะแอปอื่นอาจใช้ชื่อเดียวกัน
  // ค่าที่อ่านได้ต้องตรวจก่อนใช้ทุกครั้ง (แอปอื่นเขียนทับได้)
  var PREF_PREFIX = 'doc2pdf:';
  function loadPref(name, legacy) {
    var v = localStorage.getItem(PREF_PREFIX + name);
    return v === null && legacy ? localStorage.getItem(legacy) : v;
  }
  function savePref(name, value) { localStorage.setItem(PREF_PREFIX + name, value); }
  var OCR_STATUS = {
    'loading tesseract core': 'กำลังโหลดตัวอ่านข้อความ…',
    'initializing tesseract': 'กำลังเตรียมตัวอ่านข้อความ…',
    'loading language traineddata': 'กำลังโหลดข้อมูลภาษา…',
    'initializing api': 'กำลังเตรียมตัวอ่านข้อความ…'
  };
  var NOTES = {
    jpg: 'แปลงแต่ละหน้าเป็นรูป JPG — หน้าเดียวได้ไฟล์ .jpg หลายหน้ารวมเป็นไฟล์ .zip (แตกไฟล์เพื่อดูรูป)',
    docx: 'ข้อความภาษาไทยดึงจากไฟล์ PDF ตรงตามต้นฉบับทุกตัวอักษร คงบรรทัดและย่อหน้าเดิม (ไม่รวมรูปภาพและเส้นตาราง) — ' +
      'หน้าที่เป็นภาพสแกนไม่มีข้อความในไฟล์ จึงต้องอ่านด้วย OCR ซึ่งอาจอ่านผิดได้ ต้องตรวจทานทุกครั้ง'
  };

  var S = {
    format: 'jpg',
    file: null,
    doc: null,
    token: 0,          // เพิ่มค่าเมื่อเปลี่ยนไฟล์/ปิดหน้าต่าง — ผลของไฟล์เก่าที่เปิดเสร็จทีหลังถูกทิ้ง
    opening: false,
    busy: false,
    cancelled: false,
    last: null,
    password: null     // { resolve } ระหว่างรอรหัสผ่าน
  };

  // Firefox บน Android (GeckoView): ช่องเลือกไฟล์ที่มี accept แบบไม่ใช่รูปภาพ (application/pdf, .pdf) ทำให้แอปล่ม
  // ก่อนหน้าเลือกไฟล์จะขึ้น — ช่องที่ไม่มี accept ใช้ได้ปกติ
  // โหมด "เว็บไซต์เดสก์ท็อป" ของ Firefox บน Android ส่ง user agent เป็น Linux จึงดูจากจอสัมผัสด้วย
  var UA = navigator.userAgent || '';
  var ANDROID = /Android/i.test(UA) ||
    (/Linux/i.test(UA) && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  var GECKO_ANDROID = ANDROID && /\bGecko\/\d/.test(UA);

  function isPdf(f) {
    if (!f) return false;
    if (/^application\/(x-)?pdf$/i.test(f.type || '')) return true;
    // ไม่มีชนิดไฟล์ หรือ Android ระบุเป็นไฟล์ทั่วไป (octet-stream) — ดูจากนามสกุล (PdfTools.open ตรวจ %PDF- อีกชั้น)
    if (!f.type || /^(application|binary)\/octet-stream$/i.test(f.type)) return /\.pdf$/i.test(f.name || '');
    return false;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }

  function pagesText(list) {
    // [1,2,3,5] → "1-3, 5"
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i], b = a;
      while (list[i + 1] === b + 1) { b++; i++; }
      out.push(a === b ? String(a) : a + '-' + b);
    }
    return out.join(', ');
  }

  function toast(msg, type) {
    var box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, type === 'error' ? 5000 : 3200);
  }

  function isOpen() { return $('pdfDialog').hasAttribute('open'); }

  function showResult(text, isError) {
    var r = $('pdfResult');
    r.textContent = text;
    r.classList.toggle('error', !!isError);
    r.hidden = !text;
  }

  function setInfo(text) { $('pdfFileInfo').textContent = text; }

  function syncForm() {
    var jpg = S.format === 'jpg';
    Array.prototype.forEach.call($('pdfFormats').querySelectorAll('.chip'), function (c) {
      var on = c.getAttribute('data-format') === S.format;
      c.setAttribute('aria-checked', on ? 'true' : 'false');
      c.tabIndex = on ? 0 : -1;
    });
    var ocr = window.Ocr && Ocr.isSupported();
    $('pdfQualityField').hidden = !jpg;
    $('pdfModeField').hidden = jpg;
    $('pdfFontField').hidden = jpg;
    $('pdfLangField').hidden = jpg || !ocr || $('pdfMode').value === 'text';
    Array.prototype.forEach.call($('pdfMode').options, function (o) { o.disabled = o.value !== 'text' && !ocr; });
    if (!ocr) $('pdfMode').value = 'text';
    $('pdfNote').textContent = NOTES[S.format];
    $('pdfConvertText').textContent = jpg ? 'แปลงเป็น JPG' : 'แปลงเป็น Word';
    var busy = S.busy;
    ['pdfPick', 'pdfQuality', 'pdfMode', 'pdfFont', 'pdfLang', 'pdfPages', 'pdfShare'].forEach(function (id) { $(id).disabled = busy; });
    Array.prototype.forEach.call($('pdfFormats').querySelectorAll('.chip'), function (c) { c.disabled = busy; });
    $('pdfConvert').disabled = busy || S.opening || !S.doc;
    $('pdfCancel').textContent = busy ? 'หยุด' : 'ปิด';
    $('pdfProgressWrap').hidden = !busy && !S.opening;
  }

  function setFormat(f) {
    if (S.busy || (f !== 'jpg' && f !== 'docx')) return;
    S.format = f;
    try { savePref('pdfConvertFormat', f); } catch (_) { /* ignore */ }
    resetResult();
    syncForm();
  }

  function resetResult() {
    S.last = null;
    $('pdfShare').hidden = true;
    showResult('');
  }

  function showDialog() {
    var dlg = $('pdfDialog');
    if (isOpen()) return;
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function cancelPassword() {
    if (!S.password) return;
    var p = S.password;
    S.password = null;
    $('pdfPasswordRow').hidden = true;
    $('pdfPassword').value = '';
    p.resolve(null);
  }

  function askPassword(retry) {
    return new Promise(function (resolve) {
      S.password = { resolve: resolve };
      $('pdfPasswordLabel').textContent = retry ? 'รหัสผ่านไม่ถูกต้อง — ลองอีกครั้ง' : 'ไฟล์นี้มีรหัสผ่าน — ใส่รหัสผ่านเพื่อเปิด';
      $('pdfPasswordRow').hidden = false;
      $('pdfProgressText').textContent = 'รอรหัสผ่าน…';
      $('pdfPassword').value = '';
      try { $('pdfPassword').focus(); } catch (_) { /* ignore */ }
    });
  }

  function submitPassword() {
    if (!S.password) return;
    var pw = $('pdfPassword').value;
    if (!pw) { try { $('pdfPassword').focus(); } catch (_) { /* ignore */ } return; }
    var p = S.password;
    S.password = null;
    $('pdfPasswordRow').hidden = true;
    $('pdfPassword').value = '';
    $('pdfProgressText').textContent = 'กำลังเปิดไฟล์…';
    p.resolve(pw);
  }

  function dropDoc() {
    S.token++;
    cancelPassword();
    if (S.doc) { S.doc.destroy(); S.doc = null; }
    S.file = null;
    S.opening = false;
  }

  /** เปิดไฟล์ PDF ในหน้าต่าง (แทนไฟล์เดิม) */
  function open(file) {
    if (S.busy) { toast('กำลังแปลงไฟล์อยู่ — รอให้เสร็จหรือกด "หยุด" ก่อน', 'error'); return; }
    if (!isPdf(file)) { toast('"' + String(file && file.name || '') + '" ไม่ใช่ไฟล์ PDF', 'error'); return; }
    dropDoc();
    resetResult();
    showDialog();
    var token = S.token;
    S.file = file;
    S.opening = true;
    setInfo(file.name + ' — ' + formatBytes(file.size));
    $('pdfProgress').removeAttribute('value');
    $('pdfProgressText').textContent = 'กำลังเปิดไฟล์…';
    syncForm();
    PdfTools.open(file, { onPassword: askPassword }).then(function (doc) {
      if (token !== S.token) { doc.destroy(); return; }
      S.doc = doc;
      setInfo(file.name + ' — ' + doc.numPages + ' หน้า, ' + formatBytes(file.size));
    }, function (e) {
      if (token !== S.token) return;
      showResult(e && e.message ? e.message : String(e), true);
    }).then(function () {
      if (token !== S.token) return;
      S.opening = false;
      $('pdfPasswordRow').hidden = true;
      syncForm();
    });
  }

  function pick() {
    if (S.busy) return;
    if (!PdfTools.isSupported()) {
      toast('แปลงไฟล์ PDF ได้เมื่อเปิดผ่านเว็บไซต์ (https) เท่านั้น — ไม่รองรับการเปิดไฟล์จากเครื่องโดยตรง', 'error');
      return;
    }
    // Firefox บน Android: ไม่โหลด PDF.js ระหว่างสลับไปหน้าเลือกไฟล์ (โหลดตอนเปิดไฟล์แทน)
    if (!GECKO_ANDROID) PdfTools.preload();
    $('pdfInput').value = '';
    $('pdfInput').click();
  }

  function close() {
    if (S.busy) { cancel(); return; }
    dropDoc();
    resetResult();
    setInfo('ยังไม่ได้เลือกไฟล์');
    var dlg = $('pdfDialog');
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  function cancel() {
    if (!S.busy || S.cancelled) return;
    S.cancelled = true;
    $('pdfCancel').disabled = true;
    $('pdfProgressText').textContent = 'กำลังหยุด…';
    if (S.format === 'docx' && window.Ocr) Ocr.cancelAll();
  }

  function progressText(done, total, pageNo, status, p) {
    if (S.format === 'jpg') {
      $('pdfProgress').value = Math.round(done / total * 100);
      if (done >= total) return total > 1 ? 'กำลังรวมไฟล์ .zip…' : 'กำลังบันทึก…';
      return 'กำลังแปลงหน้า ' + pageNo + ' (' + (done + 1) + ' / ' + total + ')';
    }
    var frac = status === 'recognizing text' ? p : 0;
    $('pdfProgress').value = Math.round((done + frac) / total * 100);
    if (status === 'build') return 'กำลังสร้างไฟล์ Word…';
    if (status === 'text') return 'กำลังอ่านข้อความหน้า ' + pageNo + ' (' + (done + 1) + ' / ' + total + ')';
    if (status === 'recognizing text') return 'หน้า ' + pageNo + ' เป็นภาพ — กำลังอ่านด้วย OCR ' + Math.round(p * 100) + '%';
    return OCR_STATUS[status] || 'กำลังทำงาน…';
  }

  function docxSummary(r) {
    var parts = [];
    var exact = r.textPages.filter(function (n) { return r.badPages.indexOf(n) < 0; });
    if (exact.length) {
      parts.push(exact.length === r.count ? 'ข้อความตรงตามต้นฉบับในไฟล์ PDF ทุกหน้า'
        : 'หน้า ' + pagesText(exact) + ': ข้อความตรงตามต้นฉบับในไฟล์ PDF');
    }
    var warn = false;
    if (r.ocrPages.length) {
      warn = true;
      parts.push('หน้า ' + pagesText(r.ocrPages) + ' เป็นภาพสแกน อ่านด้วย OCR — กรุณาตรวจทานข้อความ');
    }
    if (r.badPages.length) {
      warn = true;
      parts.push('หน้า ' + pagesText(r.badPages) + ' ฟอนต์ในไฟล์ไม่บอกรหัสตัวอักษรบางตัว ข้อความอาจไม่ครบ — ตรวจทาน หรือเลือก "OCR ทุกหน้า"');
    }
    if (r.emptyPages.length) {
      warn = true;
      parts.push('หน้า ' + pagesText(r.emptyPages) + ' ไม่มีข้อความ' +
        (r.ocrFailed.length ? ' (อ่านด้วย OCR ไม่สำเร็จ)' : ($('pdfMode').value === 'text' ? ' (เป็นภาพ — เลือกอ่านด้วย OCR)' : '')));
    }
    return { text: parts.join(' · '), warn: warn };
  }

  async function convert() {
    if (S.busy) return;
    if (S.password) { submitPassword(); return; }
    if (!S.doc) { if (!S.opening) pick(); return; }
    var pages;
    try {
      pages = PdfTools.parsePages($('pdfPages').value, S.doc.numPages);
    } catch (e) {
      showResult(e.message, true);
      try { $('pdfPages').focus(); } catch (_) { /* ignore */ }
      return;
    }
    var doc = S.doc, format = S.format, token = S.token;
    S.busy = true;
    S.cancelled = false;
    resetResult();
    $('pdfProgress').value = 0;
    $('pdfProgressText').textContent = 'กำลังเตรียม…';
    syncForm();
    var isCancelled = function () { return S.cancelled || token !== S.token; };
    var onProgress = function (done, total, pageNo, status, p) {
      if (!isCancelled()) $('pdfProgressText').textContent = progressText(done, total, pageNo, status, p);
    };
    try {
      var r, summary;
      if (format === 'jpg') {
        r = await PdfTools.toJpeg(doc, { preset: $('pdfQuality').value, pages: pages, onProgress: onProgress, isCancelled: isCancelled });
        summary = { text: (r.zip ? r.count + ' รูปในไฟล์ .zip' : '1 รูป') + ' (' + r.dpi + ' dpi)', warn: false };
      } else {
        var lang = OCR_LANGS.indexOf($('pdfLang').value) >= 0 ? $('pdfLang').value : 'tha+eng';
        r = await PdfTools.toDocx(doc, {
          pages: pages, mode: $('pdfMode').value, lang: lang, font: $('pdfFont').value,
          onProgress: onProgress, isCancelled: isCancelled
        });
        summary = docxSummary(r);
        summary.text = r.count + ' หน้า' + (summary.text ? ' · ' + summary.text : '');
      }
      S.last = { blob: r.blob, name: r.name };
      var saved;
      try { saved = await PdfExport.download(r.blob, r.name); } catch (e) { console.error(e); saved = e; }
      var note = '';
      if (saved !== true) {
        summary.warn = true;
        note = saved === false ? ' · ยังไม่ได้บันทึกไฟล์ (กด "' + $('pdfConvertText').textContent + '" อีกครั้งเพื่อบันทึก)'
          : ' · บันทึกไฟล์ไม่สำเร็จ: ' + (saved && saved.message ? saved.message : saved);
      }
      showResult('สร้าง "' + r.name + '" สำเร็จ — ' + summary.text + ', ' + formatBytes(r.blob.size) + note, summary.warn);
      $('pdfShare').hidden = !PdfExport.canShareFiles(r.blob.type, r.name);
    } catch (e) {
      if (e && e.cancelled || S.cancelled) {
        showResult('หยุดการแปลงแล้ว', true);
      } else {
        console.error(e);
        showResult('แปลงไฟล์ไม่สำเร็จ: ' + (e && e.message ? e.message : e), true);
      }
    } finally {
      S.busy = false;
      S.cancelled = false;
      $('pdfCancel').disabled = false;
      syncForm();
    }
  }

  function share() {
    if (!S.last) return;
    PdfExport.share(S.last.blob, S.last.name).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      toast('แชร์ไม่สำเร็จ: ' + (e && e.message ? e.message : e), 'error');
    });
  }

  /** ค่าที่อ่านจาก localStorage (ทุกแอปใต้โดเมน github.io เดียวกันเขียนได้) ต้องเป็นชื่อในตารางจริง ไม่ใช่ constructor ฯลฯ */
  function own(table, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key); }

  function bind() {
    try {
      var f = loadPref('pdfConvertFormat', 'pdfConvertFormat');
      if (f === 'jpg' || f === 'docx') S.format = f;
      var q = loadPref('pdfJpegQuality', 'pdfJpegQuality');
      if (own(PdfTools.PRESETS, q)) $('pdfQuality').value = q;
      var font = loadPref('pdfDocxFont', 'pdfDocxFont');
      if (own(PdfTools.FONTS, font)) $('pdfFont').value = font;
      var lang = loadPref('ocrLang', 'ocrLang');
      if (OCR_LANGS.indexOf(lang) >= 0) $('pdfLang').value = lang;
    } catch (_) { /* ignore */ }
    // Android: หน้าเลือกไฟล์ของระบบกรองได้เฉพาะ MIME type (นามสกุล .pdf ใช้ไม่ได้) — Firefox บน Android ไม่กรองเลย
    // (ดู GECKO_ANDROID) ส่วนเบราว์เซอร์อื่นกรองด้วย application/pdf
    if (GECKO_ANDROID) $('pdfInput').removeAttribute('accept');
    else if (ANDROID) $('pdfInput').setAttribute('accept', 'application/pdf');
    $('btnPdfTools').addEventListener('click', pick);
    $('pdfPick').addEventListener('click', pick);
    $('pdfInput').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) open(file);
    });
    $('pdfFormats').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (chip) setFormat(chip.getAttribute('data-format'));
    });
    $('pdfFormats').addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      e.preventDefault();
      setFormat(S.format === 'jpg' ? 'docx' : 'jpg');
      var on = $('pdfFormats').querySelector('.chip[aria-checked="true"]');
      if (on) on.focus();
    });
    $('pdfQuality').addEventListener('change', function () {
      try { savePref('pdfJpegQuality', $('pdfQuality').value); } catch (_) { /* ignore */ }
    });
    $('pdfFont').addEventListener('change', function () {
      try { savePref('pdfDocxFont', $('pdfFont').value); } catch (_) { /* ignore */ }
    });
    $('pdfLang').addEventListener('change', function () {
      try { savePref('ocrLang', $('pdfLang').value); } catch (_) { /* ignore */ }
    });
    $('pdfMode').addEventListener('change', syncForm);
    ['pdfQuality', 'pdfMode', 'pdfFont', 'pdfLang'].forEach(function (id) {
      $(id).addEventListener('change', resetResult);
    });
    // ช่องเลขหน้า: ล้างผลตอนพิมพ์ ไม่ใช่ตอนออกจากช่อง (change) — ไม่งั้นผลที่หายไปตอนกดปุ่มแปลงทำให้ปุ่มเลื่อนหนีนิ้ว
    $('pdfPages').addEventListener('input', resetResult);
    $('pdfForm').addEventListener('submit', function (e) { e.preventDefault(); convert(); });
    $('pdfPasswordOk').addEventListener('click', submitPassword);
    // Enter ในช่องรหัสผ่าน: ปุ่มแปลงยังกดไม่ได้ระหว่างเปิดไฟล์ ฟอร์มจึงไม่ส่งเอง
    $('pdfPassword').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitPassword(); }
    });
    $('pdfCancel').addEventListener('click', close);
    $('pdfShare').addEventListener('click', share);
    $('pdfDialog').addEventListener('cancel', function (e) {
      e.preventDefault(); // Esc: ระหว่างแปลง = หยุด, ไม่งั้นปิดและคืนหน่วยความจำ
      close();
    });
    window.addEventListener('beforeunload', function (e) {
      if (S.busy) { e.preventDefault(); e.returnValue = ''; }
    });
    syncForm();
  }

  window.PdfConvert = {
    isAndroid: ANDROID, // ใช้ร่วมกับ js/app.js (ช่องเลือกรูปภาพ)
    open: open,
    isPdf: isPdf,
    isBusy: function () { return S.busy; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
