// ตัวกลางให้ tests/test_static_site.py เรียกโค้ด JavaScript ของเว็บไซต์ (csv2vcf.js)
// อ่านรายการคำขอ JSON จาก stdin แล้วเขียนผลลัพธ์ JSON ออก stdout ตามลำดับเดียวกัน
"use strict";
const path = require("path");
const C = require(path.join(__dirname, "..", "csv2vcf.js"));

function decodeArg(value) {
  if (value && typeof value === "object" && typeof value.__bytes__ === "string") {
    return new Uint8Array(Buffer.from(value.__bytes__, "base64"));
  }
  return value;
}

function run(request) {
  try {
    if (request.op === "convert") {
      return { ok: true, value: C.convert(decodeArg(request.data), request.settings) };
    }
    const fn = C[request.fn];
    if (typeof fn !== "function") throw new Error("ไม่มีฟังก์ชัน " + request.fn);
    return { ok: true, value: fn(...request.args.map(decodeArg)) };
  } catch (error) {
    if (error instanceof C.ConversionError) return { ok: false, error: error.message };
    return { ok: false, error: "JS " + error.name + ": " + error.message, crash: true };
  }
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const requests = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify(requests.map(run)));
});
