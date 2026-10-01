/*
 * ScanCore — อัลกอริทึมประมวลผลภาพเอกสารด้วย OpenCV.js (ไม่ใช้ DOM จึงทำงานได้ทั้งใน Web Worker และในหน้าเว็บ)
 *   detect(img)                    ตรวจจับขอบกระดาษ คืนมุม 4 จุด [TL, TR, BR, BL] ในพิกัดของ img หรือ null
 *   warp(img, quad, outW, outH)    ตัดภาพตามกรอบ 4 มุมและดัดให้ตรง (perspective transform)
 *   process(img, settings)         ลบเงา / สีสดคมชัด / ขาวดำ / โทนเทา / ปรับแสง
 *   warpProcess(...)               warp + process ในครั้งเดียว (ลดการส่งข้อมูลไปมา)
 * img คือ { data: Uint8ClampedArray (RGBA), width, height } เช่น ImageData — ผลลัพธ์เป็นรูปแบบเดียวกัน
 * ทุกฟังก์ชันคืน Mat ทั้งหมดใน finally เพื่อไม่ให้หน่วยความจำ WebAssembly รั่ว
 */
(function (root) {
  'use strict';

  var MAX_SIDE = 12000;    // ขนาดภาพสูงสุดที่ยอมรับ (ป้องกันการจองหน่วยความจำผิดพลาด)

  var DETECT_SIDE = 900;   // ความยาวด้านยาวของภาพที่ใช้ตรวจจับขอบ
  var BG_SIDE = 512;       // ความละเอียดที่ใช้ประมาณพื้นหลัง/เงา

  var FILTERS = ['original', 'enhance', 'bw', 'gray'];

  function defaultSettings() {
    return { filter: 'enhance', removeShadow: true, brightness: 0, contrast: 0, bwStrength: 0, rotation: 0 };
  }

  // ---------- เครื่องมือช่วย ----------

  /** เก็บ Mat/MatVector ที่สร้างไว้ แล้วคืนหน่วยความจำทั้งหมดในครั้งเดียว */
  function tracker() {
    var list = [];
    return {
      add: function (m) { list.push(m); return m; },
      free: function () {
        for (var i = list.length - 1; i >= 0; i--) {
          var m = list[i];
          try { if (m && typeof m.delete === 'function' && !m.isDeleted()) m.delete(); } catch (e) { /* ignore */ }
        }
        list.length = 0;
      }
    };
  }

  /** แปลง exception ของ OpenCV (ซึ่งเป็นตัวเลข pointer) ให้เป็น Error ที่อ่านได้ */
  function toError(e) {
    if (typeof e === 'number' && typeof cv !== 'undefined' && typeof cv.exceptionFromPtr === 'function') {
      try { return new Error(cv.exceptionFromPtr(e).msg); } catch (_) { /* ignore */ }
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  /** ตรวจรูปแบบภาพที่รับเข้ามา */
  function checkImage(img) {
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0) ||
        img.width > MAX_SIDE || img.height > MAX_SIDE ||
        (img.width | 0) !== img.width || (img.height | 0) !== img.height ||
        img.data.length !== img.width * img.height * 4) {
      throw new Error('รูปแบบภาพไม่ถูกต้อง');
    }
    return img;
  }

  function checkSize(w, h) {
    if (!(w >= 1 && h >= 1 && w <= MAX_SIDE && h <= MAX_SIDE)) throw new Error('ขนาดภาพผลลัพธ์ไม่ถูกต้อง');
    return { w: Math.round(w), h: Math.round(h) };
  }

  /** Mat (1, 3 หรือ 4 ช่อง) → { data: RGBA, width, height } (คัดลอกออกจากหน่วยความจำ WebAssembly) */
  function toImage(m, t) {
    var rgba = m;
    if (m.channels() === 1) { rgba = t.add(new cv.Mat()); cv.cvtColor(m, rgba, cv.COLOR_GRAY2RGBA); }
    else if (m.channels() === 3) { rgba = t.add(new cv.Mat()); cv.cvtColor(m, rgba, cv.COLOR_RGB2RGBA); }
    return { data: new Uint8ClampedArray(rgba.data), width: rgba.cols, height: rgba.rows };
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function fullQuad(w, h) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  /** เรียงมุมเป็น [บนซ้าย, บนขวา, ล่างขวา, ล่างซ้าย] */
  function orderCorners(pts) {
    var cx = 0, cy = 0;
    pts.forEach(function (p) { cx += p.x / pts.length; cy += p.y / pts.length; });
    var sorted = pts.slice().sort(function (a, b) {
      return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
    });
    var start = 0, best = Infinity;
    sorted.forEach(function (p, i) { if (p.x + p.y < best) { best = p.x + p.y; start = i; } });
    return sorted.slice(start).concat(sorted.slice(0, start)).map(function (p) { return { x: p.x, y: p.y }; });
  }

  function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }

  /** กรอบ 4 มุมต้องเป็นรูปนูน ไม่ไขว้กัน และมีพื้นที่พอสมควร */
  function isValidQuad(q, minSide) {
    if (!q || q.length !== 4) return false;
    for (var f = 0; f < 4; f++) {
      if (!q[f] || !isFinite(q[f].x) || !isFinite(q[f].y) || Math.abs(q[f].x) > 1e6 || Math.abs(q[f].y) > 1e6) return false;
    }
    var sign = 0;
    for (var i = 0; i < 4; i++) {
      var c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
      if (Math.abs(c) < 1e-6) return false;
      var s = c > 0 ? 1 : -1;
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    var min = minSide || 8;
    for (var j = 0; j < 4; j++) if (dist(q[j], q[(j + 1) % 4]) < min) return false;
    return true;
  }

  function polygonArea(q) {
    var a = 0;
    for (var i = 0; i < q.length; i++) {
      var p = q[i], n = q[(i + 1) % q.length];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function matToPoints(m) {
    var d = m.data32S, pts = [];
    for (var i = 0; i < m.rows; i++) pts.push({ x: d[i * 2], y: d[i * 2 + 1] });
    return pts;
  }

  // ---------- ตรวจจับขอบกระดาษ ----------

  /** หา contour ที่ประมาณเป็นสี่เหลี่ยมนูนได้ (เรียงจากพื้นที่มากไปน้อย สูงสุด 10 อัน) */
  function quadCandidates(bin, imgArea, t, out) {
    var contours = t.add(new cv.MatVector());
    var hierarchy = t.add(new cv.Mat());
    cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    var minArea = imgArea * 0.12;
    var maxArea = imgArea * 0.99;
    var items = [];
    for (var i = 0; i < contours.size(); i++) {
      var c = contours.get(i);
      var area = cv.contourArea(c);
      if (area >= minArea) items.push({ c: c, area: area });
      else c.delete();
    }
    items.sort(function (a, b) { return b.area - a.area; });

    items.forEach(function (it, idx) {
      if (idx < 10) {
        var hull = new cv.Mat();
        cv.convexHull(it.c, hull, false, true);
        var peri = cv.arcLength(hull, true);
        var eps = [0.02, 0.035, 0.05, 0.08];
        var found = false;
        for (var k = 0; k < eps.length && !found; k++) {
          var approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps[k] * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            var pts = matToPoints(approx);
            var a = polygonArea(pts);
            if (a >= minArea && a <= maxArea) { out.push({ pts: pts, area: a }); found = true; }
          }
          approx.delete();
        }
        hull.delete();
      }
      it.c.delete();
    });
  }

  /**
   * สัดส่วนของจุดบนแต่ละด้านของกรอบที่ตรงกับเส้นขอบจริงในภาพ (0..1)
   * กรอบที่ถูกต้องต้องมีเส้นขอบรองรับครบทั้ง 4 ด้าน — กรอบหลอกที่วิ่งไปตามขอบภาพจะได้ค่าต่ำ
   */
  function edgeSupport(edges, pts) {
    var W = edges.cols, H = edges.rows, d = edges.data;
    var sides = [];
    for (var i = 0; i < 4; i++) {
      var a = pts[i], b = pts[(i + 1) % 4];
      var n = Math.max(12, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 4));
      var hit = 0, total = 0;
      for (var k = 1; k < n; k++) {
        var x = Math.round(a.x + (b.x - a.x) * k / n);
        var y = Math.round(a.y + (b.y - a.y) * k / n);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        total++;
        if (x <= 1 || y <= 1 || x >= W - 2 || y >= H - 2) continue; // ขอบภาพไม่นับเป็นขอบกระดาษ
        if (d[y * W + x]) hit++;
      }
      sides.push(total ? hit / total : 0);
    }
    var sum = sides[0] + sides[1] + sides[2] + sides[3];
    return { min: Math.min.apply(null, sides), avg: sum / 4 };
  }

  /**
   * ความสว่างเฉลี่ยของแถบด้านในและด้านนอกกรอบ (ห่างจากเส้นขอบ off พิกเซล)
   * ใช้แยก "กระดาษบนพื้นหลัง" (ด้านในสว่างกว่า) ออกจาก "ภาพ/กล่องสีเข้มบนกระดาษ" (ด้านในมืดกว่า)
   */
  function bandLevels(gray, pts, off) {
    var W = gray.cols, H = gray.rows, d = gray.data;
    var cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    var cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    var inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (var i = 0; i < 4; i++) {
      var a = pts[i], b = pts[(i + 1) % 4];
      var len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      var nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if ((mx + nx - cx) * (mx + nx - cx) + (my + ny - cy) * (my + ny - cy) < (mx - cx) * (mx - cx) + (my - cy) * (my - cy)) {
        nx = -nx; ny = -ny; // ให้ normal ชี้ออกนอกกรอบ
      }
      for (var k = 2; k < 30; k++) {
        var px = a.x + (b.x - a.x) * k / 31, py = a.y + (b.y - a.y) * k / 31;
        var ox = Math.round(px + nx * off), oy = Math.round(py + ny * off);
        var ix = Math.round(px - nx * off), iy = Math.round(py - ny * off);
        if (ox >= 0 && oy >= 0 && ox < W && oy < H) { outSum += d[oy * W + ox]; outN++; }
        if (ix >= 0 && iy >= 0 && ix < W && iy < H) { inSum += d[iy * W + ix]; inN++; }
      }
    }
    return { inside: inN ? inSum / inN : 0, outside: outN ? outSum / outN : 0, outN: outN };
  }

  function medianOf(gray) {
    var hist = new Uint32Array(256), d = gray.data, n = d.length;
    for (var i = 0; i < n; i++) hist[d[i]]++;
    var half = n / 2, acc = 0;
    for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v; }
    return 128;
  }

  /**
   * ตรวจจับขอบกระดาษ — img ควรย่อให้ด้านยาวไม่เกิน DETECT_SIDE มาก่อน
   * คืนค่า [TL,TR,BR,BL] ในพิกัดของ img หรือ null ถ้าไม่พบ
   */
  function detect(img, debug) {
    checkImage(img);
    var t = tracker();
    try {
      var rgba = t.add(cv.matFromImageData(img));
      var W = rgba.cols, H = rgba.rows, imgArea = W * H;

      var gray = t.add(new cv.Mat());
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      var blur = t.add(new cv.Mat());
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      // closing ลบตัวอักษรบนกระดาษ ให้เหลือแต่ขอบกระดาษ
      var kClose = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
      var closed = t.add(new cv.Mat());
      cv.morphologyEx(blur, closed, cv.MORPH_CLOSE, kClose);

      // แผนที่เส้นขอบความไวสูง (ขยายเส้นเล็กน้อยให้ทนความคลาดเคลื่อน) ใช้ตรวจสอบกรอบที่หาได้
      var support = t.add(new cv.Mat());
      cv.Canny(closed, support, 15, 45);
      var kSup = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
      cv.dilate(support, support, kSup);
      var bandOff = Math.max(4, Math.round(Math.max(W, H) / 120));

      var kDil = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      var med = medianOf(closed);
      var methods = [
        [Math.max(10, 0.66 * med), Math.min(255, 1.33 * med)],
        [20, 60],
        [30, 90],
        [75, 200],
        'otsu' // วิธีสำรอง: แยกกระดาษ (สว่าง) ออกจากพื้นหลัง
      ];

      var all = [], good = [];
      for (var mi = 0; mi < methods.length; mi++) {
        var bin = t.add(new cv.Mat());
        if (methods[mi] === 'otsu') {
          cv.threshold(closed, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
          var kOpen = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));
          cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
        } else {
          cv.Canny(closed, bin, methods[mi][0], methods[mi][1]);
          cv.dilate(bin, bin, kDil);
        }
        var cands = [];
        quadCandidates(bin, imgArea, t, cands);
        cands.forEach(function (c) {
          c.support = edgeSupport(support, c.pts);
          c.band = bandLevels(closed, c.pts, bandOff);
          // ต้องมีเส้นขอบรองรับทุกด้าน และขอบด้านในต้องไม่มืดกว่าด้านนอก
          c.ok = c.support.min >= 0.45 && c.support.avg >= 0.65 &&
            (c.band.outN < 20 || c.band.inside >= c.band.outside - 4);
          all.push(c);
          if (c.ok) good.push(c);
        });
        // พบกรอบที่ชัดเจนมากแล้ว ไม่ต้องลองวิธีอื่น (เร็วขึ้นบนมือถือ)
        if (good.some(function (c) { return c.support.min >= 0.9 && c.support.avg >= 0.95; })) break;
      }
      if (debug) debug.candidates = all;
      if (!good.length) return null;
      // กระดาษมักเป็นกรอบที่ใหญ่ที่สุดซึ่งมีเส้นขอบรองรับครบ
      good.sort(function (a, b) { return b.area * b.support.avg - a.area * a.support.avg; });
      var inv = 1;
      var sz = { w: img.width, h: img.height };
      // ขยับมุมเข้าด้านในเล็กน้อย: contour ของเส้นขอบมักอยู่ด้านนอกกระดาษ ~1-2 พิกเซล
      // ถ้าไม่ขยับ จะมีเส้นพื้นหลังสีเข้มติดมาตามขอบภาพ (เห็นชัดในโหมดขาวดำ)
      var ordered = orderCorners(good[0].pts);
      var gx = 0, gy = 0;
      ordered.forEach(function (p) { gx += p.x / 4; gy += p.y / 4; });
      var inset = 3 * Math.SQRT2;
      var quad = ordered.map(function (p) {
        var dx = gx - p.x, dy = gy - p.y, len = Math.hypot(dx, dy) || 1;
        return { x: p.x + dx / len * inset, y: p.y + dy / len * inset };
      }).map(function (p) {
        return {
          x: Math.min(sz.w, Math.max(0, p.x * inv)),
          y: Math.min(sz.h, Math.max(0, p.y * inv))
        };
      });
      return isValidQuad(quad) ? quad : null;
    } catch (e) {
      throw toError(e);
    } finally {
      t.free();
    }
  }

  // ---------- ตัดภาพตามกรอบและดัดให้ตรง ----------

  function outputSize(quad) {
    return {
      w: Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])),
      h: Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]))
    };
  }

  function warpMat(img, quad, outW, outH, t) {
    checkImage(img);
    var sz = checkSize(outW, outH);
    if (!isValidQuad(quad, 1)) throw new Error('กรอบครอปไม่ถูกต้อง');
    var src = t.add(cv.matFromImageData(img));
    var srcPts = t.add(cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y
    ]));
    var dstPts = t.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, sz.w, 0, sz.w, sz.h, 0, sz.h]));
    var M = t.add(cv.getPerspectiveTransform(srcPts, dstPts));
    var dst = t.add(new cv.Mat());
    cv.warpPerspective(src, dst, M, new cv.Size(sz.w, sz.h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return dst;
  }

  /** ตัดภาพตามกรอบ quad (พิกัดของ img) ให้เป็นสี่เหลี่ยมผืนผ้าขนาด outW x outH */
  function warp(img, quad, outW, outH) {
    var t = tracker();
    try {
      return toImage(warpMat(img, quad, outW, outH, t), t);
    } catch (e) {
      throw toError(e);
    } finally {
      t.free();
    }
  }

  // ---------- ฟิลเตอร์ ----------

  function percentile(plane, p) {
    var hist = new Uint32Array(256), d = plane.data, n = d.length;
    for (var i = 0; i < n; i++) hist[d[i]]++;
    var target = n * p, acc = 0;
    for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  }

  function smallCopy(m, t) {
    var W = m.cols, H = m.rows;
    var s = Math.min(1, BG_SIDE / Math.max(W, H));
    var small = t.add(new cv.Mat());
    cv.resize(m, small, new cv.Size(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))), 0, 0, cv.INTER_AREA);
    return small;
  }

  /**
   * หน้ากากของ "เนื้อหา" บนภาพย่อ (สีสด หรือเข้มกว่ากระดาษมาก เช่น โลโก้ รูปภาพ ตัวอักษร)
   * เพื่อไม่ให้นำสีของเนื้อหาไปคิดเป็นสีพื้นกระดาษ (มิฉะนั้นพื้นที่สีขนาดใหญ่จะซีดเป็นสีขาว)
   */
  function contentMask(smallRgb, t) {
    var hsv = t.add(new cv.Mat());
    cv.cvtColor(smallRgb, hsv, cv.COLOR_RGB2HSV);
    var ch = t.add(new cv.MatVector());
    cv.split(hsv, ch);
    var s = t.add(ch.get(1)), v = t.add(ch.get(2));
    var total = s.rows * s.cols;
    var paperV = percentile(v, 0.95);
    var sThr = Math.max(70, percentile(s, 0.5) + 40);
    var mS = t.add(new cv.Mat());
    cv.threshold(s, mS, sThr, 255, cv.THRESH_BINARY);
    // กระดาษสี/แสงไฟสีจัด (ความอิ่มสีสูงเกือบทั้งภาพ) ไม่ใช้เกณฑ์ความอิ่มสี
    if (cv.countNonZero(mS) > total * 0.6) mS.setTo(new cv.Scalar(0));
    var mV = t.add(new cv.Mat());
    cv.threshold(v, mV, Math.max(20, paperV * 0.4), 255, cv.THRESH_BINARY_INV);
    var mask = t.add(new cv.Mat());
    cv.bitwise_or(mS, mV, mask);

    // พื้นที่ "กระดาษ" ที่เป็นเกาะเล็ก ๆ แยกโดดเดี่ยว (เช่น ส่วนสว่างในรูปภาพ) ไม่ใช่กระดาษจริง
    // เก็บไว้เฉพาะบริเวณกระดาษที่เชื่อมต่อกันเป็นผืนใหญ่
    var paperMask = t.add(new cv.Mat());
    cv.bitwise_not(mask, paperMask);
    var labels = t.add(new cv.Mat()), stats = t.add(new cv.Mat()), cents = t.add(new cv.Mat());
    var n = cv.connectedComponentsWithStats(paperMask, labels, stats, cents, 4, cv.CV_32S);
    var minArea = total * 0.015;
    var small = new Uint8Array(n);
    var anySmall = false;
    for (var i = 1; i < n; i++) {
      if (stats.intAt(i, cv.CC_STAT_AREA) < minArea) { small[i] = 1; anySmall = true; }
    }
    if (anySmall) {
      var lab = labels.data32S, md = mask.data;
      for (var j = 0; j < lab.length; j++) if (small[lab[j]]) md[j] = 255;
    }

    // แทบทั้งภาพเป็นเนื้อหา (เช่น ภาพถ่าย) — ไม่มีกระดาษให้อ้างอิง ใช้วิธีพื้นฐานแทน
    if (cv.countNonZero(mask) > total * 0.85) mask.setTo(new cv.Scalar(0));
    return mask;
  }

  /**
   * ประมาณสีพื้นกระดาษของภาพช่องเดียว (ขนาดย่อ): ตัดเนื้อหาทิ้ง, ใช้ max filter ลบตัวอักษร,
   * เติมช่องว่างที่เหลือด้วยสีกระดาษรอบ ๆ แล้วทำให้เรียบด้วย median
   */
  function backgroundSmall(plane, mask, t) {
    var paper = Math.max(1, percentile(plane, 0.95));
    var p = t.add(plane.clone());
    p.setTo(new cv.Scalar(0), mask);
    var k7 = t.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)));
    var dil = t.add(new cv.Mat());
    cv.dilate(p, dil, k7);

    var k9 = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    var holes = t.add(new cv.Mat());
    var grown = t.add(new cv.Mat());
    for (var i = 0; i < 48; i++) {
      cv.threshold(dil, holes, 0, 255, cv.THRESH_BINARY_INV);
      if (!cv.countNonZero(holes)) break;
      cv.dilate(dil, grown, k9);
      grown.copyTo(dil, holes);
    }
    cv.threshold(dil, holes, 0, 255, cv.THRESH_BINARY_INV);
    if (cv.countNonZero(holes)) dil.setTo(new cv.Scalar(paper), holes);

    var med = t.add(new cv.Mat());
    cv.medianBlur(dil, med, 21);
    return med;
  }

  /** ลบเงา: หารภาพด้วยสีพื้นกระดาษที่ประมาณได้ ทำให้กระดาษขาวเรียบเท่ากันทั้งแผ่น */
  function divideBy(plane, bgSmall, t) {
    var bg = t.add(new cv.Mat());
    cv.resize(bgSmall, bg, new cv.Size(plane.cols, plane.rows), 0, 0, cv.INTER_LINEAR);
    var out = t.add(new cv.Mat());
    cv.divide(plane, bg, out, 255, -1);
    return out;
  }

  function flattenColor(rgb, t) {
    var small = smallCopy(rgb, t);
    var mask = contentMask(small, t);
    var planes = t.add(new cv.MatVector());
    var smallPlanes = t.add(new cv.MatVector());
    cv.split(rgb, planes);
    cv.split(small, smallPlanes);
    var outPlanes = t.add(new cv.MatVector());
    for (var i = 0; i < 3; i++) {
      var p = t.add(planes.get(i));
      var sp = t.add(smallPlanes.get(i));
      outPlanes.push_back(divideBy(p, backgroundSmall(sp, mask, t), t));
    }
    var out = t.add(new cv.Mat());
    cv.merge(outPlanes, out);
    return out;
  }

  function flattenGray(rgb, gray, t) {
    var small = smallCopy(rgb, t);
    var mask = contentMask(small, t);
    var smallGray = t.add(new cv.Mat());
    cv.cvtColor(small, smallGray, cv.COLOR_RGB2GRAY);
    return divideBy(gray, backgroundSmall(smallGray, mask, t), t);
  }

  /** ปรับระดับสี: จุดขาว (whitePoint) และ gamma (>1 ทำให้โทนกลางเข้มขึ้น) */
  function levels(m, blackPoint, whitePoint, gamma, t) {
    var lut = t.add(new cv.Mat(1, 256, cv.CV_8UC1));
    var range = Math.max(1, whitePoint - blackPoint);
    for (var i = 0; i < 256; i++) {
      var v = Math.min(1, Math.max(0, (i - blackPoint) / range));
      lut.data[i] = Math.round(255 * Math.pow(v, gamma));
    }
    var out = t.add(new cv.Mat());
    cv.LUT(m, lut, out);
    return out;
  }

  function saturate(rgb, factor, t) {
    var hsv = t.add(new cv.Mat());
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    var ch = t.add(new cv.MatVector());
    cv.split(hsv, ch);
    var h = t.add(ch.get(0)), s = t.add(ch.get(1)), v = t.add(ch.get(2));
    var s2 = t.add(new cv.Mat());
    s.convertTo(s2, -1, factor, 0);
    var merged = t.add(new cv.MatVector());
    merged.push_back(h); merged.push_back(s2); merged.push_back(v);
    var hsv2 = t.add(new cv.Mat());
    cv.merge(merged, hsv2);
    var out = t.add(new cv.Mat());
    cv.cvtColor(hsv2, out, cv.COLOR_HSV2RGB);
    return out;
  }

  function sharpen(m, amount, t) {
    var sigma = Math.max(1, Math.max(m.cols, m.rows) / 1100);
    var blur = t.add(new cv.Mat());
    cv.GaussianBlur(m, blur, new cv.Size(0, 0), sigma);
    var out = t.add(new cv.Mat());
    cv.addWeighted(m, 1 + amount, blur, -amount, 0, out);
    return out;
  }

  /** ความสว่าง/คอนทราสต์ (-100..100) */
  function brightnessContrast(m, brightness, contrast, t) {
    if (!brightness && !contrast) return m;
    var alpha = contrast >= 0 ? 1 + (contrast / 100) * 1.5 : 1 + (contrast / 100) * 0.8;
    var beta = brightness * 1.28 + 128 * (1 - alpha);
    var out = t.add(new cv.Mat());
    m.convertTo(out, -1, alpha, beta);
    return out;
  }

  function toGray(rgb, t) {
    var g = t.add(new cv.Mat());
    cv.cvtColor(rgb, g, cv.COLOR_RGB2GRAY);
    return g;
  }

  var pipelines = {
    original: function (rgb, st, t) {
      var m = st.removeShadow ? levels(flattenColor(rgb, t), 0, 250, 1, t) : rgb;
      return brightnessContrast(m, st.brightness, st.contrast, t);
    },
    enhance: function (rgb, st, t) {
      var m = st.removeShadow ? levels(flattenColor(rgb, t), 0, 242, 1.25, t) : levels(rgb, 8, 250, 1.05, t);
      m = saturate(m, 1.3, t);
      m = sharpen(m, 0.8, t);
      return brightnessContrast(m, st.brightness, st.contrast, t);
    },
    gray: function (rgb, st, t) {
      var g = toGray(rgb, t);
      var m = st.removeShadow ? levels(flattenGray(rgb, g, t), 0, 245, 1.2, t) : g;
      m = sharpen(m, 0.5, t);
      return brightnessContrast(m, st.brightness, st.contrast, t);
    },
    bw: function (rgb, st, t) {
      // ขาวดำต้องปรับพื้นหลังให้เรียบเสมอ มิฉะนั้นเงาจะกลายเป็นก้อนสีดำ
      var norm = flattenGray(rgb, toGray(rgb, t), t);
      var tmp = t.add(new cv.Mat());
      var otsu = cv.threshold(norm, tmp, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
      var T = Math.min(235, Math.max(150, otsu + 15));
      T = T + (st.bwStrength || 0) * 1.2 - (st.brightness || 0) * 0.6;
      T = Math.min(252, Math.max(40, T));
      var smooth = t.add(new cv.Mat());
      cv.GaussianBlur(norm, smooth, new cv.Size(3, 3), 0);
      var bin = t.add(new cv.Mat());
      cv.threshold(smooth, bin, T, 255, cv.THRESH_BINARY);
      return bin;
    },
    // สำหรับ OCR: โทนเทาที่ลบเงาแล้ว และลบเส้นตาราง/เส้นยาว (เส้นตารางทำให้ OCR ข้ามข้อความในตาราง)
    ocr: function (rgb, st, t) {
      var norm = flattenGray(rgb, toGray(rgb, t), t);
      var W = norm.cols, H = norm.rows;
      var inv = t.add(new cv.Mat());
      cv.threshold(norm, inv, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
      var hk = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(25, Math.round(W / 22)), 1)));
      var vk = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(25, Math.round(H / 22)))));
      var hl = t.add(new cv.Mat());
      var vl = t.add(new cv.Mat());
      cv.morphologyEx(inv, hl, cv.MORPH_OPEN, hk);
      cv.morphologyEx(inv, vl, cv.MORPH_OPEN, vk);
      var lines = t.add(new cv.Mat());
      cv.bitwise_or(hl, vl, lines);
      var k3 = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      cv.dilate(lines, lines, k3);
      norm.setTo(new cv.Scalar(255), lines);
      return levels(norm, 0, 235, 1.1, t);
    }
  };

  function clampNum(v, lo, hi) {
    v = Number(v);
    return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
  }

  /** ค่าตั้งปรับภาพที่ถูกต้องเสมอ (กันค่าผิดรูปแบบ) */
  function normalizeSettings(settings) {
    var s = settings || {};
    return {
      filter: FILTERS.indexOf(s.filter) >= 0 || s.filter === 'ocr' ? s.filter : 'enhance',
      removeShadow: s.removeShadow !== false,
      brightness: clampNum(s.brightness, -100, 100),
      contrast: clampNum(s.contrast, -100, 100),
      bwStrength: clampNum(s.bwStrength, -50, 50)
    };
  }

  function processMat(rgba, settings, t) {
    var st = normalizeSettings(settings);
    var rgb = t.add(new cv.Mat());
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    return pipelines[st.filter](rgb, st, t);
  }

  /** ใช้ฟิลเตอร์กับภาพที่ครอปแล้ว (การหมุนภาพทำที่ฝั่งหน้าเว็บ) */
  function process(img, settings) {
    checkImage(img);
    var t = tracker();
    try {
      return toImage(processMat(t.add(cv.matFromImageData(img)), settings, t), t);
    } catch (e) {
      throw toError(e);
    } finally {
      t.free();
    }
  }

  /** ครอป + ปรับภาพในครั้งเดียว */
  function warpProcess(img, quad, outW, outH, settings) {
    var t = tracker();
    try {
      return toImage(processMat(warpMat(img, quad, outW, outH, t), settings, t), t);
    } catch (e) {
      throw toError(e);
    } finally {
      t.free();
    }
  }

  root.ScanCore = {
    DETECT_SIDE: DETECT_SIDE,
    FILTERS: FILTERS,
    defaultSettings: defaultSettings,
    normalizeSettings: normalizeSettings,
    detect: detect,
    warp: warp,
    process: process,
    warpProcess: warpProcess,
    fullQuad: fullQuad,
    orderCorners: orderCorners,
    isValidQuad: isValidQuad,
    outputSize: outputSize,
    toError: toError
  };
})(typeof self !== 'undefined' ? self : this);
