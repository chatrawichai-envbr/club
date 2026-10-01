/*
 * app.js — ควบคุมหน้าจอ รายการหน้าเอกสาร และลำดับงานประมวลผล
 */
(function () {
  'use strict';

  var MAX_SOURCE_SIDE = 3000;          // ความละเอียดสูงสุดของภาพต้นฉบับที่ใช้ทำงาน
  var PREVIEW_SIDE = 1200;             // ภาพตัวอย่างในหน้าแก้ไข
  var THUMB_WORK_SIDE = 520;           // ความละเอียดที่ใช้ประมวลผลภาพย่อ
  var THUMB_SIDE = 360;
  var MAX_FILE_BYTES = 60 * 1024 * 1024;
  var MAX_PIXELS = 120e6;
  var MAX_HEIF_PIXELS = 50e6;         // HEIC ถอดรหัสเป็น RGBA ในหน่วยความจำทั้งภาพ (50 MP ≈ 200 MB)
  var MAX_PAGES = 200;
  var SOURCE_CACHE_SIZE = 2;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    pages: [],
    current: -1,
    view: 'home',
    nextId: 1
  };

  // =====================================================================
  //  ตัวช่วยทั่วไป
  // =====================================================================

  function toast(msg, type) {
    var box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    var t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, type === 'error' ? 5000 : 3200);
  }

  function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function releaseCanvas(c) {
    if (c && c.width) { c.width = 0; c.height = 0; }
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function cvReady() { return window.CvEngine && CvEngine.isReady(); }

  function isAlive(page) { return state.pages.indexOf(page) >= 0; }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function formatBytes(n) {
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // =====================================================================
  //  คิวงานประมวลผล (งาน high ทำก่อน low; ทำพร้อมกันได้เท่าจำนวน Web Worker)
  // =====================================================================

  var jobs = { high: [], low: [] };
  var running = 0;

  function schedule(fn, priority) {
    return new Promise(function (resolve, reject) {
      jobs[priority === 'high' ? 'high' : 'low'].push({ fn: fn, resolve: resolve, reject: reject });
      pump();
    });
  }

  function pump() {
    var limit = Math.max(1, window.CvEngine ? CvEngine.concurrency() : 1);
    while (running < limit && (jobs.high.length || jobs.low.length)) {
      var job = jobs.high.shift() || jobs.low.shift();
      running++;
      sleep0() // คืนเวลาให้ UI ระหว่างงาน
        .then(job.fn)
        .then(job.resolve, job.reject)
        .then(function () { running--; pump(); });
    }
  }

  // =====================================================================
  //  โหลดรูปภาพ
  // =====================================================================

  var isImageFile = Scanner.isImageFile; // รวมถึง .jfif ที่ระบบบอกชนิดเป็นไฟล์ทั่วไป (js/scanner.js)

  function loadImageElement(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  /**
   * รูป HEIC/HEIF ที่เบราว์เซอร์ถอดรหัสเองไม่ได้ (Chrome, Edge, Firefox, WebView ของ Android) → libheif (js/heic.js)
   * ย่อให้ด้านยาวไม่เกิน MAX_SOURCE_SIDE เหมือนรูปอื่น — canvas ที่ได้มี fromHeif = true
   */
  async function decodeHeifToCanvas(blob) {
    var img = await window.HeicDecoder.decode(blob, MAX_HEIF_PIXELS);
    var full = makeCanvas(img.width, img.height);
    full.getContext('2d').putImageData(img, 0, 0);
    var s = Math.min(1, MAX_SOURCE_SIDE / Math.max(img.width, img.height));
    var c = full;
    if (s < 1) {
      c = makeCanvas(img.width * s, img.height * s);
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, 0, 0, c.width, c.height);
      releaseCanvas(full);
    }
    c.fromHeif = true;
    return c;
  }

  /** ถอดรหัสไฟล์รูปเป็น canvas โดยย่อให้ด้านยาวไม่เกิน MAX_SOURCE_SIDE (เคารพ EXIF orientation) */
  async function decodeToCanvas(blob) {
    var r;
    try {
      r = await loadImageElement(blob);
    } catch (e) {
      if (window.HeicDecoder && await window.HeicDecoder.isHeif(blob)) return decodeHeifToCanvas(blob);
      throw e;
    }
    try {
      var w = r.img.naturalWidth, h = r.img.naturalHeight;
      if (!w || !h) throw new Error('decode');
      if (w * h > MAX_PIXELS) {
        var err = new Error('too-large');
        err.code = 'too-large';
        throw err;
      }
      var s = Math.min(1, MAX_SOURCE_SIDE / Math.max(w, h));
      var c = makeCanvas(w * s, h * s);
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(r.img, 0, 0, c.width, c.height);
      return c;
    } finally {
      URL.revokeObjectURL(r.url);
    }
  }

  // แคชภาพต้นฉบับที่ถอดรหัสแล้ว (เก็บเฉพาะไม่กี่หน้า เพื่อประหยัดหน่วยความจำบนมือถือ)
  // งานที่กำลังใช้ภาพต้อง "ปักหมุด" ด้วย acquireSource/releaseSource เพื่อไม่ให้ภาพถูกคืนหน่วยความจำระหว่างใช้งาน
  var sourceCache = new Map();
  var sourcePins = new Map();
  var decoding = new Map();

  function isPinned(pageId) { return (sourcePins.get(pageId) || 0) > 0; }

  function cacheSource(pageId, canvas) {
    sourceCache.delete(pageId);
    sourceCache.set(pageId, canvas);
    var keys = Array.from(sourceCache.keys());
    for (var i = 0; i < keys.length && sourceCache.size > SOURCE_CACHE_SIZE; i++) {
      if (keys[i] === pageId || isPinned(keys[i])) continue;
      releaseCanvas(sourceCache.get(keys[i]));
      sourceCache.delete(keys[i]);
    }
  }

  /** ได้ภาพต้นฉบับของหน้า (ถอดรหัสใหม่ถ้าไม่อยู่ในแคช) และปักหมุดไว้จนกว่าจะเรียก releaseSource */
  async function acquireSource(page) {
    sourcePins.set(page.id, (sourcePins.get(page.id) || 0) + 1);
    try {
      var canvas = sourceCache.get(page.id);
      if (!canvas || !canvas.width) {
        if (!page.blob) throw new Error('หน้าถูกลบแล้ว');
        var pending = decoding.get(page.id);
        if (!pending) {
          pending = decodeToCanvas(page.blob);
          decoding.set(page.id, pending);
          var clear = function () { decoding.delete(page.id); };
          pending.then(clear, clear);
        }
        canvas = await pending;
      }
      cacheSource(page.id, canvas);
      return canvas;
    } catch (e) {
      releaseSource(page);
      throw e;
    }
  }

  function releaseSource(page) {
    var n = (sourcePins.get(page.id) || 0) - 1;
    if (n > 0) sourcePins.set(page.id, n); else sourcePins.delete(page.id);
  }

  function dropSource(pageId) {
    if (sourceCache.has(pageId)) {
      // ภาพที่งานอื่นกำลังใช้อยู่: ไม่คืนหน่วยความจำทันที ปล่อยให้ระบบเก็บกวาดเอง
      if (!isPinned(pageId)) releaseCanvas(sourceCache.get(pageId));
      sourceCache.delete(pageId);
    }
  }

  function createPage(blob, name, canvas) {
    return {
      id: state.nextId++,
      name: name,
      blob: blob,
      srcW: canvas.width,
      srcH: canvas.height,
      quad: Scanner.fullQuad(canvas.width, canvas.height),
      needsDetect: true,
      settings: Scanner.defaultSettings(),
      version: 0,
      thumbUrl: null,
      thumbPending: false,
      processed: false
    };
  }

  var reservedPages = 0; // หน้าที่กำลังรอเพิ่มในคิว (ใช้ตรวจจำนวนหน้าสูงสุด)
  var addGeneration = 0; // เพิ่มค่าเมื่อ "ลบทั้งหมด" เพื่อยกเลิกรูปที่ยังรอเพิ่มอยู่ในคิว

  var lastInsert = Promise.resolve(); // ใส่หน้าตามลำดับที่ผู้ใช้เลือก แม้จะถอดรหัสภาพพร้อมกันหลายไฟล์

  function addOne(blob, name) {
    var gen = addGeneration;
    var prev = lastInsert;
    var inserted;
    lastInsert = new Promise(function (resolve) { inserted = resolve; });
    return schedule(async function () {
      var canvas = null;
      try {
        if (gen !== addGeneration) return false;
        canvas = await decodeToCanvas(blob);
        // HEIC: เก็บหน้าเป็น JPEG คุณภาพสูง — เปิดซ้ำ/สร้าง PDF ไม่ต้องถอดรหัส HEIC ใหม่ทุกครั้ง
        if (canvas.fromHeif) blob = (await canvasToBlob(canvas, 'image/jpeg', 0.95)) || blob;
        await prev; // รอให้ไฟล์ก่อนหน้าถูกใส่ก่อน เพื่อคงลำดับหน้า
        if (gen !== addGeneration) { releaseCanvas(canvas); return false; }
        var page = createPage(blob, name, canvas);
        state.pages.push(page);
        cacheSource(page.id, canvas);
        await setThumbFromCanvas(page, canvas, true);
        renderGrid();
        processPage(page);
        return true;
      } catch (e) {
        if (e && e.code === 'too-large') toast('ข้าม "' + name + '" — ภาพมีความละเอียดสูงเกินไป', 'error');
        else toast('เปิด "' + name + '" ไม่ได้ (ไฟล์เสียหรือรูปแบบที่เบราว์เซอร์ไม่รองรับ)', 'error');
        return false;
      } finally {
        await prev.catch(function () { /* ignore */ });
        inserted();
      }
    }, 'high');
  }

  async function addBlobs(items) {
    var tasks = [];
    for (var i = 0; i < items.length; i++) {
      var blob = items[i].blob, name = String(items[i].name || 'image');
      if (state.pages.length + reservedPages >= MAX_PAGES) {
        toast('เพิ่มได้สูงสุด ' + MAX_PAGES + ' หน้าต่อไฟล์', 'error');
        break;
      }
      if (!items[i].trusted && !isImageFile(blob)) {
        toast('ข้าม "' + name + '" — ไม่ใช่ไฟล์รูปภาพ', 'error');
        continue;
      }
      if (!blob.size || blob.size > MAX_FILE_BYTES) {
        toast('ข้าม "' + name + '" — ' + (blob.size ? 'ไฟล์ใหญ่เกิน ' + formatBytes(MAX_FILE_BYTES) : 'ไฟล์ว่างเปล่า'), 'error');
        continue;
      }
      reservedPages++;
      tasks.push(addOne(blob, name).then(function (ok) { reservedPages--; return ok; },
        function () { reservedPages--; return false; }));
    }
    var results = await Promise.all(tasks);
    return results.filter(Boolean).length;
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    // ไฟล์ PDF (ลากมาวาง/เลือกมา) → หน้าต่าง "แปลงไฟล์ PDF" ครั้งละ 1 ไฟล์
    var pdfs = window.PdfConvert ? files.filter(PdfConvert.isPdf) : [];
    if (pdfs.length) {
      files = files.filter(function (f) { return pdfs.indexOf(f) < 0; });
      if (pdfs.length > 1) toast('แปลงไฟล์ PDF ได้ครั้งละ 1 ไฟล์ — เปิด "' + pdfs[0].name + '"', 'error');
      PdfConvert.open(pdfs[0]);
    }
    if (!files.length) return;
    var n = await addBlobs(files.map(function (f) { return { blob: f, name: f.name }; }));
    if (n) toast('เพิ่ม ' + n + ' หน้าแล้ว', 'ok');
  }

  // =====================================================================
  //  ประมวลผลหน้า (ตรวจจับขอบ + ภาพย่อ)
  // =====================================================================

  function processPage(page) {
    if (!cvReady()) return; // จะถูกเรียกอีกครั้งเมื่อ OpenCV พร้อม
    scheduleThumb(page, true);
  }

  function scheduleThumb(page, withDetect) {
    if (withDetect) page.detectRequested = true;
    if (page.thumbPending) return;
    page.thumbPending = true;
    renderGridItemState(page);
    schedule(async function () {
      page.thumbPending = false;
      if (!isAlive(page) || !cvReady()) return;
      var src = await acquireSource(page);
      var out = null;
      try {
        if (!isAlive(page)) return;
        if (page.needsDetect && page.detectRequested) {
          var q = null;
          try { q = await CvEngine.detect(src, 'low'); } catch (e) { console.warn('detect failed', e); }
          // ผู้ใช้อาจครอปเองระหว่างรอผลตรวจจับ: ห้ามเขียนทับกรอบของผู้ใช้
          if (page.needsDetect) {
            if (q) page.quad = q;
            page.needsDetect = false;
            page.version++;
          }
          page.detectRequested = false;
          if (!isAlive(page)) return;
        }
        var version = page.version;
        out = await CvEngine.warpProcess(src, page.quad, THUMB_WORK_SIDE, page.settings, 'low');
        if (!isAlive(page)) return;
        await setThumbFromCanvas(page, out, false);
        page.processed = true;
        renderGridItemState(page);
        if (page.version !== version) scheduleThumb(page, false);
        // หน้าที่เปิดแก้ไขอยู่ได้กรอบใหม่จากการตรวจจับอัตโนมัติ: แสดงผลใหม่
        if (state.view === 'editor' && currentPage() === page &&
            (editorCache.pageId !== page.id || editorCache.key !== quadKey(page))) renderEditorPreview();
      } finally {
        releaseCanvas(out);
        releaseSource(page);
      }
    }, 'low').catch(function (e) {
      console.error(e);
      page.thumbPending = false;
      renderGridItemState(page, 'ประมวลผลไม่สำเร็จ');
    });
  }

  function canvasToBlob(canvas, type, q) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, q); });
  }

  async function setThumbFromCanvas(page, canvas, raw) {
    var s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
    var t = makeCanvas(canvas.width * s, canvas.height * s);
    var ctx = t.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (raw && page.settings.rotation) {
      var r = Scanner.rotateCanvas(canvas, page.settings.rotation);
      t = makeCanvas(r.width * s, r.height * s);
      t.getContext('2d').drawImage(r, 0, 0, t.width, t.height);
      if (r !== canvas) releaseCanvas(r);
    } else {
      ctx.drawImage(canvas, 0, 0, t.width, t.height);
    }
    var blob = await canvasToBlob(t, 'image/jpeg', 0.85);
    releaseCanvas(t);
    if (!blob) return;
    if (!isAlive(page)) return;
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    page.thumbUrl = URL.createObjectURL(blob);
    var img = document.querySelector('.page-item[data-id="' + page.id + '"] img');
    if (img) img.src = page.thumbUrl;
  }

  // =====================================================================
  //  หน้าหลัก: รายการหน้า
  // =====================================================================

  function iconSvg(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  function iconButton(icon, label, action, disabled) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-icon' + (action === 'delete' ? ' danger' : '');
    b.setAttribute('aria-label', label);
    b.title = label;
    b.dataset.action = action;
    b.disabled = !!disabled;
    b.appendChild(iconSvg(icon));
    return b;
  }

  function pageStateText(page) {
    if (!cvReady() && CvEngine.getState() !== 'error') return 'รอตัวประมวลผลภาพ…';
    if (page.thumbPending) return 'กำลังประมวลผล…';
    return '';
  }

  function renderGridItemState(page, override) {
    var item = document.querySelector('.page-item[data-id="' + page.id + '"] .page-state');
    if (!item) return;
    var text = override || pageStateText(page);
    item.textContent = text;
    item.hidden = !text;
  }

  function renderGrid() {
    var grid = $('pageGrid');
    grid.textContent = '';
    var n = state.pages.length;
    state.pages.forEach(function (page, i) {
      var li = document.createElement('li');
      li.className = 'page-item';
      li.dataset.id = String(page.id);

      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'page-card';
      card.dataset.action = 'open';
      card.setAttribute('aria-label', 'แก้ไขหน้า ' + (i + 1));
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      if (page.thumbUrl) img.src = page.thumbUrl;
      var num = document.createElement('span');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      var st = document.createElement('span');
      st.className = 'page-state';
      var text = pageStateText(page);
      st.textContent = text;
      st.hidden = !text;
      card.appendChild(img);
      card.appendChild(num);
      card.appendChild(st);

      var actions = document.createElement('div');
      actions.className = 'page-actions';
      actions.appendChild(iconButton('i-left', 'เลื่อนหน้า ' + (i + 1) + ' ไปก่อนหน้า', 'left', i === 0));
      actions.appendChild(iconButton('i-trash', 'ลบหน้า ' + (i + 1), 'delete'));
      actions.appendChild(iconButton('i-right', 'เลื่อนหน้า ' + (i + 1) + ' ไปถัดไป', 'right', i === n - 1));

      li.appendChild(card);
      li.appendChild(actions);
      grid.appendChild(li);
    });

    $('pageCount').textContent = String(n);
    $('pagesSection').hidden = n === 0;
    $('homeBar').hidden = n === 0;
    $('emptyState').hidden = n > 0;
    $('btnExportCount').textContent = ' (' + n + ' หน้า)';
  }

  function movePage(page, delta) {
    var i = state.pages.indexOf(page), j = i + delta;
    if (i < 0 || j < 0 || j >= state.pages.length) return;
    state.pages.splice(i, 1);
    state.pages.splice(j, 0, page);
    renderGrid();
    var btn = document.querySelector('.page-item[data-id="' + page.id + '"] [data-action="' + (delta < 0 ? 'left' : 'right') + '"]');
    if (btn && !btn.disabled) btn.focus();
  }

  function deletePage(page) {
    var i = state.pages.indexOf(page);
    if (i < 0) return;
    state.pages.splice(i, 1);
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    page.thumbUrl = null;
    page.blob = null;
    dropSource(page.id);
    if (editorCache.pageId === page.id) clearEditorCache();
    renderGrid();
  }

  function clearAll() {
    addGeneration++;
    ocrCache.clear();
    state.pages.slice().forEach(deletePage);
    state.current = -1;
    sourceCache.forEach(function (c) { releaseCanvas(c); });
    sourceCache.clear();
    clearEditorCache();
    renderGrid();
  }

  // =====================================================================
  //  การนำทาง (รองรับปุ่มย้อนกลับของมือถือ)
  // =====================================================================

  var homeScroll = 0;

  function showView(name) {
    if (state.view === 'home' && name !== 'home') homeScroll = window.scrollY;
    state.view = name;
    $('viewHome').hidden = name !== 'home';
    $('viewEditor').hidden = name !== 'editor';
    $('viewCrop').hidden = name !== 'crop';
    window.scrollTo(0, name === 'home' ? homeScroll : 0);
  }

  function pushHistory(v) {
    try { history.pushState({ v: v }, ''); } catch (_) { /* ignore */ }
  }

  function historyIs(v) {
    try { return !!history.state && history.state.v === v; } catch (_) { return false; }
  }

  /** ย้อนกลับหนึ่งขั้น: ใช้ history ถ้ามี มิฉะนั้นจัดการเอง */
  function goBack(fromView) {
    if (historyIs(fromView)) history.back();
    else onNavigateBack(fromView);
  }

  function onNavigateBack(fromView) {
    if (fromView === 'camera') {
      if (camera.isOpen()) camera.close();
    } else if (fromView === 'crop') {
      endCrop();
      showView('editor');
      renderEditor();
    } else if (fromView === 'editor') {
      leaveEditor();
    }
  }

  window.addEventListener('popstate', function (e) {
    var target = (e.state && e.state.v) || 'home';
    if (isOcrOpen()) closeOcr();
    if (camera.isOpen() && target !== 'camera') { camera.close(); return; }
    if (state.view === 'crop' && target !== 'crop') {
      endCrop();
      if (target === 'editor' && currentPage()) { showView('editor'); renderEditor(); }
      else leaveEditor();
      return;
    }
    if (state.view === 'editor' && target === 'home') leaveEditor();
  });

  // =====================================================================
  //  หน้าแก้ไข
  // =====================================================================

  var editorCache = { pageId: null, key: '', canvas: null };
  var previewToken = 0;

  function currentPage() { return state.pages[state.current] || null; }

  function quadKey(page) {
    return page.quad.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(';');
  }

  function clearEditorCache() {
    releaseCanvas(editorCache.canvas);
    editorCache = { pageId: null, key: '', canvas: null };
  }

  function openEditor(page) {
    var i = state.pages.indexOf(page);
    if (i < 0) return;
    state.current = i;
    if (state.view !== 'editor') pushHistory('editor');
    showView('editor');
    renderEditor();
  }

  function leaveEditor() {
    clearEditorCache();
    showView('home');
    renderGrid();
    var p = currentPage();
    if (p) {
      var card = document.querySelector('.page-item[data-id="' + p.id + '"] .page-card');
      if (card) card.focus();
    }
  }

  function renderEditor() {
    var page = currentPage();
    if (!page) { leaveEditor(); return; }
    var n = state.pages.length;
    $('editorTitle').textContent = 'หน้า ' + (state.current + 1) + ' / ' + n;
    $('edPrev').disabled = state.current <= 0;
    $('edNext').disabled = state.current >= n - 1;
    syncControls(page.settings);
    renderEditorPreview();
  }

  function syncControls(st) {
    Array.prototype.forEach.call($('edFilters').querySelectorAll('.chip'), function (c) {
      var on = c.dataset.filter === st.filter;
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    });
    var isBw = st.filter === 'bw';
    $('edShadow').checked = isBw ? true : !!st.removeShadow;
    $('edShadow').disabled = isBw;
    $('edShadowNote').textContent = isBw
      ? 'โหมดขาวดำลบเงาให้อัตโนมัติเสมอ'
      : 'ปรับพื้นกระดาษให้สว่างเรียบ ลบเงามือ/เงาโทรศัพท์';
    $('edBrightness').value = st.brightness;
    $('edBrightnessVal').textContent = String(st.brightness);
    $('edContrast').value = st.contrast;
    $('edContrastVal').textContent = String(st.contrast);
    $('edStrength').value = st.bwStrength;
    $('edStrengthVal').textContent = String(st.bwStrength);
    $('edContrastRow').hidden = isBw;
    $('edStrengthRow').hidden = !isBw;
  }

  function settingsChanged(page) {
    page.version++;
    renderEditorPreviewDebounced();
  }

  function renderEditorPreview() {
    var page = currentPage();
    if (!page || state.view !== 'editor') return;
    var token = ++previewToken;
    $('edBusy').hidden = false;
    schedule(async function () {
      if (token !== previewToken || !isAlive(page) || currentPage() !== page) return;
      var version = page.version;
      var out = null;
      var src = await acquireSource(page);
      try {
        if (token !== previewToken || !isAlive(page)) return;
        if (!cvReady()) {
          // ยังไม่มี OpenCV: แสดงภาพดิบไปก่อน
          var sc = Scanner.scaledCanvas(src, PREVIEW_SIDE).canvas;
          out = Scanner.rotateCanvas(sc, page.settings.rotation);
          if (out !== sc) releaseCanvas(sc);
        } else {
          // เก็บภาพที่ครอปแล้วไว้ใช้ซ้ำ: ขยับแถบเลื่อนจะประมวลผลเฉพาะฟิลเตอร์
          var key = quadKey(page);
          var warped = editorCache.pageId === page.id && editorCache.key === key ? editorCache.canvas : null;
          if (!warped || !warped.width) {
            warped = await CvEngine.warp(src, page.quad, PREVIEW_SIDE, 'high');
            if (token !== previewToken || currentPage() !== page || quadKey(page) !== key) { releaseCanvas(warped); return; }
            clearEditorCache();
            editorCache = { pageId: page.id, key: key, canvas: warped };
          }
          out = await CvEngine.process(warped, page.settings, 'high');
        }
        if (token !== previewToken || currentPage() !== page) return;
        var view = $('edPreview');
        view.width = out.width;
        view.height = out.height;
        view.getContext('2d').drawImage(out, 0, 0);
        await setThumbFromCanvas(page, out, false);
        if (cvReady()) {
          page.processed = true;
          if (page.version === version) renderGridItemState(page);
        }
      } finally {
        releaseCanvas(out);
        releaseSource(page);
      }
    }, 'high').catch(function (e) {
      console.error(e);
      toast('ประมวลผลภาพไม่สำเร็จ: ' + (e && e.message ? e.message : e), 'error');
    }).then(function () {
      if (token === previewToken) $('edBusy').hidden = true;
    });
  }

  var renderEditorPreviewDebounced = debounce(renderEditorPreview, 120);

  function bindEditor() {
    $('edBack').addEventListener('click', function () { goBack('editor'); });
    $('edPrev').addEventListener('click', function () {
      if (state.current > 0) { state.current--; clearEditorCache(); renderEditor(); }
    });
    $('edNext').addEventListener('click', function () {
      if (state.current < state.pages.length - 1) { state.current++; clearEditorCache(); renderEditor(); }
    });

    $('edFilters').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      var page = currentPage();
      if (!chip || !page) return;
      page.settings.filter = chip.dataset.filter;
      syncControls(page.settings);
      settingsChanged(page);
    });
    $('edFilters').addEventListener('keydown', function (e) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key) < 0) return;
      var page = currentPage();
      if (!page) return;
      e.preventDefault();
      var list = Scanner.FILTERS;
      var i = list.indexOf(page.settings.filter);
      i = (i + ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1) + list.length) % list.length;
      page.settings.filter = list[i];
      syncControls(page.settings);
      var chip = $('edFilters').querySelector('[data-filter="' + list[i] + '"]');
      if (chip) chip.focus();
      settingsChanged(page);
    });

    $('edShadow').addEventListener('change', function () {
      var page = currentPage();
      if (!page) return;
      page.settings.removeShadow = $('edShadow').checked;
      settingsChanged(page);
    });

    [['edBrightness', 'brightness', 'edBrightnessVal'],
      ['edContrast', 'contrast', 'edContrastVal'],
      ['edStrength', 'bwStrength', 'edStrengthVal']].forEach(function (cfg) {
      $(cfg[0]).addEventListener('input', function () {
        var page = currentPage();
        if (!page) return;
        var v = Math.round(Number($(cfg[0]).value)) || 0;
        page.settings[cfg[1]] = v;
        $(cfg[2]).textContent = String(v);
        settingsChanged(page);
      });
    });

    function rotate(delta) {
      var page = currentPage();
      if (!page) return;
      page.settings.rotation = (((page.settings.rotation || 0) + delta) % 360 + 360) % 360;
      settingsChanged(page);
    }
    $('edRotL').addEventListener('click', function () { rotate(-90); });
    $('edRotR').addEventListener('click', function () { rotate(90); });

    $('edReset').addEventListener('click', function () {
      var page = currentPage();
      if (!page) return;
      page.settings = Scanner.defaultSettings();
      syncControls(page.settings);
      settingsChanged(page);
    });

    $('edApplyAll').addEventListener('click', function () {
      var page = currentPage();
      if (!page) return;
      var src = page.settings;
      var count = 0;
      state.pages.forEach(function (p) {
        if (p === page) return;
        p.settings = Object.assign({}, p.settings, {
          filter: src.filter,
          removeShadow: src.removeShadow,
          brightness: src.brightness,
          contrast: src.contrast,
          bwStrength: src.bwStrength
        });
        p.version++;
        scheduleThumb(p, false);
        count++;
      });
      toast(count ? 'ใช้การตั้งค่านี้กับอีก ' + count + ' หน้าแล้ว' : 'มีเพียงหน้าเดียว', 'ok');
    });

    $('edDelete').addEventListener('click', function () {
      var page = currentPage();
      if (!page) return;
      if (!window.confirm('ลบหน้า ' + (state.current + 1) + ' ใช่หรือไม่?')) return;
      deletePage(page);
      if (!state.pages.length) { state.current = -1; goBack('editor'); return; }
      state.current = Math.min(state.current, state.pages.length - 1);
      renderEditor();
    });

    $('edCrop').addEventListener('click', startCrop);
  }

  // =====================================================================
  //  หน้าครอป
  // =====================================================================

  var cropEditor = null;
  var cropSession = null;

  function startCrop() {
    var page = currentPage();
    if (!page) return;
    var session = cropSession = { page: page, pinned: false };
    pushHistory('crop');
    showView('crop');
    $('cropAuto').disabled = !cvReady();
    $('cropOk').disabled = true;
    acquireSource(page).then(function (src) {
      // ภาพถูกปักหมุดไว้ตลอดการครอป และปล่อยใน endCrop()
      if (cropSession !== session || state.view !== 'crop') { releaseSource(page); return; }
      session.src = src;
      session.pinned = true;
      cropEditor.open(src, page.quad);
    }).catch(function (e) {
      console.error(e);
      toast('เปิดภาพไม่สำเร็จ', 'error');
      goBack('crop');
    });
  }

  function endCrop() {
    if (cropSession && cropSession.pinned) releaseSource(cropSession.page);
    cropSession = null;
    if (cropEditor) cropEditor.release();
  }

  function bindCrop() {
    cropEditor = CropEditor.create($('cropStage'), {
      onChange: function (valid) {
        $('cropOk').disabled = !valid;
        var hint = $('cropHint');
        hint.classList.toggle('error', !valid);
        hint.textContent = valid
          ? 'ลากจุดที่มุมหรือขอบเพื่อครอปอย่างอิสระ'
          : 'กรอบไม่ถูกต้อง (มุมไขว้กันหรือเล็กเกินไป) กรุณาปรับจุดมุม';
      }
    });

    $('cropCancel').addEventListener('click', function () { goBack('crop'); });

    $('cropOk').addEventListener('click', function () {
      if (!cropSession || !cropEditor.isValid()) return;
      var page = cropSession.page;
      var q = cropEditor.getQuad();
      if (q && isAlive(page)) {
        page.quad = q;
        page.needsDetect = false;
        page.version++;
        clearEditorCache();
      }
      goBack('crop');
    });

    $('cropFull').addEventListener('click', function () {
      if (!cropSession || !cropSession.src) return;
      cropEditor.setQuad(Scanner.fullQuad(cropSession.src.width, cropSession.src.height));
    });

    $('cropAuto').addEventListener('click', function () {
      if (!cropSession || !cropSession.src || !cvReady()) return;
      var btn = $('cropAuto');
      btn.disabled = true;
      var session = cropSession;
      CvEngine.detect(session.src, 'high').then(function (q) {
        if (cropSession !== session) return;
        if (q) { cropEditor.setQuad(q); toast('ตรวจพบขอบกระดาษแล้ว', 'ok'); }
        else toast('ไม่พบขอบกระดาษ กรุณาลากจุดมุมเอง', 'error');
      }).catch(function (e) {
        console.error(e);
        toast('ตรวจจับขอบไม่สำเร็จ', 'error');
      }).then(function () { btn.disabled = !cvReady(); });
    });
  }

  // =====================================================================
  //  กล้อง
  // =====================================================================

  var camera = null;
  var cameraFailed = false;         // ใช้กล้องในแอปไม่ได้แล้วครั้งหนึ่ง → ครั้งต่อไปเปิดกล้องของเครื่องเลย
  var cameraPermission = 'unknown'; // สิทธิ์กล้องจาก Permissions API: granted | denied | prompt | unknown
  // localStorage ใช้ร่วมกับทุกแอปใต้ envburiramclub.github.io: key ขึ้นต้นด้วยชื่อโฟลเดอร์เสมอ
  // ยังไม่มีค่าใหม่ → อ่าน key เดิมที่ไม่มีคำนำหน้า (ผู้ใช้ไม่เสียค่าที่ตั้งไว้) แต่ไม่ลบ เพราะแอปอื่นอาจใช้ชื่อเดียวกัน
  // ค่าที่อ่านได้ต้องตรวจก่อนใช้ทุกครั้ง (แอปอื่นเขียนทับได้)
  var PREF_PREFIX = 'doc2pdf:';
  function loadPref(name, legacy) {
    var v = localStorage.getItem(PREF_PREFIX + name);
    return v === null && legacy ? localStorage.getItem(legacy) : v;
  }
  function savePref(name, value) { localStorage.setItem(PREF_PREFIX + name, value); }
  var CAMERA_BLOCKED_KEY = 'cameraBlocked';
  var CAMERA_BLOCKED_LEGACY = 'inAppCameraBlocked';
  var CAMERA_BLOCKED_MS = 7 * 24 * 3600 * 1000;

  function openNativeCamera() {
    $('captureInput').value = '';
    $('captureInput').click();
  }

  /** จำว่าเบราว์เซอร์นี้ไม่อนุญาตกล้องในแอป (เช่น เบราว์เซอร์ในแอป LINE ที่ Permissions API ไม่บอก) — ครั้งหน้าเปิดกล้องของเครื่องเลย */
  function rememberCameraBlocked(on) {
    try {
      if (on) savePref(CAMERA_BLOCKED_KEY, String(Date.now()));
      else {
        localStorage.removeItem(PREF_PREFIX + CAMERA_BLOCKED_KEY);
        localStorage.removeItem(CAMERA_BLOCKED_LEGACY); // ชื่อนี้ doc2pdf ตั้งเอง ลบได้ (ไม่งั้นอ่านค่าเดิมกลับมาอีก)
      }
    } catch (_) { /* ignore */ }
  }

  function cameraBlockedRemembered() {
    try {
      var t = Number(loadPref(CAMERA_BLOCKED_KEY, CAMERA_BLOCKED_LEGACY));
      var age = Date.now() - t;
      return t > 0 && age >= 0 && age < CAMERA_BLOCKED_MS;
    } catch (_) {
      return false;
    }
  }

  /** ติดตามสิทธิ์กล้อง: ถ้าผู้ใช้ไปอนุญาตในการตั้งค่า กล้องในแอปกลับมาใช้ได้ทันที */
  function watchCameraPermission() {
    function update(st) {
      cameraPermission = st && typeof st.state === 'string' ? st.state : 'unknown';
      if (cameraPermission === 'granted') {
        cameraFailed = false;
        rememberCameraBlocked(false);
      }
      refreshCameraButtons();
    }
    try {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return;
      navigator.permissions.query({ name: 'camera' }).then(function (st) {
        update(st);
        try { st.addEventListener('change', function () { update(st); }); } catch (_) { /* ignore */ }
      }, function () { /* เบราว์เซอร์ไม่รู้จักสิทธิ์ camera */ });
    } catch (_) { /* ignore */ }
  }

  /** กล้องในแอปใช้ไม่ได้: "ถ่ายภาพ" เปิดกล้องของเครื่องอยู่แล้ว จึงซ่อนปุ่มที่ซ้ำกัน */
  function refreshCameraButtons() {
    var btn = $('btnNativeCamera');
    if (btn) btn.hidden = !inAppCameraUsable();
  }

  function bindCamera() {
    camera = Camera.create({
      elements: {
        view: $('viewCamera'), video: $('camVideo'), overlay: $('camOverlay'),
        close: $('camClose'), torch: $('camTorch'), shutter: $('camShutter'),
        done: $('camDone'), count: $('camCount'), msg: $('camMsg'), flash: $('camFlash'),
        blocked: $('camBlocked'), blockedTitle: $('camBlockedTitle'), blockedText: $('camBlockedText'),
        blockedHelp: $('camBlockedHelp'), useNative: $('camUseNative'), retry: $('camRetry')
      },
      canDetect: cvReady,
      detect: function (canvas) { return CvEngine.detect(canvas, 'high'); },
      onCapture: function (blob) {
        var n = state.pages.length + 1;
        return addBlobs([{ blob: blob, name: 'กล้อง-หน้า-' + n + '.jpg', trusted: true }]);
      },
      requestClose: function () { goBack('camera'); },
      onOpen: function () {
        cameraFailed = false;
        rememberCameraBlocked(false);
        refreshCameraButtons();
      },
      // จากปุ่มในหน้ากล้อง: เปิดกล้องของเครื่องก่อน (ยังอยู่ในจังหวะที่ผู้ใช้แตะ) แล้วจึงปิดหน้ากล้อง
      onUseNative: function () {
        openNativeCamera();
        goBack('camera');
      },
      onClose: function (count) {
        if (count) toast('เพิ่มจากกล้อง ' + count + ' หน้า', 'ok');
        var btn = $('btnCamera');
        if (btn) btn.focus();
      },
      // หน้ากล้องแสดงเหตุผลและปุ่ม "ใช้กล้องของเครื่อง" แล้ว (ไม่เปิดให้เองที่นี่: พ้นจังหวะที่ผู้ใช้แตะไปแล้ว มือถือจะไม่ยอมเปิด)
      onUnavailable: function (reason, e) {
        cameraFailed = true;
        if (reason === 'denied' && cameraPermission !== 'granted') rememberCameraBlocked(true);
        refreshCameraButtons();
        if (e) console.info('in-app camera unavailable:', e.name || e);
      }
    });
  }

  /** หน้าเว็บถูกฝังในกรอบที่ไม่อนุญาตให้ใช้กล้อง (permissions policy) — ตรวจได้เฉพาะเบราว์เซอร์ที่มี API นี้ */
  function cameraBlockedByPolicy() {
    var policy = document.permissionsPolicy || document.featurePolicy;
    try {
      return !!(policy && typeof policy.allowsFeature === 'function' && !policy.allowsFeature('camera'));
    } catch (e) {
      return false;
    }
  }

  /**
   * ใช้กล้องในแอป (getUserMedia) ได้หรือไม่ — ถ้าไม่ได้ ปุ่ม "ถ่ายภาพ" เปิดกล้องของเครื่องทันที
   * (ต้องเปิดในจังหวะที่ผู้ใช้กดปุ่ม ถ้ารอให้กล้องในแอปล้มเหลวก่อน มือถือบางรุ่นจะไม่ยอมเปิดให้)
   *   - แพลตฟอร์มแจ้งว่าใช้ไม่ได้ (AppPlatform.inAppCamera === false) เช่น Google Apps Script ที่ไม่อนุญาตกล้องในกรอบ
   *   - เบราว์เซอร์ไม่มี getUserMedia (เช่น เปิดผ่าน http) หรือกรอบที่ฝังหน้าเว็บไม่อนุญาตกล้อง
   *   - เบราว์เซอร์แจ้งว่าไม่อนุญาตกล้อง (Permissions API)
   *   - ล้มเหลวไปแล้วในครั้งนี้ หรือไม่ได้รับอนุญาตภายใน 7 วันที่ผ่านมา (ข้อหลังยกเว้นเมื่อเบราว์เซอร์แจ้งว่าอนุญาตแล้ว)
   */
  function inAppCameraUsable() {
    var P = window.AppPlatform;
    if (P && P.inAppCamera === false) return false;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
    if (cameraBlockedByPolicy()) return false;
    if (cameraPermission === 'denied' || cameraFailed) return false;
    return cameraPermission === 'granted' || !cameraBlockedRemembered();
  }

  function startCamera() {
    if (!inAppCameraUsable()) { openNativeCamera(); return; }
    pushHistory('camera');
    camera.open().then(function (ok) {
      if (ok) $('camShutter').focus();
    });
  }

  // =====================================================================
  //  สร้าง PDF
  // =====================================================================

  var exporting = false;
  var exportCancelled = false;
  var lastPdf = null;

  function exportOptions() {
    return {
      pageSize: $('exPageSize').value,
      orientation: $('exOrientation').value,
      margin: Number($('exMargin').value) || 0,
      quality: $('exQuality').value,
      ocr: $('exOcr').checked && Ocr.isSupported(),
      ocrLang: Ocr.LANGS.indexOf($('exOcrLang').value) >= 0 ? $('exOcrLang').value : 'tha+eng'
    };
  }

  function setExportBusy(busy) {
    exporting = busy;
    ['exDownload', 'exShare', 'exFilename', 'exPageSize', 'exOrientation', 'exMargin', 'exQuality', 'exOcrLang']
      .forEach(function (id) { $(id).disabled = busy; });
    $('exOcr').disabled = busy || !Ocr.isSupported();
    // ระหว่างสร้าง ปุ่ม "ปิด" เปลี่ยนเป็น "หยุด" (OCR หลายหน้าใช้เวลานาน)
    $('exCancel').textContent = busy ? 'หยุด' : 'ปิด';
    $('exCancel').disabled = false;
    $('exProgressWrap').hidden = !busy;
  }

  function cancelExport() {
    if (!exporting || exportCancelled) return;
    exportCancelled = true;
    $('exCancel').disabled = true;
    $('exProgressText').textContent = 'กำลังหยุด…';
    Ocr.cancelAll();
  }

  function showExportResult(text, isError) {
    var r = $('exResult');
    r.textContent = text;
    r.classList.toggle('error', !!isError);
    r.hidden = false;
  }

  function openExportDialog() {
    if (!state.pages.length) { toast('ยังไม่มีหน้าเอกสาร', 'error'); return; }
    var dlg = $('exportDialog');
    PdfExport.preload(); // โหลด jsPDF ระหว่างผู้ใช้เลือกตัวเลือก
    if (!$('exFilename').value) $('exFilename').value = PdfExport.defaultName();
    $('exResult').hidden = true;
    $('exShare').hidden = true;
    lastPdf = null;
    $('exProgress').value = 0;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeExportDialog() {
    if (exporting) { cancelExport(); return; }
    var dlg = $('exportDialog');
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  async function renderPageForPdf(page, maxSide) {
    return schedule(async function () {
      var src = await acquireSource(page);
      try {
        if (!cvReady()) {
          var sc = Scanner.scaledCanvas(src, maxSide).canvas;
          var r = Scanner.rotateCanvas(sc, page.settings.rotation);
          if (r !== sc) releaseCanvas(sc);
          return r;
        }
        return await CvEngine.warpProcess(src, page.quad, maxSide, page.settings, 'high');
      } finally {
        releaseSource(page);
      }
    }, 'high');
  }

  async function doExport() {
    if (exporting) return;
    if (!state.pages.length) { showExportResult('ยังไม่มีหน้าเอกสาร', true); return; }
    if (!cvReady() && CvEngine.getState() === 'loading') {
      showExportResult('กรุณารอให้โหลดตัวประมวลผลภาพเสร็จก่อน (ดูสถานะที่มุมขวาบน)', true);
      return;
    }
    var filename = PdfExport.sanitizeFilename($('exFilename').value);
    $('exFilename').value = filename.replace(/\.pdf$/i, '');
    var pages = state.pages.slice();
    exportCancelled = false;
    setExportBusy(true);
    $('exResult').hidden = true;
    $('exShare').hidden = true;
    $('exProgressText').textContent = 'กำลังเตรียม…';
    $('exProgress').value = 0;
    try {
      var opts = exportOptions();
      var n = pages.length;
      opts.concurrency = cvReady() ? CvEngine.concurrency() : 1;
      opts.isCancelled = function () { return exportCancelled; };
      if (opts.ocr) {
        opts.textLayer = function (page, i) {
          return ocrResultFor(page, opts.ocrLang, function (status, p) {
            if (exportCancelled) return;
            var msg = OCR_STATUS[status] || 'กำลังทำงาน…';
            if (status === 'recognizing text') msg = 'กำลังอ่านข้อความหน้า ' + (i + 1) + ' / ' + n + ' — ' + Math.round(p * 100) + '%';
            $('exProgress').value = Math.round((i + (status === 'recognizing text' ? p : 0)) / n * 100);
            $('exProgressText').textContent = msg;
          }, opts.isCancelled).then(function (res) { return res.layout; });
        };
      }
      var out = await PdfExport.build(pages, opts, renderPageForPdf, function (done, total) {
        $('exProgress').value = Math.round(done / total * 100);
        $('exProgressText').textContent = 'กำลังสร้างหน้า ' + done + ' / ' + total;
      });
      var blob = out.blob;
      lastPdf = { blob: blob, name: filename };
      var saved = true;
      try {
        saved = await PdfExport.download(blob, filename);
      } catch (e) {
        console.error(e);
        saved = e;
      }
      var note = cvReady() ? '' : ' (ไม่ได้ครอป/ปรับภาพ เพราะโหลดตัวประมวลผลภาพไม่สำเร็จ)';
      var warn = false;
      if (saved !== true) {
        warn = true;
        note += saved === false
          ? ' · ยังไม่ได้บันทึกไฟล์ (กด "ดาวน์โหลด PDF" อีกครั้งเพื่อบันทึก)'
          : ' · บันทึกไฟล์ไม่สำเร็จ: ' + (saved && saved.message ? saved.message : saved);
      }
      if (opts.ocr) {
        if (out.textError) {
          console.warn(out.textError);
          warn = true;
          note += out.textPages
            ? ' · ค้นหาข้อความได้ ' + out.textPages + ' จาก ' + n + ' หน้า (อ่านข้อความบางหน้าไม่สำเร็จ)'
            : ' · อ่านข้อความไม่สำเร็จ ไฟล์นี้จึงค้นหาข้อความไม่ได้: ' + (out.textError.message || out.textError);
        } else {
          note += out.textPages ? ' · ค้นหาข้อความได้' : ' · ไม่พบข้อความในภาพ';
        }
      }
      showExportResult('สร้าง "' + filename + '" สำเร็จ — ' + n + ' หน้า, ' + formatBytes(blob.size) + note, warn);
      $('exShare').hidden = !PdfExport.canShareFiles();
    } catch (e) {
      if (e && e.cancelled) {
        showExportResult('หยุดการสร้าง PDF แล้ว', true);
      } else {
        console.error(e);
        showExportResult('สร้าง PDF ไม่สำเร็จ: ' + (e && e.message ? e.message : e), true);
      }
    } finally {
      setExportBusy(false);
      if (window.CvEngine) CvEngine.trim(); // คืนหน่วยความจำของ worker ที่เปิดเพิ่มระหว่างสร้าง PDF
    }
  }

  function syncExportOcr() {
    var supported = Ocr.isSupported();
    $('exOcr').disabled = exporting || !supported;
    if (!supported) {
      $('exOcr').checked = false;
      $('exOcrNote').textContent = 'ต้องเปิดผ่านเว็บไซต์ (https) — ไม่รองรับการเปิดไฟล์จากเครื่องโดยตรง';
    }
    $('exOcrLangField').hidden = !$('exOcr').checked;
  }

  function bindExport() {
    try {
      $('exOcr').checked = loadPref('pdfOcr', 'pdfOcr') === '1';
      var lang = loadPref('ocrLang', 'ocrLang');
      if (Ocr.LANGS.indexOf(lang) >= 0) $('exOcrLang').value = lang;
    } catch (_) { /* ignore */ }
    syncExportOcr();
    $('exOcr').addEventListener('change', function () {
      try { savePref('pdfOcr', $('exOcr').checked ? '1' : '0'); } catch (_) { /* ignore */ }
      syncExportOcr();
    });
    $('exOcrLang').addEventListener('change', function () {
      // ใช้ภาษาเดียวกับหน้าต่าง "แปลงภาพเป็นข้อความ"
      $('ocrLang').value = $('exOcrLang').value;
      try { savePref('ocrLang', $('exOcrLang').value); } catch (_) { /* ignore */ }
    });
    $('btnExport').addEventListener('click', openExportDialog);
    $('exportForm').addEventListener('submit', function (e) {
      e.preventDefault();
      doExport();
    });
    $('exCancel').addEventListener('click', closeExportDialog);
    $('exportDialog').addEventListener('cancel', function (e) {
      if (exporting) e.preventDefault();
    });
    ['exPageSize', 'exOrientation', 'exMargin', 'exQuality', 'exFilename', 'exOcr', 'exOcrLang'].forEach(function (id) {
      $(id).addEventListener('change', function () { lastPdf = null; $('exShare').hidden = true; });
    });
    $('exShare').addEventListener('click', function () {
      if (!lastPdf) return;
      PdfExport.share(lastPdf.blob, lastPdf.name).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        toast('แชร์ไม่สำเร็จ: ' + (e && e.message ? e.message : e), 'error');
      });
    });
  }

  // =====================================================================
  //  OCR — แปลงภาพเป็นข้อความ
  // =====================================================================

  var OCR_SIDE = 2400;            // ประมาณ 300 dpi สำหรับกระดาษ A4
  var ocrCache = new Map();       // ผลที่อ่านแล้ว: ไม่ต้องอ่านซ้ำถ้ากรอบ/การหมุน/ภาษาไม่เปลี่ยน
  var ocrRun = 0;                 // เพิ่มค่าเมื่อเริ่ม/ยกเลิก เพื่อทิ้งผลของรอบเก่า
  var ocrPages = [];
  var OCR_STATUS = {
    'loading tesseract core': 'กำลังโหลดตัวอ่านข้อความ…',
    'initializing tesseract': 'กำลังเตรียมตัวอ่านข้อความ…',
    'loading language traineddata': 'กำลังโหลดข้อมูลภาษา…',
    'initializing api': 'กำลังเตรียมตัวอ่านข้อความ…',
    'recognizing text': 'กำลังอ่านข้อความ'
  };

  function ocrKey(page, lang) {
    return page.id + '|' + quadKey(page) + '|' + (page.settings.rotation || 0) + '|' + lang;
  }

  /** เตรียมภาพสำหรับ OCR: ครอปตามกรอบ + โทนเทาลบเงา + ลบเส้นตาราง (ความละเอียดประมาณ 300 dpi) */
  function ocrImageFor(page) {
    return schedule(async function () {
      var src = await acquireSource(page);
      try {
        var canvas;
        if (cvReady()) {
          canvas = await CvEngine.warpProcess(src, page.quad, OCR_SIDE, { filter: 'ocr', rotation: page.settings.rotation }, 'high');
        } else {
          var sc = Scanner.scaledCanvas(src, OCR_SIDE).canvas;
          canvas = Scanner.rotateCanvas(sc, page.settings.rotation);
          if (canvas !== sc) releaseCanvas(sc);
        }
        var size = { width: canvas.width, height: canvas.height };
        var blob = await canvasToBlob(canvas, 'image/png');
        releaseCanvas(canvas);
        if (!blob) throw new Error('เตรียมภาพไม่สำเร็จ');
        return { blob: blob, size: size };
      } finally {
        releaseSource(page);
      }
    }, 'high');
  }

  /**
   * ผล OCR ของหน้า (ใช้ผลเดิมถ้ามี) — ใช้ร่วมกันระหว่างหน้าต่าง OCR และ PDF ที่ค้นหาข้อความได้
   * @param {Function} isCancelled  ตรวจก่อนเริ่มอ่าน (หลังเตรียมภาพเสร็จ) — ถ้ายกเลิกแล้วจะไม่เริ่มงาน OCR ใหม่
   * @returns {Promise<{text, confidence, layout}>}
   */
  async function ocrResultFor(page, lang, onProgress, isCancelled) {
    var key = ocrKey(page, lang);
    var res = ocrCache.get(key);
    if (res) return res;
    var img = await ocrImageFor(page);
    if (isCancelled && isCancelled()) {
      var err = new Error('ยกเลิกแล้ว');
      err.cancelled = true;
      throw err;
    }
    res = await Ocr.recognize(img.blob, lang, onProgress, img.size);
    // ถ้าระหว่างอ่านมีการแก้กรอบ/หมุนหน้า ผลนี้จะเก็บด้วย key เดิม ซึ่งจะไม่ถูกใช้อีก
    ocrCache.set(key, res);
    return res;
  }

  function setOcrNote(text, warn) {
    $('ocrNote').textContent = text;
    $('ocrNote').classList.toggle('warn', !!warn);
  }

  function setOcrBusy(busy) {
    $('ocrProgressWrap').hidden = !busy;
    ['ocrCopy', 'ocrSave', 'ocrShare'].forEach(function (id) { $(id).disabled = busy; });
    $('ocrText').readOnly = busy;
  }

  function openOcr(pages, scopeText) {
    if (!pages.length) { toast('ยังไม่มีหน้าเอกสาร', 'error'); return; }
    if (!Ocr.isSupported()) {
      toast('การแปลงเป็นข้อความต้องเปิดผ่านเว็บไซต์ (https) — ไม่รองรับการเปิดไฟล์จากเครื่องโดยตรง', 'error');
      return;
    }
    ocrPages = pages.slice();
    $('ocrScope').textContent = scopeText;
    $('ocrText').value = '';
    $('ocrShare').hidden = !PdfExport.canShareText();
    var dlg = $('ocrDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    runOcr();
  }

  function isOcrOpen() { return $('ocrDialog').hasAttribute('open'); }

  async function runOcr() {
    var run = ++ocrRun;
    Ocr.cancelAll();
    var lang = $('ocrLang').value;
    var pages = ocrPages.filter(isAlive);
    var n = pages.length;
    var parts = [];
    var confs = [];
    setOcrBusy(true);
    setOcrNote('ตรวจทานข้อความก่อนนำไปใช้ — แก้ไขในช่องนี้ได้โดยตรง', false);
    $('ocrText').value = '';
    $('ocrProgress').value = 0;
    $('ocrProgressText').textContent = 'กำลังเตรียม…';
    function progress(i, frac, text) {
      if (run !== ocrRun) return;
      $('ocrProgress').value = Math.round((i + frac) / n * 100);
      $('ocrProgressText').textContent = text;
    }
    try {
      for (var i = 0; i < n; i++) {
        var page = pages[i];
        if (!isAlive(page)) continue;
        var num = state.pages.indexOf(page) + 1;
        var label = n > 1 ? ' หน้า ' + num + ' (' + (i + 1) + '/' + n + ')' : '';
        if (!ocrCache.has(ocrKey(page, lang))) progress(i, 0, 'กำลังเตรียมภาพ' + label + '…');
        var res = await ocrResultFor(page, lang, (function (idx, lbl) {
          return function (status, p) {
            var msg = OCR_STATUS[status] || 'กำลังทำงาน…';
            if (status === 'recognizing text') msg += lbl + ' ' + Math.round(p * 100) + '%';
            progress(idx, status === 'recognizing text' ? p : 0, msg);
          };
        })(i, label), function () { return run !== ocrRun; });
        if (run !== ocrRun) return;
        confs.push(res.confidence);
        parts.push(n > 1 ? '— หน้า ' + num + ' —\n' + res.text : res.text);
        $('ocrText').value = parts.join('\n\n');
      }
      var avg = confs.length ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length) : 0;
      var empty = !$('ocrText').value.replace(/— หน้า \d+ —/g, '').trim();
      if (empty) setOcrNote('ไม่พบข้อความในภาพ — ลองครอปให้ชิดเอกสาร หรือถ่ายภาพให้ชัดขึ้น', true);
      else if (avg < 70) setOcrNote('ความมั่นใจเฉลี่ย ' + avg + '% (ต่ำ) — ภาพอาจไม่ชัด กรุณาตรวจทานข้อความให้ละเอียด', true);
      else setOcrNote('ความมั่นใจเฉลี่ย ' + avg + '% — ตรวจทานข้อความก่อนนำไปใช้ แก้ไขในช่องนี้ได้โดยตรง', false);
    } catch (e) {
      if (run !== ocrRun || (e && e.cancelled)) return;
      console.error(e);
      setOcrNote('แปลงเป็นข้อความไม่สำเร็จ: ' + (e && e.message ? e.message : e), true);
    } finally {
      if (run === ocrRun) setOcrBusy(false);
    }
  }

  function closeOcr() {
    ocrRun++;
    Ocr.cancelAll();
    setOcrBusy(false);
    var dlg = $('ocrDialog');
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  function ocrFilename() {
    return PdfExport.sanitizeFilename($('exFilename').value || PdfExport.defaultName()).replace(/\.pdf$/i, '.txt');
  }

  async function copyOcr() {
    var text = $('ocrText').value;
    if (!text) return;
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      var ta = $('ocrText');
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    }
    setOcrNote(ok ? 'คัดลอกข้อความแล้ว' : 'คัดลอกไม่สำเร็จ — กดค้างที่ข้อความเพื่อคัดลอกเอง', !ok);
  }

  function saveOcr() {
    var text = $('ocrText').value;
    if (!text) return;
    var name = ocrFilename();
    // ใส่ BOM เพื่อให้โปรแกรมอย่าง Notepad รุ่นเก่าแสดงภาษาไทยถูกต้อง
    PdfExport.download(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }), name).then(function (ok) {
      setOcrNote(ok ? 'บันทึก "' + name + '" แล้ว' : 'ยังไม่ได้บันทึกไฟล์', !ok);
    }, function (e) {
      setOcrNote('บันทึกไม่สำเร็จ: ' + (e && e.message ? e.message : e), true);
    });
  }

  function bindOcr() {
    try {
      var saved = loadPref('ocrLang', 'ocrLang');
      if (Ocr.LANGS.indexOf(saved) >= 0) $('ocrLang').value = saved;
    } catch (_) { /* ignore */ }

    $('edOcr').addEventListener('click', function () {
      var page = currentPage();
      if (page) openOcr([page], 'หน้า ' + (state.current + 1));
    });
    $('btnOcrAll').addEventListener('click', function () {
      openOcr(state.pages, 'ทุกหน้า (' + state.pages.length + ' หน้า)');
    });
    $('ocrLang').addEventListener('change', function () {
      $('exOcrLang').value = $('ocrLang').value;
      try { savePref('ocrLang', $('ocrLang').value); } catch (_) { /* ignore */ }
      if (isOcrOpen()) runOcr();
    });
    $('ocrClose').addEventListener('click', closeOcr);
    $('ocrDialog').addEventListener('cancel', function (e) { e.preventDefault(); closeOcr(); });
    $('ocrCopy').addEventListener('click', copyOcr);
    $('ocrSave').addEventListener('click', saveOcr);
    $('ocrShare').addEventListener('click', function () {
      var text = $('ocrText').value;
      if (!text) return;
      PdfExport.shareText(text, ocrFilename()).catch(function (e) {
        if (!e || e.name !== 'AbortError') setOcrNote('แชร์ไม่สำเร็จ', true);
      });
    });
  }

  // =====================================================================
  //  สถานะ OpenCV
  // =====================================================================

  function onCvState(s, detail) {
    var pill = $('cvStatus');
    pill.dataset.state = s === 'ready' ? 'ready' : s === 'error' ? 'error' : 'loading';
    $('cvRetry').hidden = s !== 'error';
    $('cvStatusText').textContent = s === 'ready'
      ? 'พร้อมใช้งาน'
      : s === 'error'
        ? (detail || 'โหลดตัวประมวลผลภาพไม่สำเร็จ')
        : 'กำลังโหลดตัวประมวลผลภาพ…';
    if (s === 'ready' && detail) {
      pill.title = 'OpenCV.js ' + (detail.build === 'simd' ? 'SIMD' : 'มาตรฐาน') +
        (detail.mode === 'worker' ? ' · Web Worker สูงสุด ' + detail.workers + ' ตัว' : ' · ประมวลผลในหน้าเว็บ') +
        ' · โหลด ' + (detail.ms / 1000).toFixed(1) + ' วินาที';
    }
    if (s === 'ready') {
      state.pages.forEach(function (p) { scheduleThumb(p, p.needsDetect); });
      if (state.view === 'editor') { clearEditorCache(); renderEditorPreview(); }
      if (state.view === 'crop') $('cropAuto').disabled = false;
    }
    state.pages.forEach(function (p) { renderGridItemState(p); });
  }

  // =====================================================================
  //  เริ่มต้น
  // =====================================================================

  function bindHome() {
    // Android: หน้าเลือกไฟล์ของระบบกรองได้เฉพาะ MIME type — นามสกุลใน accept (.heic, .webp) ทำให้หน้าเลือกไฟล์
    // ของ Firefox บน Android ค้างแล้วปิดตัว (image/* ครอบคลุม HEIC/WebP บน Android อยู่แล้ว)
    if (window.PdfConvert && PdfConvert.isAndroid) $('fileInput').setAttribute('accept', 'image/*');
    $('btnPick').addEventListener('click', function () { $('fileInput').value = ''; $('fileInput').click(); });
    $('btnAddMore').addEventListener('click', function () { $('fileInput').value = ''; $('fileInput').click(); });
    $('btnNativeCamera').addEventListener('click', openNativeCamera);
    refreshCameraButtons();
    watchCameraPermission();
    $('btnCamera').addEventListener('click', startCamera);
    $('fileInput').addEventListener('change', function (e) { addFiles(e.target.files); });
    $('captureInput').addEventListener('change', function (e) { addFiles(e.target.files); });
    $('cvRetry').addEventListener('click', function () { CvEngine.retry(); });

    $('btnClearAll').addEventListener('click', function () {
      if (!state.pages.length) return;
      if (window.confirm('ลบทุกหน้า (' + state.pages.length + ' หน้า) ใช่หรือไม่?')) clearAll();
    });

    $('pageGrid').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      var item = e.target.closest('.page-item');
      if (!btn || !item) return;
      var id = Number(item.dataset.id);
      var page = state.pages.find(function (p) { return p.id === id; });
      if (!page) return;
      var action = btn.dataset.action;
      if (action === 'open') openEditor(page);
      else if (action === 'left') movePage(page, -1);
      else if (action === 'right') movePage(page, 1);
      else if (action === 'delete') {
        if (window.confirm('ลบหน้า ' + (state.pages.indexOf(page) + 1) + ' ใช่หรือไม่?')) deletePage(page);
      }
    });
  }

  function bindDropAndPaste() {
    var depth = 0;
    function hasFiles(e) {
      return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e) || state.view !== 'home') return;
      e.preventDefault();
      depth++;
      $('dropZone').hidden = false;
    });
    window.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = state.view === 'home' ? 'copy' : 'none';
    });
    window.addEventListener('dragleave', function (e) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) $('dropZone').hidden = true;
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('dropZone').hidden = true;
      if (state.view === 'home') addFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', function (e) {
      if (state.view !== 'home' || !e.clipboardData) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      var files = Array.prototype.filter.call(e.clipboardData.files || [], isImageFile);
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    window.addEventListener('beforeunload', function (e) {
      if (state.pages.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /**
   * แสดงเวอร์ชันที่กำลังใช้งาน (เลข commit + เวลาที่เปิดหน้า จาก js/boot.js)
   * แพลตฟอร์มที่มีเลขรุ่นของตัวเอง (แอป Android: v1.0.N ของ Release) ส่งมาใน AppPlatform.versionLabel
   * — แสดงเลขรุ่นนั้นแทนเลข commit และไม่แสดงเวลาที่เปิด
   */
  function renderVersion() {
    var b = window.APP_BUILD;
    if (!b) return;
    var P = window.AppPlatform;
    var suffix = P && P.label ? ' (' + P.label + ')' : '';
    var label = P && typeof P.versionLabel === 'string' ? P.versionLabel.trim().slice(0, 40) : '';
    if (label) {
      $('appVersion').textContent = 'เวอร์ชัน ' + label + suffix;
    } else {
      var o = String(b.opened || '');
      var when = /^\d{8}-\d{6}$/.test(o)
        ? o.slice(6, 8) + '/' + o.slice(4, 6) + '/' + o.slice(0, 4) + ' ' + o.slice(9, 11) + ':' + o.slice(11, 13) + ':' + o.slice(13, 15)
        : '';
      $('appVersion').textContent = 'เวอร์ชัน ' + (b.commit === 'dev' ? 'พัฒนา (dev)' : b.commit.slice(0, 7)) +
        suffix + (when ? ' · เปิดเมื่อ ' + when : '');
    }
    $('appVersion').title = 'v=' + b.v;
  }

  function init() {
    renderVersion();
    bindHome();
    bindEditor();
    bindCrop();
    bindCamera();
    bindExport();
    bindOcr();
    bindDropAndPaste();
    renderGrid();
    try { history.replaceState({ v: 'home' }, ''); } catch (_) { /* ignore */ }
    CvEngine.onChange(onCvState);
    CvEngine.load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
