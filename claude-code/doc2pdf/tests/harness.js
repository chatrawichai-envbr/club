// ตัวกลางให้ tests/test_doc2pdf.py เรียกโค้ด JavaScript ของ doc2pdf ใน Node
// โมดูลใน js/ เป็น IIFE ที่ผูกกับ window จึงโหลดใน vm ที่มี window จำลอง (ไม่มี DOM)
// อ่านรายการคำขอ JSON { fn, args } จาก stdin (ข้อมูลไบนารีเป็น { "__bytes__": base64 })
// แล้วเขียนผลลัพธ์ { ok, value, ms } ออก stdout ตามลำดับเดียวกัน
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const JS = path.join(__dirname, "..", "js");
const MODULES = ["cv-core.js", "scanner.js", "thai-text.js", "zip.js", "docx.js", "pdf-export.js", "ocr.js", "pdf-actualtext.js", "pdf-tools.js"];

const ctx = {
  console, setTimeout, clearTimeout, Promise, TextEncoder, TextDecoder, URL, Blob, Response,
  CompressionStream, DecompressionStream,
  document: { baseURI: "https://example.test/doc2pdf/" },
  location: { protocol: "https:", href: "https://example.test/doc2pdf/" },
  navigator: {},
};
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const name of MODULES) vm.runInContext(fs.readFileSync(path.join(JS, name), "utf8"), ctx, { filename: name });

const IDENTITY = [1, 0, 0, 1, 0, 0];
const UTIL = {
  transform: (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ],
};

function bytesArg(value) {
  if (value && typeof value === "object" && typeof value.__bytes__ === "string") {
    return new Uint8Array(Buffer.from(value.__bytes__, "base64"));
  }
  return value;
}

async function blobToBase64(blob) {
  return { __bytes__: Buffer.from(await blob.arrayBuffer()).toString("base64") };
}

const API = {
  sanitizeFilename: (name) => ctx.PdfExport.sanitizeFilename(name),
  cleanText: (text) => ctx.Ocr.cleanText(text),
  // items: [{ str, x, y, width, hasEOL }] → ข้อความของแต่ละบรรทัด
  buildLines: (items) => ctx.PdfTools._buildLines(
    items.map((it) => ({ str: it.str, transform: [10, 0, 0, 10, it.x, it.y], width: it.width, height: 10, hasEOL: !!it.hasEOL })),
    IDENTITY, UTIL,
  ).map((line) => line.text),
  actualText: (pdf, pageNum) => ctx.PdfActualText.create(async () => pdf).forPage({ num: pageNum, gen: 0 }),
  // อ่านหลายหน้าด้วยตัวอ่านเดียวกัน (เพดานรวมทั้งไฟล์) → ผลของแต่ละหน้า
  actualTextPages: async (pdf, pages) => {
    const reader = ctx.PdfActualText.create(async () => pdf);
    const out = [];
    for (const p of pages) out.push(await reader.forPage({ num: p, gen: 0 }));
    return out;
  },
  xml: (text) => ctx.Docx.xml(text),
  zip: async (entries) => blobToBase64(await ctx.Zip.create(entries)),
  docx: async (opts) => blobToBase64(await ctx.Docx.create(opts)),
  // ค่าตั้งค่าจากตาราง PRESETS/FONTS (ชื่อที่ไม่มีจริง เช่น constructor ต้องได้ค่าเริ่มต้น)
  pick: (table, key) => ctx.PdfTools._pick(ctx.PdfTools[table], key, table === "PRESETS" ? "standard" : "sarabun"),
  pageLayout: (w, h, opts) => ctx.PdfExport.pageLayout(w, h, opts),
  isImageFile: (name, type) => ctx.Scanner.isImageFile({ name, type }),
  heic: heicScenario,
};

/**
 * HeicDecoder กับ Worker จำลอง — behaviors: พฤติกรรมของ worker แต่ละตัวตามลำดับที่ถูกสร้าง
 *   'ok' ตอบผลปกติ, 'hang' ไม่ตอบเลย, 'crash' ล่มพร้อมข้อความ (เช่น หน่วยความจำไม่พอ), 'load' โหลดสคริปต์ไม่ได้ (ไม่มีข้อความ)
 * files: จำนวนไฟล์ที่ถอดรหัสพร้อมกัน — คืนผลของแต่ละไฟล์ จำนวน worker ที่สร้าง และจำนวนครั้งที่ถอดรหัสในหน้าเว็บ
 */
async function heicScenario(behaviors, files) {
  const log = { workers: 0, inline: 0 };
  const hc = {
    console: { warn() {}, error() {}, log() {} },
    Promise, Object, Number, String, Math, Blob, ArrayBuffer, Uint8Array, Uint8ClampedArray,
    location: { protocol: "https:", href: "https://example.test/doc2pdf/" },
    // เวลาจำลอง: timeout ยาว ๆ (120 วินาที) ครบใน 20 ms
    setTimeout: (fn, ms) => setTimeout(fn, ms > 1000 ? 20 : ms),
    clearTimeout,
  };
  hc.window = hc;
  hc.self = hc;
  hc.globalThis = hc;
  hc.ImageData = class {
    constructor(a, b, c) {
      if (typeof a === "number") Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) });
      else Object.assign(this, { data: a, width: b, height: c });
    }
  };
  const fakeLibheif = () => ({
    HeifDecoder: class {
      decode() {
        log.inline++;
        return [{ get_width: () => 2, get_height: () => 2, display: (out, done) => done(out), free() {} }];
      }
    },
  });
  hc.AppPlatform = {
    resolve: (p) => Promise.resolve("https://example.test/doc2pdf/" + p),
    loadScript: () => { hc.libheif = fakeLibheif; return Promise.resolve(); },
  };
  let made = 0;
  hc.Worker = class {
    constructor() { this.kind = behaviors[made++] || "ok"; this.dead = false; log.workers++; }
    postMessage(msg) {
      setTimeout(() => {
        if (this.dead) return;
        if (this.kind === "ok") this.onmessage({ data: { type: "result", id: msg.id, width: 1, height: 1, data: new ArrayBuffer(4) } });
        else if (this.kind === "crash") this.onerror({ message: "Uncaught RangeError: Out of memory", preventDefault() {} });
        else if (this.kind === "load") this.onerror({ preventDefault() {} });
      }, 5);
    }
    terminate() { this.dead = true; }
  };
  vm.createContext(hc);
  vm.runInContext(fs.readFileSync(path.join(JS, "heic.js"), "utf8"), hc, { filename: "heic.js" });
  // ส่วนหัวไฟล์ HEIC: กล่อง ftyp แบรนด์ heic
  const header = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
    0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]);
  const results = await Promise.all(Array.from({ length: files }, () => hc.HeicDecoder.decode(new Blob([header]), 1e6).then(
    (img) => ({ ok: true, width: img.width }),
    (e) => ({ ok: false, error: e.message, fromWorker: !!e.fromWorker, retryWorker: !!e.retryWorker }),
  )));
  return { results, workers: log.workers, inline: log.inline };
}

async function run(request) {
  const start = process.hrtime.bigint();
  try {
    const fn = API[request.fn];
    if (typeof fn !== "function") throw new Error("ไม่มีฟังก์ชัน " + request.fn);
    const value = await fn(...request.args.map(bytesArg));
    return { ok: true, value: value === undefined ? null : value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), ms: Number(process.hrtime.bigint() - start) / 1e6 };
  }
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const results = [];
  for (const request of JSON.parse(Buffer.concat(chunks).toString("utf8"))) results.push(await run(request));
  process.stdout.write(JSON.stringify(results));
});
