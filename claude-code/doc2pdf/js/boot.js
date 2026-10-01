/*
 * boot.js — โหลด CSS/JS ของแอปพร้อม ?v=<เลข commit>-<วันเวลาที่เปิดหน้า>
 * เพื่อให้เบราว์เซอร์ดึงไฟล์ล่าสุดทุกครั้งที่เปิด ไม่ใช้ไฟล์เก่าที่ค้างในแคช
 *
 *   - เลข commit ถูกแทนที่ตอนเผยแพร่ (tools/stamp-build.sh ผ่าน tools/publish-site.sh) — เปิดในเครื่องจะเป็น "dev"
 *   - ไลบรารีขนาดใหญ่ใน vendor/ ใช้ ?v=<เลข commit> อย่างเดียว: ได้ไฟล์ใหม่ทุกครั้งที่ deploy
 *     แต่ไม่ต้องดาวน์โหลดซ้ำหลาย MB ทุกครั้งที่เปิดหน้า
 *   - ถ้าหน้า HTML เองค้างในแคช (commit ไม่ตรงกับ version.json) จะโหลดหน้าใหม่ 1 ครั้งด้วย URL ใหม่
 *
 * window.AppPlatform — จุดเดียวที่โค้ดของแอปใช้หาไฟล์ขณะทำงาน (worker, OpenCV, Tesseract, ฟอนต์, jsPDF, PDF.js)
 * เวอร์ชัน Google Apps Script (repo claude4gas) แทนที่ไฟล์นี้ด้วย AppPlatform ของตัวเอง
 * ที่ส่งไฟล์ผ่าน google.script.run — โค้ดส่วนอื่นของแอปจึงใช้ร่วมกันได้ทั้งสองแบบโดยไม่ต้องแก้
 * แพลตฟอร์มอื่นเพิ่ม hook ที่ไม่บังคับได้ เช่น versionLabel (เลขรุ่นที่แสดงแทนเลข commit — แอป Android: v1.0.N),
 * saveFile/shareFile/shareText/cameraHelp (แอป Android ที่บันทึก/แชร์ผ่านระบบ)
 */
