// ตัวกลางให้ tests/test_qrcode.py เรียก js/payload.js ใน Node
// อ่านรายการคำขอ JSON { fn, args } จาก stdin แล้วเขียนผลลัพธ์ตามลำดับเดียวกันออก stdout
"use strict";
const path = require("path");
const QrPayload = require(path.join(__dirname, "..", "js", "payload.js"));

function run(request) {
  const fn = QrPayload[request.fn];
  if (typeof fn !== "function") return { ok: false, error: "ไม่มีฟังก์ชัน " + request.fn };
  try {
    return { ok: true, value: fn(...request.args) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8")).map(run)));
});
