/*
 * cv-worker.js — Web Worker ที่รัน OpenCV.js แยกจากหน้าเว็บ
 * หน้าเว็บจึงไม่ค้างระหว่างประมวลผล และเปิดหลาย worker เพื่อประมวลผลหลายหน้าพร้อมกันได้
 *
 * ข้อความเข้า:
 *   { type: 'init', script, core, wasm? }             โหลด OpenCV.js (URL จากเว็บไซต์เดียวกันเท่านั้น
 *                                                     รวมถึง blob: ที่หน้าเว็บสร้าง — ใช้ในเวอร์ชัน Apps Script)
 *   { type: 'run', id, op, args }                     op: detect | warp | process | warpProcess | memory
 * ข้อความออก:
 *   { type: 'ready', ms } | { type: 'init-error', message }
 *   { type: 'result', id, result } | { type: 'result', id, error, fatal }
 */
'use strict';

var OPS = { detect: 1, warp: 1, process: 1, warpProcess: 1, memory: 1 };
var ready = false;
var initStarted = false;

function sameOrigin(url) {
  try { return new URL(url, self.location.href).origin === self.location.origin; } catch (e) { return false; }
}

/** รอให้ OpenCV runtime พร้อม (รองรับทั้ง build แบบ emscripten 2.x ที่เป็น thenable และ 3.x ที่เป็น Promise) */
function waitForCv() {
  return new Promise(function (resolve, reject) {
    var c = self.cv;
    if (!c) { reject(new Error('ไม่พบ OpenCV')); return; }
    if (typeof Promise !== 'undefined' && c instanceof Promise) {
      c.then(function (mod) { self.cv = mod; resolve(); }, reject);
      return;
    }
    // emscripten 2.x: ห้าม await/resolve ด้วย cv ตรง ๆ เพราะเป็น thenable ที่ resolve เป็นตัวเอง (วนไม่รู้จบ)
    var done = false;
    var finish = function () { if (!done && typeof self.cv.Mat === 'function') { done = true; clearInterval(timer); resolve(); } };
    var prev = c.onRuntimeInitialized;
    c.onRuntimeInitialized = function () { if (typeof prev === 'function') prev(); finish(); };
    var timer = setInterval(finish, 100);
    finish();
  });
}

function init(msg) {
  if (initStarted) return;
  initStarted = true;
  var t0 = Date.now();
  try {
    if (!sameOrigin(msg.script) || !sameOrigin(msg.core) || (msg.wasm != null && !sameOrigin(msg.wasm))) {
      throw new Error('อนุญาตเฉพาะไฟล์จากเว็บไซต์เดียวกัน');
    }
    // ให้ build ที่แยกไฟล์ .wasm หาไฟล์ได้ถูกที่ (OpenCV.js ส่ง global `Module` เข้า factory)
    self.Module = {
      locateFile: function (path) { return msg.wasm && /\.wasm$/.test(path) ? msg.wasm : path; }
    };
    importScripts(msg.core, msg.script);
  } catch (e) {
    self.postMessage({ type: 'init-error', message: (e && e.message) || String(e) });
    return;
  }
  waitForCv().then(function () {
    ready = true;
    self.postMessage({ type: 'ready', ms: Date.now() - t0 });
  }, function (e) {
    self.postMessage({ type: 'init-error', message: (e && e.message) || String(e) });
  });
}

/** ขนาดหน่วยความจำ WebAssembly ปัจจุบัน (ใช้ตรวจการรั่วของหน่วยความจำ) */
function heapBytes() {
  var m = new cv.Mat(1, 1, cv.CV_8UC1);
  try { return { heap: m.data.buffer.byteLength }; } finally { m.delete(); }
}

function isFatal(message) {
  return /abort|out of memory|oom|memory access out of bounds|unreachable/i.test(message || '');
}

function run(msg) {
  var id = msg.id;
  if (!ready) { self.postMessage({ type: 'result', id: id, error: 'OpenCV ยังไม่พร้อม' }); return; }
  if (!OPS[msg.op]) { self.postMessage({ type: 'result', id: id, error: 'คำสั่งไม่ถูกต้อง' }); return; }
  var a = msg.args || {};
  try {
    var result;
    if (msg.op === 'detect') result = ScanCore.detect(a.img);
    else if (msg.op === 'warp') result = ScanCore.warp(a.img, a.quad, a.outW, a.outH);
    else if (msg.op === 'process') result = ScanCore.process(a.img, a.settings);
    else if (msg.op === 'warpProcess') result = ScanCore.warpProcess(a.img, a.quad, a.outW, a.outH, a.settings);
    else result = heapBytes();
    var transfer = result && result.data && result.data.buffer ? [result.data.buffer] : [];
    self.postMessage({ type: 'result', id: id, result: result }, transfer);
  } catch (e) {
    var err = ScanCore.toError(e);
    self.postMessage({ type: 'result', id: id, error: err.message, fatal: isFatal(err.message) });
  }
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'run') run(msg);
};
