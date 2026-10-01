/*
 * CropEditor — กรอบครอป 4 มุมแบบลากได้อิสระ (รองรับเมาส์ ทัชสกรีน และคีย์บอร์ด)
 *   - ลากจุดมุม: ย้ายมุมนั้น
 *   - ลากจุดกลางขอบ: ย้ายทั้งขอบ (2 มุม)
 *   - ระหว่างลากมีแว่นขยายช่วยวางมุมให้แม่น
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var LOUPE_SIZE = 120;
  var LOUPE_ZOOM = 2.5;
  var HIT_RADIUS = 26;

  function svgEl(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function create(stage, options) {
    options = options || {};
    var onChange = options.onChange || function () {};

    var img = null;          // source canvas
    var imgW = 0, imgH = 0;
    var quad = null;         // [TL,TR,BR,BL] ในพิกัดภาพต้นฉบับ
    var view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
    var drag = null;
    var valid = true;

    var canvas = document.createElement('canvas');
    canvas.className = 'crop-img';
    var svg = svgEl('svg', { 'class': 'crop-svg', role: 'group', 'aria-label': 'กรอบครอป' });
    var root = svgEl('g');
    var shade = svgEl('path', { 'class': 'shade' });
    var poly = svgEl('polygon', { 'class': 'quad' });
    root.appendChild(shade);
    root.appendChild(poly);

    var cornerNames = ['มุมบนซ้าย', 'มุมบนขวา', 'มุมล่างขวา', 'มุมล่างซ้าย'];
    var edgeNames = ['ขอบบน', 'ขอบขวา', 'ขอบล่าง', 'ขอบซ้าย'];
    var handles = [];
    var hits = [];
    for (var i = 0; i < 8; i++) {
      var isEdge = i >= 4;
      var h = isEdge
        ? svgEl('rect', { 'class': 'handle edge', width: 22, height: 8, rx: 4 })
        : svgEl('circle', { 'class': 'handle', r: 11 });
      var hit = svgEl('circle', {
        'class': 'hit', r: isEdge ? HIT_RADIUS - 6 : HIT_RADIUS, tabindex: 0,
        'data-idx': i, role: 'button',
        'aria-label': (isEdge ? edgeNames[i - 4] : cornerNames[i]) + ' (ลากหรือใช้ปุ่มลูกศรเพื่อเลื่อน)'
      });
      handles.push(h);
      hits.push(hit);
    }
    // วาดจุดกลางขอบก่อน เพื่อให้จุดมุมอยู่ด้านบน (กดง่ายกว่าเมื่อทับกัน)
    [4, 5, 6, 7, 0, 1, 2, 3].forEach(function (idx) { root.appendChild(handles[idx]); });
    [4, 5, 6, 7, 0, 1, 2, 3].forEach(function (idx) { root.appendChild(hits[idx]); });
    svg.appendChild(root);

    var loupe = document.createElement('canvas');
    loupe.className = 'loupe';
    loupe.hidden = true;

    stage.appendChild(canvas);
    stage.appendChild(svg);
    stage.appendChild(loupe);

    function layout() {
      if (!img) return;
      var sw = stage.clientWidth, sh = stage.clientHeight;
      if (sw < 10 || sh < 10) return;
      var pad = 14;
      var scale = Math.min((sw - pad * 2) / imgW, (sh - pad * 2) / imgH);
      view.scale = scale;
      view.w = imgW * scale;
      view.h = imgH * scale;
      view.ox = (sw - view.w) / 2;
      view.oy = (sh - view.h) / 2;

      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(view.w * dpr));
      canvas.height = Math.max(1, Math.round(view.h * dpr));
      canvas.style.width = view.w + 'px';
      canvas.style.height = view.h + 'px';
      canvas.style.left = view.ox + 'px';
      canvas.style.top = view.oy + 'px';
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      svg.setAttribute('width', sw);
      svg.setAttribute('height', sh);
      svg.style.left = '0px';
      svg.style.top = '0px';
      root.setAttribute('transform', 'translate(' + view.ox + ' ' + view.oy + ')');

      loupe.width = Math.round(LOUPE_SIZE * dpr);
      loupe.height = Math.round(LOUPE_SIZE * dpr);
      loupe.style.width = LOUPE_SIZE + 'px';
      loupe.style.height = LOUPE_SIZE + 'px';
      render();
    }

    function toView(p) { return { x: p.x * view.scale, y: p.y * view.scale }; }

    function edgeMid(i) {
      var a = quad[i], b = quad[(i + 1) % 4];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function render() {
      if (!quad) return;
      var v = quad.map(toView);
      var pts = v.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
      poly.setAttribute('points', pts);
      shade.setAttribute('d',
        'M0,0H' + view.w.toFixed(1) + 'V' + view.h.toFixed(1) + 'H0Z M' +
        v.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' L') + 'Z');

      for (var i = 0; i < 8; i++) {
        var p = i < 4 ? v[i] : toView(edgeMid(i - 4));
        if (i < 4) {
          handles[i].setAttribute('cx', p.x);
          handles[i].setAttribute('cy', p.y);
        } else {
          var a = v[i - 4], b = v[(i - 3) % 4];
          var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
          handles[i].setAttribute('x', p.x - 11);
          handles[i].setAttribute('y', p.y - 4);
          handles[i].setAttribute('transform', 'rotate(' + ang.toFixed(1) + ' ' + p.x + ' ' + p.y + ')');
        }
        hits[i].setAttribute('cx', p.x);
        hits[i].setAttribute('cy', p.y);
      }

      var nowValid = computeValid();
      svg.classList.toggle('invalid', !nowValid);
      if (nowValid !== valid) {
        valid = nowValid;
        onChange(valid);
      }
    }

    function computeValid() {
      return Scanner.isValidQuad(quad, Math.max(8, Math.min(imgW, imgH) * 0.03));
    }

    function clampPt(p) {
      return { x: Math.min(imgW, Math.max(0, p.x)), y: Math.min(imgH, Math.max(0, p.y)) };
    }

    function pointerToImage(e) {
      var r = svg.getBoundingClientRect();
      return {
        x: (e.clientX - r.left - view.ox) / view.scale,
        y: (e.clientY - r.top - view.oy) / view.scale
      };
    }

    function onPointerDown(e) {
      var target = e.target;
      if (!target.classList || !target.classList.contains('hit') || !quad) return;
      e.preventDefault();
      var idx = Number(target.getAttribute('data-idx'));
      var p = pointerToImage(e);
      drag = {
        idx: idx,
        id: e.pointerId,
        start: p,
        orig: quad.map(function (q) { return { x: q.x, y: q.y }; })
      };
      try { svg.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      showLoupe(idx < 4 ? quad[idx] : edgeMid(idx - 4));
    }

    function applyDrag(idx, dx, dy, orig) {
      if (idx < 4) {
        quad[idx] = clampPt({ x: orig[idx].x + dx, y: orig[idx].y + dy });
      } else {
        var a = idx - 4, b = (idx - 3) % 4;
        // จำกัดระยะเลื่อนเพื่อไม่ให้มุมใดหลุดออกนอกภาพ
        var minDx = -Math.min(orig[a].x, orig[b].x), maxDx = imgW - Math.max(orig[a].x, orig[b].x);
        var minDy = -Math.min(orig[a].y, orig[b].y), maxDy = imgH - Math.max(orig[a].y, orig[b].y);
        dx = Math.min(maxDx, Math.max(minDx, dx));
        dy = Math.min(maxDy, Math.max(minDy, dy));
        quad[a] = { x: orig[a].x + dx, y: orig[a].y + dy };
        quad[b] = { x: orig[b].x + dx, y: orig[b].y + dy };
      }
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      var p = pointerToImage(e);
      applyDrag(drag.idx, p.x - drag.start.x, p.y - drag.start.y, drag.orig);
      render();
      showLoupe(drag.idx < 4 ? quad[drag.idx] : edgeMid(drag.idx - 4));
    }

    function onPointerUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      loupe.hidden = true;
      try { svg.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    function onKeyDown(e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('hit') || !quad) return;
      var step = (e.shiftKey ? 10 : 1) / view.scale;
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = -step;
      else if (e.key === 'ArrowRight') dx = step;
      else if (e.key === 'ArrowUp') dy = -step;
      else if (e.key === 'ArrowDown') dy = step;
      else return;
      e.preventDefault();
      var orig = quad.map(function (q) { return { x: q.x, y: q.y }; });
      applyDrag(Number(t.getAttribute('data-idx')), dx, dy, orig);
      render();
    }

    function showLoupe(pt) {
      var ctx = loupe.getContext('2d');
      var W = loupe.width, H = loupe.height;
      var dpr = W / LOUPE_SIZE;
      var z = view.scale * LOUPE_ZOOM * dpr; // พิกเซลของ loupe ต่อ 1 พิกเซลภาพต้นฉบับ
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = true;
      // วาดเฉพาะส่วนของภาพที่อยู่ในแว่นขยาย (เร็วกว่าวาดทั้งภาพทุกครั้งที่ลาก)
      var sw = W / z, sh = H / z, sx = pt.x - sw / 2, sy = pt.y - sh / 2;
      var x0 = Math.max(0, sx), y0 = Math.max(0, sy);
      var x1 = Math.min(imgW, sx + sw), y1 = Math.min(imgH, sy + sh);
      if (x1 > x0 && y1 > y0) {
        ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * z, (y0 - sy) * z, (x1 - x0) * z, (y1 - y0) * z);
      }
      // เส้นกรอบ
      ctx.strokeStyle = valid ? '#4d7dff' : '#ff5c6c';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      quad.forEach(function (q, i) {
        var x = W / 2 + (q.x - pt.x) * z, y = H / 2 + (q.y - pt.y) * z;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      // กากบาทกลาง
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 10 * dpr, H / 2); ctx.lineTo(W / 2 + 10 * dpr, H / 2);
      ctx.moveTo(W / 2, H / 2 - 10 * dpr); ctx.lineTo(W / 2, H / 2 + 10 * dpr);
      ctx.stroke();
      ctx.restore();

      // วางแว่นขยายไว้มุมบนด้านตรงข้ามกับนิ้ว
      var v = toView(pt);
      var leftSide = view.ox + v.x < stage.clientWidth / 2;
      loupe.style.top = '8px';
      loupe.style.left = leftSide ? (stage.clientWidth - LOUPE_SIZE - 8) + 'px' : '8px';
      loupe.hidden = false;
    }

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);
    svg.addEventListener('pointercancel', onPointerUp);
    svg.addEventListener('lostpointercapture', onPointerUp);
    svg.addEventListener('keydown', onKeyDown);

    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
    if (ro) ro.observe(stage);
    else window.addEventListener('resize', layout);

    return {
      open: function (source, q) {
        img = source;
        imgW = source.width;
        imgH = source.height;
        quad = (q || Scanner.fullQuad(imgW, imgH)).map(function (p) { return { x: p.x, y: p.y }; });
        valid = computeValid();
        drag = null;
        loupe.hidden = true;
        svg.classList.toggle('invalid', !valid);
        layout();
        onChange(valid);
      },
      setQuad: function (q) {
        quad = q.map(function (p) { return clampPt(p); });
        render();
      },
      getQuad: function () {
        return quad ? quad.map(function (p) { return { x: p.x, y: p.y }; }) : null;
      },
      isValid: function () { return valid; },
      layout: layout,
      release: function () {
        img = null;
        quad = null;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      },
      destroy: function () {
        if (ro) ro.disconnect(); else window.removeEventListener('resize', layout);
        stage.textContent = '';
      }
    };
  }

  window.CropEditor = { create: create };
})();
