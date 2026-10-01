/*
 * หน้าสร้าง QR Code — ข้อความของ QR สร้างใน js/payload.js ส่วนไฟล์นี้ดูแลหน้าเว็บ
 * ข้อความจากผู้ใช้ใส่ลงหน้าเว็บด้วย textContent เท่านั้น ไม่มีการแปลงเป็น HTML
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SETTINGS_KEY = 'qrcode-generator:settings'; // localStorage ใช้ร่วมกับทุกแอปใต้ envburiramclub.github.io
  var DEFAULT_THEME = ['#8b5cf6', '#d946ef'];
  var MAX_LOGO_BYTES = 5 * 1024 * 1024;
  var PREVIEW_SIZE = 260;
  var PNG_SIZE = 1024;           // ไฟล์ PNG ที่ดาวน์โหลดคมพอสำหรับพิมพ์ (ตัวอย่างบนหน้าจอ 260 พิกเซล)
  var TYPE_OFF = ['border-transparent', 'bg-white/60', 'text-gray-500'];
  var TYPE_ON = ['active', 'theme-border', 'theme-bg-soft', 'theme-text-solid'];
  var NAV_OFF = 'nav-btn px-3 sm:px-5 py-1.5 sm:py-2 font-medium text-gray-600 hover:text-gray-900 rounded-lg sm:rounded-xl transition-all whitespace-nowrap';
  var NAV_ON = 'nav-btn px-3 sm:px-5 py-1.5 sm:py-2 font-semibold text-white theme-gradient rounded-lg sm:rounded-xl shadow-md transition-all flex items-center gap-1 whitespace-nowrap';

  var currentType = 'url';
  var logo = null;               // data: URL ของโลโก้ที่ผู้ใช้เลือก
  var currentData = '';
  var qrCode = null;

  // ---------------------------------------------------------------- แจ้งเตือน

  function toast(message, kind) {
    var box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    t.textContent = message;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 5000 : 3000);
  }

  // ---------------------------------------------------------------- แท็บและประเภทข้อมูล

  function switchTab(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab-content'), function (el) { el.classList.remove('active'); });
    $('section-' + tab).classList.add('active');
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (btn) {
      btn.className = btn.getAttribute('data-tab') === tab ? NAV_ON : NAV_OFF;
    });
  }

  function setDataType(type) {
    if (!$('input-' + type)) return;
    currentType = type;
    Array.prototype.forEach.call(document.querySelectorAll('.type-btn'), function (btn) {
      var on = btn.getAttribute('data-type') === type;
      TYPE_ON.forEach(function (c) { btn.classList.toggle(c, on); });
      TYPE_OFF.forEach(function (c) { btn.classList.toggle(c, !on); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.input-group'), function (g) {
      g.classList.toggle('hidden', g.id !== 'input-' + type);
    });
    updateQR();
  }

  function fields() {
    var v = function (id) { return $(id).value; };
    return {
      url: v('data-url'), text: v('data-text'), ssid: v('wifi-ssid'), password: v('wifi-pass'), security: v('wifi-type'),
      phone: v('data-phone'), to: v('email-to'), subject: v('email-sub'), id: v('promptpay-id'), amount: v('promptpay-amount')
    };
  }

  // ---------------------------------------------------------------- QR Code

  // มีโลโก้บังกลางภาพ: ใช้ระดับแก้ข้อผิดพลาดสูงสุด (H) ให้ยังสแกนได้ แต่เก็บข้อมูลได้น้อยลง
  function ecLevel() { return logo ? 'H' : 'Q'; }

  function qrOptions(size) {
    var corners = $('cornersType').value;
    var dark = $('qrColorDark').value;
    return {
      width: size,
      height: size,
      type: 'svg',
      data: window.QrPayload.utf8Binary(currentData),
      image: logo || '',
      qrOptions: { errorCorrectionLevel: ecLevel() },
      dotsOptions: { color: dark, type: $('dotsType').value },
      backgroundOptions: { color: $('qrColorLight').value },
      cornersSquareOptions: { type: corners, color: dark },
      cornersDotOptions: { type: corners === 'square' ? 'square' : 'dot', color: dark },
      imageOptions: { crossOrigin: 'anonymous', margin: Math.round(10 * size / PREVIEW_SIZE), imageSize: Number($('logoSize').value) || 0.4 }
    };
  }

  function showQR(data, message) {
    var error = $('input-error');
    error.textContent = message || '';
    error.classList.toggle('hidden', !message);
    currentData = data;
    $('btn-png').disabled = $('btn-svg').disabled = !data;
    // ไม่มีข้อมูล: แสดงช่องว่าง (เดิมแสดง QR ของเว็บตัวอย่างที่พิมพ์ผิด https://wwww... และดาวน์โหลดไปใช้ได้)
    $('qr-empty-state').classList.toggle('hidden', !!data);
    $('qr-code-wrapper').textContent = '';
  }

  function updateQR() {
    var r = window.QrPayload.build(currentType, fields());
    // ข้อความยาวเกินความจุของ QR: เดิมไลบรารี throw จน QR หายเฉย ๆ และปุ่มดาวน์โหลดค้างที่ "กำลังสร้างไฟล์"
    var tooLong = logo
      ? 'ข้อมูลยาวเกินกว่าที่ QR Code จะเก็บได้ ลองลบโลโก้ (มีโลโก้จะเก็บข้อมูลได้น้อยลง) หรือลดข้อความ'
      : 'ข้อมูลยาวเกินกว่าที่ QR Code จะเก็บได้ ลองลดข้อความ';
    if (r.data && !window.QrPayload.fitsQr(window.QrPayload.utf8Binary(r.data), ecLevel())) {
      showQR('', tooLong);
      return;
    }
    showQR(r.data, r.error);
    if (!currentData) return;
    try {
      if (!qrCode) qrCode = new window.QRCodeStyling(qrOptions(PREVIEW_SIZE));
      else qrCode.update(qrOptions(PREVIEW_SIZE));
      qrCode.append($('qr-code-wrapper'));
    } catch (_) {
      qrCode = null;
      showQR('', tooLong);
    }
  }

  function saveBlob(blob, name) {
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

  function download(ext) {
    if (!currentData) { toast('กรอกข้อมูลก่อนดาวน์โหลด', 'error'); return; }
    var btn = $(ext === 'png' ? 'btn-png' : 'btn-svg');
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    var saved = Array.prototype.slice.call(btn.childNodes);
    var spinner = document.createElement('span');
    spinner.className = 'spinner';
    btn.replaceChildren(spinner, document.createTextNode(' กำลังสร้างไฟล์…'));
    var options = qrOptions(ext === 'png' ? PNG_SIZE : PREVIEW_SIZE);
    // สร้างใน then: ถ้าไลบรารี throw ปุ่มจะกลับมาใช้ได้ ไม่ค้างที่ "กำลังสร้างไฟล์"
    Promise.resolve().then(function () {
      return new window.QRCodeStyling(options).getRawData(ext);
    }).then(function (blob) {
      if (!blob) throw new Error('empty');
      saveBlob(blob, 'QR_' + Date.now() + '.' + ext);
      toast('ดาวน์โหลดไฟล์เรียบร้อย', 'ok');
    }).catch(function () {
      toast('สร้างไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง', 'error');
    }).then(function () {
      btn.replaceChildren.apply(btn, saved);
      btn.removeAttribute('aria-busy');
      btn.disabled = !currentData;
    });
  }

  // ---------------------------------------------------------------- โลโก้

  function isImage(file) {
    if (/^image\//i.test(file.type || '')) return true;
    var generic = !file.type || /^(application|binary)\/octet-stream$/i.test(file.type);
    return generic && /\.(png|jpe?g|jfif?|jpe|pjpeg|pjp|gif|webp|bmp|svg|avif)$/i.test(file.name || '');
  }

  function setLogo(dataUrl) {
    logo = dataUrl;
    $('removeLogoBtn').classList.toggle('hidden', !logo);
    $('logo-size-container').classList.toggle('hidden', !logo);
    updateQR();
  }

  function onLogoChosen(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // เลือกไฟล์เดิมซ้ำได้
    if (!file) return;
    if (!isImage(file)) { toast('ไฟล์นี้ไม่ใช่รูปภาพ', 'error'); return; }
    if (file.size > MAX_LOGO_BYTES) { toast('รูปโลโก้ใหญ่เกิน 5 MB', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      // ตรวจว่าเบราว์เซอร์เปิดรูปได้จริงก่อนใส่ใน QR (ไฟล์เสีย/ไม่ใช่รูป → แจ้งผู้ใช้แทนการสร้าง QR พัง)
      var img = new Image();
      img.onload = function () { setLogo(reader.result); };
      img.onerror = function () { toast('เปิดรูปโลโก้ไม่ได้ ไฟล์อาจเสียหาย', 'error'); };
      img.src = reader.result;
    };
    reader.onerror = function () { toast('อ่านไฟล์โลโก้ไม่ได้', 'error'); };
    reader.readAsDataURL(file);
  }

  function updateLogoSizeLabel() {
    $('logo-size-label').textContent = Math.round(Number($('logoSize').value) * 100) + '%';
  }

  // ---------------------------------------------------------------- ธีม (ตั้งค่า)

  function isHexColor(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

  function applyTheme(c1, c2) {
    var s = document.documentElement.style;
    s.setProperty('--theme-color-1', c1);
    s.setProperty('--theme-color-2', c2);
    s.setProperty('--theme-color-1-rgb', hexToRgb(c1));
    s.setProperty('--theme-color-2-rgb', hexToRgb(c2));
  }

  function loadSettings() {
    var saved = {};
    try {
      var parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (parsed && typeof parsed === 'object') saved = parsed;
    } catch (_) { /* ค่าที่เก็บไว้เสีย ใช้ค่าเริ่มต้น */ }
    var own = function (k) { return Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : null; };
    var c1 = isHexColor(own('themeColor1')) ? own('themeColor1') : DEFAULT_THEME[0];
    var c2 = isHexColor(own('themeColor2')) ? own('themeColor2') : DEFAULT_THEME[1];
    $('setting-color1').value = c1;
    $('setting-color2').value = c2;
    applyTheme(c1, c2);
  }

  function saveSettings() {
    var c1 = $('setting-color1').value, c2 = $('setting-color2').value;
    if (!isHexColor(c1) || !isHexColor(c2)) { toast('สีไม่ถูกต้อง', 'error'); return; }
    applyTheme(c1, c2);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ themeColor1: c1, themeColor2: c2 }));
      toast('บันทึกการตั้งค่าเรียบร้อย', 'ok');
    } catch (_) {
      toast('บันทึกไม่สำเร็จ (เบราว์เซอร์ไม่อนุญาตให้เก็บข้อมูล)', 'error');
    }
  }

  // ---------------------------------------------------------------- เริ่มต้น

  function init() {
    if (typeof window.QRCodeStyling !== 'function' || !window.QrPayload) {
      toast('โหลดตัวสร้าง QR Code ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ', 'error');
      return;
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-type]'), function (btn) {
      btn.addEventListener('click', function () { setDataType(btn.getAttribute('data-type')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-download]'), function (btn) {
      btn.addEventListener('click', function () { download(btn.getAttribute('data-download')); });
    });
    ['data-url', 'data-text', 'wifi-ssid', 'wifi-pass', 'data-phone', 'email-to', 'email-sub', 'promptpay-id', 'promptpay-amount']
      .forEach(function (id) { $(id).addEventListener('input', updateQR); });
    ['wifi-type', 'qrColorDark', 'qrColorLight', 'dotsType', 'cornersType']
      .forEach(function (id) { $(id).addEventListener('change', updateQR); });
    $('logoSize').addEventListener('input', function () { updateLogoSizeLabel(); updateQR(); });
    $('logoInput').addEventListener('change', onLogoChosen);
    $('removeLogoBtn').addEventListener('click', function () { setLogo(null); });
    $('btn-save-settings').addEventListener('click', saveSettings);
    loadSettings();
    updateLogoSizeLabel();
    updateQR();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
