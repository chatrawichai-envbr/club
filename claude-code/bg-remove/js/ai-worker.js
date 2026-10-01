/*
 * ai-worker.js — Web Worker ที่รันโมเดลลบพื้นหลังด้วย ONNX Runtime Web (WebAssembly, CPU, 1 เธรด)
 * แยกจากหน้าเว็บ หน้าจอจึงไม่ค้างระหว่างประมวลผล (IS-Net ใช้หน่วยความจำราว 1.2 GB)
 *
 * ข้อความเข้า:  { type: 'run', id, model: 'isnet'|'u2netp', rgba: ArrayBuffer (S×S×4) }
 * ข้อความออก:  { type: 'progress', id, stage: 'download'|'load'|'run', loaded?, total? }
 *              { type: 'result', id, mask: ArrayBuffer (S×S ค่า 0–255), size: S, ms } | { type: 'result', id, error }
 */
'use strict';

importScripts('core.js', '../vendor/onnxruntime/ort.wasm.min.js');

var BASE = new URL('../', self.location.href).href; // โฟลเดอร์ของระบบ
ort.env.wasm.wasmPaths = BASE + 'vendor/onnxruntime/';
ort.env.wasm.numThreads = 1; // GitHub Pages ตั้ง header COOP/COEP ไม่ได้ จึงใช้หลายเธรดไม่ได้
ort.env.wasm.proxy = false;

var sessions = {}; // โหลดครั้งเดียวต่อโมเดล — เปลี่ยนโมเดลแล้วปิดตัวเก่าคืนหน่วยความจำ

/** ดาวน์โหลดโมเดลพร้อมบอกความคืบหน้า (IS-Net ~44 MB) — เบราว์เซอร์เก็บในแคช ครั้งต่อไปเร็วขึ้น */
async function download(url, id, expected) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('ดาวน์โหลดโมเดลไม่สำเร็จ (HTTP ' + res.status + ')');
  var total = Number(res.headers.get('content-length')) || expected;
  if (!res.body || typeof res.body.getReader !== 'function') return new Uint8Array(await res.arrayBuffer());
  var reader = res.body.getReader();
  var chunks = [];
  var loaded = 0;
  var last = 0;
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    loaded += r.value.length;
    if (loaded - last > 1048576) {
      last = loaded;
      self.postMessage({ type: 'progress', id: id, stage: 'download', loaded: loaded, total: total });
    }
  }
  var out = new Uint8Array(loaded);
  var pos = 0;
  chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  return out;
}

async function session(name, id) {
  if (sessions[name]) return sessions[name];
  var spec = BgCore.model(name);
  Object.keys(sessions).forEach(function (k) {
    var old = sessions[k];
    delete sessions[k];
    Promise.resolve(old).then(function (s) { return s.release(); }).catch(function () { /* ignore */ });
  });
  var p = (async function () {
    var bytes = await download(BASE + spec.file, id, spec.bytes);
    if (bytes.length !== spec.bytes) throw new Error('ไฟล์โมเดลไม่สมบูรณ์ ลองใหม่อีกครั้ง');
    self.postMessage({ type: 'progress', id: id, stage: 'load' });
    return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })();
  sessions[name] = p;
  p.catch(function () { if (sessions[name] === p) delete sessions[name]; });
  return p;
}

async function run(msg) {
  var spec = BgCore.model(msg.model);
  if (!spec) throw new Error('ไม่รู้จักโมเดล');
  if (!(msg.rgba instanceof ArrayBuffer) || msg.rgba.byteLength !== spec.size * spec.size * 4) throw new Error('ขนาดภาพอินพุตไม่ถูกต้อง');
  var s = await session(msg.model, msg.id);
  self.postMessage({ type: 'progress', id: msg.id, stage: 'run' });
  var input = BgCore.buildInput(new Uint8ClampedArray(msg.rgba), spec);
  var started = Date.now();
  var feeds = {};
  feeds[s.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, spec.size, spec.size]);
  var out = await s.run(feeds);
  var tensor = out[s.outputNames[0]];
  if (!tensor || tensor.data.length !== spec.size * spec.size) throw new Error('ผลของโมเดลไม่ถูกต้อง');
  var mask = BgCore.maskToBytes(tensor.data);
  Object.keys(out).forEach(function (k) { if (out[k] && out[k].dispose) out[k].dispose(); });
  return { mask: mask.buffer, size: spec.size, ms: Date.now() - started };
}

// ทีละภาพตามลำดับ
var chain = Promise.resolve();

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'run') return;
  chain = chain.then(function () {
    return run(msg).then(function (r) {
      self.postMessage({ type: 'result', id: msg.id, mask: r.mask, size: r.size, ms: r.ms }, [r.mask]);
    }, function (err) {
      self.postMessage({ type: 'result', id: msg.id, error: String((err && err.message) || err).slice(0, 300) });
    });
  });
};
