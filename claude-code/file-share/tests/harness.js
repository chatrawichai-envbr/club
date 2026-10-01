// ตัวกลางให้ tests/test_fileshare.py เรียก js/core.js ใน Node
// อ่านรายการคำขอ JSON { fn, args } จาก stdin แล้วเขียนผลลัพธ์ตามลำดับเดียวกันออก stdout
// อาร์กิวเมนต์ที่เป็น { "$bytes": [..] } หรือ { "$hex": "..." } แปลงเป็น Uint8Array (ใช้ทดสอบฟังก์ชันที่อ่านไบต์ของไฟล์)
"use strict";
const path = require("path");
const Core = require(path.join(__dirname, "..", "js", "core.js"));

function decode(arg) {
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    if (Array.isArray(arg.$bytes)) return Uint8Array.from(arg.$bytes);
    if (typeof arg.$hex === "string") return Uint8Array.from(Buffer.from(arg.$hex, "hex"));
    // { "$global": "crypto" | "subtle" } → Web Crypto ของ Node (ใช้กับ randomToken/pkceChallenge)
    if (arg.$global === "crypto") return globalThis.crypto;
    if (arg.$global === "subtle") return globalThis.crypto.subtle;
  }
  return arg;
}

async function run(request) {
  const fn = Core[request.fn];
  if (typeof fn !== "function") return { ok: false, error: "ไม่มีฟังก์ชัน " + request.fn };
  try {
    const started = process.hrtime.bigint();
    const value = await fn(...(request.args || []).map(decode));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Uint8Array/Float32Array → อาร์เรย์ธรรมดา (JSON.stringify แปลง typed array เป็น object)
    const plain = ArrayBuffer.isView(value) ? Array.from(value) : value;
    return { ok: true, value: plain === undefined ? null : plain, ms: ms };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const requests = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  (async () => {
    const out = [];
    for (const r of requests) out.push(await run(r));
    process.stdout.write(JSON.stringify(out));
  })();
});
