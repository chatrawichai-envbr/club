/*
 * Camera — กล้องในแอป (getUserMedia) ถ่ายเอกสารต่อเนื่องได้หลายหน้า
 * แสดงกรอบตรวจจับเอกสารแบบสด เมื่อ OpenCV พร้อมใช้งาน
 * ถ้าใช้กล้องไม่ได้ (ไม่อนุญาต/ไม่พบกล้อง/ไม่รองรับ/ไม่ใช่ HTTPS) จะแสดงเหตุผลในหน้ากล้อง พร้อมปุ่ม
 * "ใช้กล้องของเครื่อง" (onUseNative — ต้องเปิดจากการแตะใหม่ มือถือจึงยอมเปิดให้) และ "ลองอีกครั้ง"
 * แล้วเรียก onUnavailable ให้แอปจำไว้
 */
(function () {
  'use strict';

  var DETECT_INTERVAL = 400;
  var DETECT_SIDE = 480;
  var PHOTO_TIMEOUT = 4000;   // takePhoto ช้ากว่านี้ → ใช้ภาพจากวิดีโอแทน
  var PHOTO_SETTLE = 10000;   // รอ takePhoto ที่ค้างอยู่เสร็จก่อนหยุดกล้องได้นานสุดเท่านี้

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /** ชื่อแอปที่เปิดหน้าเว็บในเบราว์เซอร์ของตัวเอง (มักไม่อนุญาตให้เว็บใช้กล้อง) */
  function inAppBrowserName() {
    var ua = navigator.userAgent || '';
    if (/\bLine\/\d/.test(ua)) return 'LINE';
    if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger/.test(ua)) return 'Facebook';
    if (/Instagram/.test(ua)) return 'Instagram';
    if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'TikTok';
    if (/MicroMessenger/i.test(ua)) return 'WeChat';
    return '';
  }

  function isAppleMobile() {
    var ua = navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  /** แปลงข้อผิดพลาดของ getUserMedia เป็นเหตุผลที่แสดงให้ผู้ใช้ */
  function reasonOf(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'notfound';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
    return 'error';
  }

  var TEXTS = {
    denied: ['ไม่ได้รับอนุญาตให้ใช้กล้องในแอป', 'ถ่ายด้วยกล้องของเครื่องแทนได้เลย'],
    notfound: ['ไม่พบกล้อง', 'ใช้กล้องของเครื่อง หรือเลือกรูปภาพแทน'],
    busy: ['กล้องกำลังถูกใช้งานโดยแอปอื่น', 'ปิดแอปที่ใช้กล้องอยู่แล้วกด "ลองอีกครั้ง" หรือใช้กล้องของเครื่องแทน'],
    insecure: ['กล้องในแอปต้องเปิดผ่าน HTTPS', 'ถ่ายด้วยกล้องของเครื่องแทนได้เลย'],
    unsupported: ['เบราว์เซอร์นี้เปิดกล้องในแอปไม่ได้', 'ถ่ายด้วยกล้องของเครื่องแทนได้เลย'],
    error: ['เปิดกล้องในแอปไม่ได้', 'ถ่ายด้วยกล้องของเครื่องแทนได้เลย']
  };

  function helpText(reason) {
    // แพลตฟอร์มอธิบายวิธีอนุญาตเองได้ (เช่น แอป Android: สิทธิ์กล้องอยู่ในการตั้งค่าของแอป ไม่ใช่ของเว็บไซต์)
    var P = window.AppPlatform;
    if (P && typeof P.cameraHelp === 'function') {
      try {
        var own = P.cameraHelp(reason);
        if (typeof own === 'string') return own;
      } catch (_) { /* ใช้ข้อความปกติ */ }
    }
    if (reason !== 'denied' && reason !== 'error') return '';
    var app = inAppBrowserName();
    if (app) {
      return 'คุณเปิดหน้านี้ในแอป ' + app + ' ซึ่งมักไม่อนุญาตให้เว็บใช้กล้อง — ถ้าต้องการกล้องในแอป (ถ่ายหลายหน้าต่อเนื่อง) ' +
        'ให้เปิดลิงก์นี้ใน Chrome หรือ Safari (เมนู ⋮ หรือ ⋯ → เปิดในเบราว์เซอร์)';
    }
    if (reason === 'error') return '';
    return isAppleMobile()
      ? 'วิธีอนุญาตกล้องในแอป: แตะ "aA" ที่ช่องที่อยู่เว็บ → การตั้งค่าเว็บไซต์ → กล้อง → อนุญาต แล้วกด "ลองอีกครั้ง"'
      : 'วิธีอนุญาตกล้องในแอป: แตะไอคอนหน้าช่องที่อยู่เว็บ → สิทธิ์ (การตั้งค่าเว็บไซต์) → กล้อง → อนุญาต แล้วกด "ลองอีกครั้ง" ' +
        '(ถ้ายังไม่ได้ ให้อนุญาตกล้องให้แอปเบราว์เซอร์ในการตั้งค่าของเครื่องด้วย)';
  }

  function create(opts) {
    var el = opts.elements;
    var stream = null;
    var track = null;
    var imageCapture = null;
    var detectTimer = null;
    var session = 0;        // ป้องกัน race เมื่อปิดกล้องระหว่างรอสิทธิ์
    var busy = false;
    var count = 0;
    var torchOn = false;
    var lastQuad = null;
    var frameCanvas = document.createElement('canvas');
    // takePhoto ที่ยังไม่เสร็จ (อาจค้างต่อหลังหมดเวลา PHOTO_TIMEOUT) — หยุดกล้องระหว่างนี้ไม่ได้:
    // WebView ของ Android ส่งภาพเข้ากล้องที่ปิดแล้วจนแอปแครช (IllegalStateException: CameraDevice was already closed)
    var photoPending = null;

    function isOpen() { return !el.view.hidden; }

    function setMsg(text) { el.msg.textContent = text; }

    function updateCount() { el.count.textContent = String(count); }

    function stopTracks(s) {
      s.getTracks().forEach(function (t) { try { t.stop(); } catch (_) { /* ignore */ } });
    }

    function stopStream() {
      clearInterval(detectTimer);
      detectTimer = null;
      if (stream) {
        var s = stream;
        // หน้ากล้องปิดทันที แต่กล้องจริงหยุดหลัง takePhoto ที่ค้างอยู่เสร็จ (ไม่เกิน PHOTO_SETTLE)
        if (photoPending) {
          var stop = function () { stopTracks(s); };
          withTimeout(photoPending, PHOTO_SETTLE).then(stop, stop);
        } else {
          stopTracks(s);
        }
      }
      stream = null;
      track = null;
      imageCapture = null;
      torchOn = false;
      el.torch.setAttribute('aria-pressed', 'false');
      el.video.srcObject = null;
      clearOverlay();
    }

    function showBlocked(reason) {
      var t = TEXTS[reason] || TEXTS.error;
      el.blockedTitle.textContent = t[0];
      el.blockedText.textContent = t[1];
      var help = helpText(reason);
      el.blockedHelp.textContent = help;
      el.blockedHelp.hidden = !help;
      el.retry.hidden = reason === 'insecure' || reason === 'unsupported' || reason === 'notfound';
      setMsg('');
      el.shutter.disabled = true;
      el.torch.hidden = true;
      el.view.classList.add('blocked');
      el.blocked.hidden = false;
      el.view.hidden = false;
      el.useNative.focus();
    }

    function hideBlocked() {
      el.blocked.hidden = true;
      el.view.classList.remove('blocked');
    }

    function unavailable(reason, e) {
      showBlocked(reason);
      opts.onUnavailable(reason, e);
      return false;
    }

    function clearOverlay() {
      var ctx = el.overlay.getContext('2d');
      ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    }

    async function open() {
      var my = ++session;
      hideBlocked();
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return unavailable(window.isSecureContext === false ? 'insecure' : 'unsupported');
      }
      count = 0;
      busy = false;
      lastQuad = null;
      updateCount();
      setMsg('กำลังเปิดกล้อง…');
      el.shutter.disabled = true;
      el.torch.hidden = true;
      el.view.hidden = false;
      // เปิดกล้องใหม่เร็วหลังปิด: รอกล้องเดิมหยุดก่อน (takePhoto ที่ค้างอยู่) ไม่งั้นกล้องจะไม่ว่าง
      if (photoPending) {
        await withTimeout(photoPending, PHOTO_SETTLE).catch(function () {});
        if (my !== session || !isOpen()) return false;
      }

      var s;
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 }
          }
        });
      } catch (e) {
        if (my !== session || !isOpen()) return false;
        return unavailable(reasonOf(e), e);
      }
      if (my !== session || !isOpen()) {
        s.getTracks().forEach(function (t) { t.stop(); });
        return false;
      }
      stream = s;
      track = stream.getVideoTracks()[0] || null;
      el.video.srcObject = stream;
      try { await el.video.play(); } catch (_) { /* autoplay อาจถูกบล็อก แต่ muted+playsinline มักเล่นได้ */ }

      if (track && typeof window.ImageCapture === 'function') {
        try { imageCapture = new window.ImageCapture(track); } catch (_) { imageCapture = null; }
      }
      var caps = {};
      try { caps = (track && track.getCapabilities) ? track.getCapabilities() : {}; } catch (_) { caps = {}; }
      el.torch.hidden = !caps.torch;

      el.shutter.disabled = false;
      setMsg('วางเอกสารให้อยู่ในกรอบ แล้วกดถ่าย');
      detectTimer = setInterval(detectLoop, DETECT_INTERVAL);
      if (typeof opts.onOpen === 'function') opts.onOpen();
      return true;
    }

    function close() {
      session++;
      stopStream();
      hideBlocked();
      el.view.hidden = true;
      if (typeof opts.onClose === 'function') opts.onClose(count);
    }

    function videoRect() {
      var vw = el.video.videoWidth, vh = el.video.videoHeight;
      var cw = el.overlay.clientWidth, ch = el.overlay.clientHeight;
      if (!vw || !vh || !cw || !ch) return null;
      var s = Math.min(cw / vw, ch / vh);
      return { s: s, ox: (cw - vw * s) / 2, oy: (ch - vh * s) / 2, cw: cw, ch: ch };
    }

    function drawQuad(quad) {
      var r = videoRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (!r) return;
      var W = Math.round(r.cw * dpr), H = Math.round(r.ch * dpr);
      if (el.overlay.width !== W || el.overlay.height !== H) {
        el.overlay.width = W;
        el.overlay.height = H;
      }
      var ctx = el.overlay.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      if (!quad) return;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.beginPath();
      quad.forEach(function (p, i) {
        var x = r.ox + p.x * r.s, y = r.oy + p.y * r.s;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(40, 200, 120, 0.18)';
      ctx.strokeStyle = '#2bd67b';
      ctx.lineWidth = 3;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    var detecting = false;

    function detectLoop() {
      if (!stream || busy || detecting || document.hidden || !opts.canDetect()) return;
      var vw = el.video.videoWidth, vh = el.video.videoHeight;
      if (!vw || !vh) return;
      var my = session;
      try {
        var s = Math.min(1, DETECT_SIDE / Math.max(vw, vh));
        frameCanvas.width = Math.round(vw * s);
        frameCanvas.height = Math.round(vh * s);
        frameCanvas.getContext('2d', { willReadFrequently: true })
          .drawImage(el.video, 0, 0, frameCanvas.width, frameCanvas.height);
        detecting = true;
        // ตรวจจับใน Web Worker: ภาพกล้องไม่กระตุก
        Promise.resolve(opts.detect(frameCanvas)).then(function (q) {
          if (!stream || my !== session) return;
          lastQuad = q ? q.map(function (p) { return { x: p.x / s, y: p.y / s }; }) : null;
          drawQuad(lastQuad);
          if (!busy) setMsg(lastQuad ? 'พบเอกสารแล้ว กดถ่ายได้เลย' : 'วางเอกสารให้อยู่ในกรอบ แล้วกดถ่าย');
        }).catch(function (e) {
          console.warn('live detect', e);
        }).then(function () { detecting = false; });
      } catch (e) {
        detecting = false;
        console.warn('live detect', e);
      }
    }

    function grabFrame() {
      return new Promise(function (resolve, reject) {
        var vw = el.video.videoWidth, vh = el.video.videoHeight;
        if (!vw || !vh) { reject(new Error('no-frame')); return; }
        var c = document.createElement('canvas');
        c.width = vw;
        c.height = vh;
        c.getContext('2d').drawImage(el.video, 0, 0, vw, vh);
        c.toBlob(function (b) {
          c.width = c.height = 0;
          if (b) resolve(b); else reject(new Error('encode'));
        }, 'image/jpeg', 0.95);
      });
    }

    /** takePhoto ที่จำไว้ใน photoPending จนกว่าจะเสร็จจริง (สำเร็จหรือผิดพลาด) */
    function takePhoto() {
      var p = imageCapture.takePhoto();
      var settled = p.then(function () {}, function () {});
      photoPending = settled;
      settled.then(function () { if (photoPending === settled) photoPending = null; });
      return p;
    }

    async function capture() {
      if (busy || !stream) return;
      busy = true;
      el.shutter.disabled = true;
      el.flash.classList.remove('on');
      void el.flash.offsetWidth; // เริ่มแอนิเมชันใหม่
      el.flash.classList.add('on');
      var my = session;
      try {
        var blob = null;
        // takePhoto ครั้งก่อนยังไม่เสร็จ → ไม่ถ่ายซ้อน ใช้ภาพจากวิดีโอแทน
        if (imageCapture && typeof imageCapture.takePhoto === 'function' && !photoPending) {
          try { blob = await withTimeout(takePhoto(), PHOTO_TIMEOUT); } catch (_) { blob = null; }
        }
        if (!blob || !blob.size) blob = await grabFrame();
        if (my !== session) return;
        await opts.onCapture(blob);
        count++;
        updateCount();
        setMsg('ถ่ายแล้ว ' + count + ' หน้า — ถ่ายต่อ หรือกด "เสร็จ"');
      } catch (e) {
        console.error(e);
        setMsg('ถ่ายภาพไม่สำเร็จ ลองอีกครั้ง');
      } finally {
        busy = false;
        el.shutter.disabled = !stream;
      }
    }

    async function toggleTorch() {
      if (!track) return;
      try {
        await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
        torchOn = !torchOn;
        el.torch.setAttribute('aria-pressed', String(torchOn));
      } catch (_) {
        el.torch.hidden = true;
      }
    }

    el.shutter.addEventListener('click', capture);
    el.close.addEventListener('click', function () { opts.requestClose(); });
    el.done.addEventListener('click', function () { opts.requestClose(); });
    el.torch.addEventListener('click', toggleTorch);
    el.useNative.addEventListener('click', function () { opts.onUseNative(); });
    el.retry.addEventListener('click', function () {
      open().then(function (ok) { if (ok) el.shutter.focus(); });
    });
    el.view.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); opts.requestClose(); }
    });
    // ปิดกล้องเมื่อสลับแท็บ/ออกจากหน้า เพื่อไม่ให้กล้องค้างทำงาน
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && isOpen()) opts.requestClose();
    });
    window.addEventListener('pagehide', function () { if (stream) stopStream(); });

    return { open: open, close: close, isOpen: isOpen };
  }

  window.Camera = { create: create };
})();