(function () {
  'use strict';

  var HEX = /^[0-9a-f]{7,40}$/;
  var BUILD = '__APP_BUILD__';
  var commit = HEX.test(BUILD) ? BUILD : 'dev';
  // เวอร์ชันของหน้า HTML เอง (อาจค้างในแคชคนละรุ่นกับ boot.js)
  var meta = document.querySelector('meta[name="app-build"]');
  var pageCommit = meta && HEX.test(meta.content) ? meta.content : commit;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var d = new Date();
  var opened = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  var v = commit + '-' + opened;

  var STYLES = ['css/style.css'];
  // ไลบรารีใน vendor/ โหลดเมื่อต้องใช้ผ่าน AppPlatform (เช่น jsPDF ตอนเปิดหน้าต่างสร้าง PDF)
  var SCRIPTS = [
    ['js/cv-core.js'],
    ['js/scanner.js'],
    ['js/cv-engine.js'],
    ['js/crop-editor.js'],
    ['js/camera.js'],
    ['js/pdf-export.js'],
    ['js/ocr.js'],
    ['js/heic.js'],
    ['js/zip.js'],
    ['js/thai-text.js'],
    ['js/docx.js'],
    ['js/pdf-actualtext.js'],
    ['js/pdf-tools.js'],
    ['js/pdf-convert.js'],
    ['js/app.js']
  ];

  /** เติม ?v= ให้ไฟล์ของแอป (lib = true: ไลบรารีใน vendor/ ใช้เลข commit อย่างเดียว) */
  function asset(path, lib) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + encodeURIComponent(lib ? commit : v);
  }

  function abs(u) { return new URL(u, document.baseURI).href; }

  /** โหลด <script> คืน Promise<element> (ล้มเหลว → ลบ element ออกแล้ว reject) */
  function loadScriptTag(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(s); };
      s.onerror = function () { s.remove(); reject(new Error('โหลดไฟล์ ' + src + ' ไม่สำเร็จ')); };
      document.head.appendChild(s);
    });
  }

  window.APP_BUILD = { commit: commit, page: pageCommit, opened: opened, v: v };
  window.appAsset = asset;
  window.AppPlatform = {
    id: 'web',
    label: '',
    build: window.APP_BUILD,
    /** URL เต็มของไฟล์ในเว็บไซต์ (พร้อม ?v=) — lib = true สำหรับไลบรารีใน vendor/ */
    resolve: function (path, lib) { return Promise.resolve(abs(asset(path, lib))); },
    /** โหลดสคริปต์ในหน้าเว็บ */
    loadScript: function (path, lib) { return loadScriptTag(asset(path, lib)); }
  };

  // ลบ ?v= ที่ใช้บังคับโหลดหน้าใหม่ออกจากแถบที่อยู่ (ไม่ให้ติดไปตอนแชร์ลิงก์)
  try {
    var url = new URL(location.href);
    if (url.searchParams.has('v')) {
      url.searchParams.delete('v');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
  } catch (e) { /* ignore */ }

  // ซ่อนหน้าไว้จนกว่า CSS จะโหลดเสร็จ เพื่อไม่ให้เห็นหน้าที่ยังไม่มีสไตล์
  // (ซ่อนจากสคริปต์นี้เอง — ถ้า boot.js โหลดไม่ได้ หน้าจะไม่ว่างเปล่า)
  var root = document.documentElement;
  root.style.visibility = 'hidden';
  var cssDone = false, domDone = false, reloading = false;
  function reveal() { if (cssDone && domDone && !reloading) root.style.visibility = ''; }
  function cssReady() { cssDone = true; reveal(); }
  document.addEventListener('DOMContentLoaded', function () { domDone = true; reveal(); });
  setTimeout(function () { cssDone = true; domDone = true; reveal(); }, 5000);

  STYLES.forEach(function (href) {
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = asset(href);
    l.onload = cssReady;
    l.onerror = cssReady;
    document.head.appendChild(l);
  });

  function loadScripts() {
    SCRIPTS.forEach(function (s) {
      var el = document.createElement('script');
      el.src = asset(s[0], s[1]);
      el.async = false; // ทำงานตามลำดับ
      document.head.appendChild(el);
    });
  }

  /** ตรวจว่าหน้า HTML และ boot.js เป็นเวอร์ชันล่าสุด (ไม่ได้มาจากแคช) — ถ้าไม่ใช่ โหลดหน้าใหม่ 1 ครั้ง */
  function checkFresh() {
    if (commit === 'dev' || location.protocol === 'file:' || typeof fetch !== 'function') return Promise.resolve(true);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 3000);
    return fetch('version.json?t=' + Date.now(), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        clearTimeout(timer);
        var latest = info && typeof info.commit === 'string' && HEX.test(info.commit) ? info.commit : null;
        if (!latest || (latest === commit && latest === pageCommit)) return true;
        var key = 'doc2pdf:reloaded-for-' + latest; // sessionStorage ใช้ร่วมกับแอปอื่นในแท็บเดียวกัน — ขึ้นต้นด้วยชื่อโฟลเดอร์
        try {
          if (sessionStorage.getItem(key)) return true; // โหลดใหม่ไปแล้ว ไม่วนซ้ำ
          sessionStorage.setItem(key, '1');
        } catch (e) { return true; }
        var u = new URL(location.href);
        u.searchParams.set('v', latest + '-' + opened);
        reloading = true;
        location.replace(u.toString());
        return false;
      }, function () { clearTimeout(timer); return true; });
  }

  checkFresh()
    .then(null, function () { reloading = false; reveal(); return true; }) // ผิดพลาดใด ๆ → ใช้งานต่อได้ตามปกติ
    .then(function (ok) { if (ok) loadScripts(); });
})();
