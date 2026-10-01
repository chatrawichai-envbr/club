"use strict";

// หน้าเว็บแปลงรายชื่อ CSV เป็น vCard (ทำงานในเบราว์เซอร์ทั้งหมด ไม่ส่งไฟล์ไปที่ไหน)
// ข้อความทุกอย่างที่มาจากไฟล์ของผู้ใช้ใส่ลงหน้าเว็บด้วย textContent เท่านั้น (ไม่แปลงเป็น HTML)
// จึงแทรกสคริปต์ผ่านชื่อหรือข้อมูลในไฟล์ไม่ได้
(function () {
  const $ = (id) => document.getElementById(id);
  const page = $("page");
  const maxMb = Number(page.dataset.maxMb) || 50;
  const PREVIEW_LIMIT = 20;
  const PREVIEW_SCAN_CHARS = 300000; // อ่านแค่ส่วนต้นของไฟล์ผลลัพธ์เพื่อทำตัวอย่าง

  const form = $("form");
  const input = $("file");
  const drop = $("drop");
  const button = $("convert");
  const status = $("status");
  const result = $("result");
  const download = $("download");

  // Android: หน้าเลือกไฟล์ของระบบกรองได้เฉพาะ MIME type — accept ที่มีนามสกุล (.csv, .txt) ทำให้หน้าเลือกไฟล์
  // ของ Firefox บน Android ค้างแล้วปิดตัว และไฟล์ CSV บน Android ถูกระบุ MIME ได้หลายแบบ (text/comma-separated-values,
  // application/octet-stream) จนบางไฟล์เลือกไม่ได้ จึงไม่กรองชนิดไฟล์ — ตรวจไฟล์เองหลังเลือกอยู่แล้ว
  // โหมด "เว็บไซต์เดสก์ท็อป" ของเบราว์เซอร์บน Android ส่ง user agent เป็น Linux จึงดูจากจอสัมผัสด้วย
  const android = /Android/i.test(navigator.userAgent) ||
    (/Linux/i.test(navigator.userAgent) && window.matchMedia("(pointer: coarse)").matches);
  if (android) input.removeAttribute("accept");

  let file = null;
  let downloadUrl = null;

  $("max-mb").textContent = String(maxMb); // ต้องใส่ก่อนเก็บข้อความเริ่มต้นด้านล่าง
  const defaultTitle = $("drop-title").textContent;
  const defaultHint = $("drop-hint").textContent;

  function setStatus(message, kind) {
    status.textContent = message;
    status.className = "status" + (kind ? " " + kind : "");
  }

  function clearResult() {
    result.hidden = true;
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
    }
  }

  function chooseFile(candidate) {
    cancelConversion();
    clearResult();
    file = null;
    button.disabled = true;
    drop.classList.remove("has-file");
    $("drop-title").textContent = defaultTitle;
    $("drop-hint").textContent = defaultHint;
    if (!candidate) {
      setStatus("");
      return;
    }
    if (/\.(xlsx|xlsm|xls|numbers|ods)$/i.test(candidate.name)) {
      setStatus("ไฟล์นี้เป็นไฟล์ตาราง ไม่ใช่ CSV ให้เปิดในโปรแกรมแล้วบันทึกเป็น “CSV UTF-8” ก่อน", "error");
      return;
    }
    if (candidate.size === 0) {
      setStatus("ไฟล์ว่างเปล่า", "error");
      return;
    }
    if (candidate.size > maxMb * 1024 * 1024) {
      setStatus("ไฟล์ใหญ่เกิน " + maxMb + " MB", "error");
      return;
    }
    file = candidate;
    drop.classList.add("has-file");
    $("drop-title").textContent = displayName(candidate.name) || "(ไม่มีชื่อ)";
    $("drop-hint").textContent = formatSize(candidate.size) + " · แตะเพื่อเปลี่ยนไฟล์";
    button.disabled = false;
    setStatus("");
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " ไบต์";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  input.addEventListener("change", () => {
    chooseFile(input.files[0] || null);
    // ล้างค่าในช่อง เพื่อให้เลือกไฟล์ชื่อเดิมซ้ำได้ (เช่น หลังแก้ไฟล์ CSV) ตัวแปร file ยังเก็บไฟล์ไว้
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((type) =>
    drop.addEventListener(type, () => drop.classList.remove("dragging"))
  );
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    const dropped = event.dataTransfer && event.dataTransfer.files[0];
    if (dropped) chooseFile(dropped);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (file) convert(file);
  });

  // ---------------------------------------------------------------------------
  // แปลงไฟล์ใน Web Worker (ถ้าเบราว์เซอร์ไม่ยอม เช่น เปิดไฟล์ตรงจากเครื่อง จะแปลงในหน้านี้แทน)
  // ---------------------------------------------------------------------------

  class WorkerUnavailable extends Error {}
  class WorkerCrashed extends Error {}
  let worker = null; // null = ยังไม่ได้สร้าง, false = ใช้ไม่ได้
  let workerReady = false;
  let pending = null;
  let jobId = 0;

  function getWorker() {
    if (worker === null) {
      try {
        worker = new Worker("worker.js");
        workerReady = false;
        worker.onmessage = (event) => {
          const reply = event.data || {};
          if (reply.ready) {
            workerReady = true;
            return;
          }
          if (!pending || reply.id !== pending.id) return;
          const job = pending;
          pending = null;
          job.resolve(reply);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          const loaded = workerReady;
          worker.terminate();
          // โหลดสคริปต์ไม่ได้ (เช่น เปิดไฟล์ตรงจากเครื่อง): เลิกใช้ worker แล้วแปลงในหน้านี้แทน
          // ล่มระหว่างแปลง (เช่น หน่วยความจำไม่พอ): สร้างใหม่ครั้งหน้า แต่ไม่แปลงซ้ำในหน้านี้
          // เพราะจะทำให้แท็บค้างหรือล่มตาม
          worker = loaded ? null : false;
          if (pending) {
            const job = pending;
            pending = null;
            job.reject(loaded ? new WorkerCrashed() : new WorkerUnavailable());
          }
        };
      } catch (error) {
        worker = false;
      }
    }
    return worker;
  }

  function cancelConversion() {
    // เลือกไฟล์ใหม่ระหว่างแปลง: หยุดงานเก่าทันที ไม่ปล่อยให้ worker ทำงานค้าง
    if (pending && worker) {
      worker.terminate();
      worker = null;
    }
    pending = null;
  }

  function convertInWorker(activeWorker, buffer, settings) {
    return new Promise((resolve, reject) => {
      pending = { id: ++jobId, resolve, reject };
      activeWorker.postMessage({ id: pending.id, buffer, settings }, [buffer]);
    });
  }

  function convertHere(buffer, settings) {
    try {
      return { ok: true, result: window.CSV2VCF.convert(new Uint8Array(buffer), settings) };
    } catch (error) {
      if (error instanceof window.CSV2VCF.ConversionError) return { ok: false, error: error.message };
      return { ok: false, crash: true, error: String((error && error.message) || error) };
    }
  }

  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

  async function runConversion(selected, settings) {
    const activeWorker = getWorker();
    if (activeWorker) {
      try {
        return await convertInWorker(activeWorker, await selected.arrayBuffer(), settings);
      } catch (error) {
        if (!(error instanceof WorkerUnavailable)) throw error;
      }
    }
    await nextFrame(); // ให้หน้าเว็บแสดง "กำลังแปลงไฟล์…" ก่อนเริ่มงานหนัก
    return convertHere(await selected.arrayBuffer(), settings);
  }

  // ข้อความจากตัวแปลงเขียนไว้สำหรับคำสั่งในเทอร์มินัล ปรับคำแนะนำให้ตรงกับหน้าเว็บ
  function forWeb(message) {
    return message
      .replace(/ลองระบุ --encoding utf-16-le$/, "ลองเลือกการเข้ารหัสอักขระเป็น UTF-16 ในตัวเลือกเพิ่มเติม")
      .replace(/ลองระบุ --encoding เช่น [^\n]*$/, "ลองเลือกการเข้ารหัสอักขระในตัวเลือกเพิ่มเติม");
  }

  async function convert(selected) {
    clearResult();
    button.disabled = true;
    setStatus("กำลังแปลงไฟล์…", "busy");
    const settings = {
      countryCode: $("country-code").value,
      dateOrder: $("date-order").value,
      encoding: $("encoding").value,
      delimiter: $("delimiter").value,
    };
    let reply;
    try {
      reply = await runConversion(selected, settings);
    } catch (error) {
      reply = {
        ok: false,
        error: error instanceof WorkerCrashed
          ? "แปลงไฟล์ไม่สำเร็จ ไฟล์อาจใหญ่เกินหน่วยความจำของเบราว์เซอร์ ลองแบ่งไฟล์เป็นส่วนเล็กลง"
          : "อ่านไฟล์ไม่ได้ ลองเลือกไฟล์ใหม่อีกครั้ง",
      };
    }
    if (selected !== file) return; // ผู้ใช้เปลี่ยนไฟล์ระหว่างรอ
    button.disabled = false;
    if (!reply || !reply.ok) {
      if (reply && reply.crash) console.error("csv2vcf:", reply.error);
      const message = reply && !reply.crash && typeof reply.error === "string"
        ? forWeb(reply.error) : "เกิดข้อผิดพลาดภายใน กรุณาลองใหม่อีกครั้ง";
      setStatus(message, "error");
      return;
    }
    setStatus("");
    render(reply.result, selected.name);
  }

  // ---------------------------------------------------------------------------
  // แสดงผลลัพธ์
  // ---------------------------------------------------------------------------

  function render(data, sourceName) {
    const blob = new Blob([data.vcf], { type: "text/vcard;charset=utf-8" });
    downloadUrl = URL.createObjectURL(blob);
    download.href = downloadUrl;
    download.download = vcfName(sourceName);

    const parts = [data.contacts + " รายชื่อ"];
    if (data.skipped) parts.push("ข้าม " + data.skipped + " แถว");
    if (data.encoding === "cp874") parts.push("อ่านไฟล์เป็นภาษาไทย Windows (cp874)");
    $("summary").textContent = parts.join(" · ");

    const preview = $("preview");
    preview.replaceChildren();
    const contacts = parsePreview(data.vcf, PREVIEW_LIMIT);
    contacts.forEach((contact) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = contact.name || "(ไม่มีชื่อ)";
      item.append(name);
      if (contact.details.length) {
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = contact.details.join(" · ");
        item.append(detail);
      }
      preview.append(item);
    });
    const more = data.contacts - contacts.length;
    $("preview-more").textContent = more > 0 ? "และอีก " + more + " รายชื่อในไฟล์ที่ดาวน์โหลด" : "";

    const warningsBox = $("warnings-box");
    const list = $("warnings");
    list.replaceChildren();
    (data.warnings || []).forEach((warning) => {
      const item = document.createElement("li");
      item.textContent = "บรรทัด " + warning.line + ": " + warning.message;
      list.append(item);
    });
    const total = data.warnings_total || 0;
    warningsBox.hidden = total === 0;
    $("warnings-title").textContent =
      "คำเตือน " + total + " รายการ" + (total > list.children.length ? " (แสดง " + list.children.length + " รายการแรก)" : "");

    const ignored = $("ignored");
    const names = data.ignored_columns || [];
    ignored.hidden = names.length === 0;
    const extra = (data.ignored_columns_total || 0) - names.length;
    ignored.textContent = "คอลัมน์ที่ไม่ได้ใช้: " + names.join(", ") + (extra > 0 ? " และอีก " + extra + " คอลัมน์" : "");

    result.hidden = false;
    result.scrollIntoView({ behavior: "smooth", block: "start" });
    download.focus({ preventScroll: true });
  }

  // ชื่อไฟล์สำหรับแสดง/ดาวน์โหลด: ตัดอักขระควบคุม อักขระล่องหน และอักขระกลับทิศข้อความ
  // (ชื่ออย่าง "a" + U+202E + "exe.csv" แสดงเป็น "...vsc.exe" หลอกให้เข้าใจผิดว่าเป็นไฟล์โปรแกรม)
  function displayName(name) {
    return String(name || "").replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "");
  }

  // ชื่อไฟล์ผลลัพธ์: ตัดนามสกุลเดิม อักขระที่ใช้ในชื่อไฟล์ไม่ได้ และจุดนำหน้า (ไฟล์ซ่อน) จำกัดความยาว
  function vcfName(name) {
    const base = displayName(name).replace(/\.[^.]*$/, "").replace(/[<>:"|?*\\/]/g, "_")
      .replace(/^[\s.]+/, "").slice(0, 150).trim();
    return (base || "contacts") + ".vcf";
  }

  function unescapeText(value) {
    return value.replace(/\\([\\,;nN])/g, (_, ch) => (ch === "n" || ch === "N" ? " " : ch));
  }

  // อ่านชื่อ เบอร์ และอีเมลจากส่วนต้นของไฟล์ vCard เพื่อแสดงตัวอย่าง
  function parsePreview(vcf, limit) {
    const lines = vcf.slice(0, PREVIEW_SCAN_CHARS).replace(/\r\n[ \t]/g, "").split("\r\n");
    const contacts = [];
    let current = null;
    for (const line of lines) {
      if (line === "BEGIN:VCARD") {
        current = { name: "", details: [] };
      } else if (line === "END:VCARD" && current) {
        contacts.push(current);
        current = null;
        if (contacts.length >= limit) break;
      } else if (current) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const property = line.slice(0, colon).split(";")[0].toUpperCase();
        const value = line.slice(colon + 1);
        if (property === "FN") current.name = unescapeText(value);
        else if ((property === "TEL" || property === "EMAIL") && current.details.length < 3) {
          current.details.push(unescapeText(value));
        }
      }
    }
    return contacts;
  }
})();
