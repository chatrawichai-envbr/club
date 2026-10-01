// แปลงไฟล์ใน Web Worker หน้าเว็บจึงไม่ค้างระหว่างแปลงไฟล์ใหญ่
"use strict";
importScripts("csv2vcf-data.js", "csv2vcf.js");
// บอกหน้าเว็บว่าโหลดสคริปต์ครบแล้ว error หลังจากนี้คือ worker ล่มระหว่างแปลง ไม่ใช่โหลดไม่ได้
self.postMessage({ ready: true });

self.onmessage = (event) => {
  const message = event.data || {};
  let reply;
  try {
    const data = new Uint8Array(message.buffer);
    reply = { id: message.id, ok: true, result: self.CSV2VCF.convert(data, message.settings) };
  } catch (error) {
    if (error instanceof self.CSV2VCF.ConversionError) {
      reply = { id: message.id, ok: false, error: error.message };
    } else {
      reply = { id: message.id, ok: false, crash: true, error: String((error && error.message) || error) };
    }
  }
  self.postMessage(reply);
};
