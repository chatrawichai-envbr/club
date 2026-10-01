"use strict";

// หน้าเว็บแปลงรายชื่อ CSV เป็น vCard
// ข้อความทุกอย่างที่มาจากไฟล์ของผู้ใช้หรือจากเซิร์ฟเวอร์ใส่ลงหน้าเว็บด้วย textContent เท่านั้น
// (ไม่ใช้ innerHTML) จึงแทรกสคริปต์ผ่านชื่อหรือข้อมูลในไฟล์ไม่ได้
(function () {
  const $ = (id) => document.getElementById(id);
  const page = $("page");
  // webapp.py แทน __MAX_MB__ ด้วยตัวเลขตอนส่งหน้านี้ ถ้ายังไม่ถูกแทนแสดงว่าเปิดไฟล์ตรง ๆ หรือผ่าน GitHub Pages
  // ซึ่งไม่มีเซิร์ฟเวอร์แปลงไฟล์ ห้ามส่งไฟล์รายชื่อออกไป ให้พาไปใช้เวอร์ชันที่แปลงในเบราว์เซอร์แทน
  const servedByWebapp = /^[0-9]{1,4}$/.test(page.dataset.maxMb || "");
  if (!servedByWebapp) {
    $("file").disabled = true;
    $("convert").disabled = true;
    $("drop-title").textContent = "หน้านี้แปลงไฟล์ไม่ได้";
    $("drop-hint").textContent = "ใช้เวอร์ชันที่แปลงในเบราว์เซอร์ตามลิงก์ด้านล่าง";
    $("standalone").hidden = false;
    return;
  }
  const maxMb = Number(page.dataset.maxMb) || 10;
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

  async function convert(selected) {
    clearResult();
    button.disabled = true;
    setStatus("กำลังแปลงไฟล์…", "busy");
    const params = new URLSearchParams();
    const countryCode = $("country-code").value.trim();
    if (countryCode) params.set("country_code", countryCode);
    params.set("date_order", $("date-order").value);
    params.set("encoding", $("encoding").value);
    if ($("delimiter").value) params.set("delimiter", $("delimiter").value);

    let response;
    try {
      response = await fetch("api/convert?" + params.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "csv2vcf" },
        body: selected,
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (error) {
      setStatus("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง", "error");
      button.disabled = false;
      return;
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    button.disabled = false;
    if (!data || !response.ok || !data.ok) {
      const fallback = response.status === 413 ? "ไฟล์ใหญ่เกินกว่าที่เซิร์ฟเวอร์รับได้" : "แปลงไฟล์ไม่สำเร็จ (รหัส " + response.status + ")";
      setStatus((data && typeof data.error === "string" && data.error) || fallback, "error");
      return;
    }
    if (selected !== file) return; // ผู้ใช้เปลี่ยนไฟล์ระหว่างรอ
    setStatus("");
    render(data, selected.name);
  }

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
