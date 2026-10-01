/*
 * Docx — สร้างไฟล์ Microsoft Word (.docx, Office Open XML) จากข้อความ ในเครื่องทั้งหมด (ใช้ js/zip.js)
 *
 *   Docx.create({ title, pages, font, size }) → Promise<Blob>
 *     pages: [ [ย่อหน้า, ...], ... ]   หน้า → ย่อหน้า; ย่อหน้า = [บรรทัด, ...] หรือ { lines: [บรรทัด, ...], scale }
 *            (คงบรรทัดตามต้นฉบับด้วย <w:br/>, แท็บ \t → <w:tab/>, scale = ขนาดตัวอักษรเทียบกับ size เช่น หัวเรื่อง 1.5)
 *     font:  ฟอนต์ (ค่าเริ่มต้น TH Sarabun New — ใช้กับอักษรไทยและละตินใน Word), size: ขนาดตัวอักษร (pt, ค่าเริ่มต้น 16)
 *   Docx.MIME
 *
 * ภาษาไทยใน Word: ตั้งฟอนต์ complex script (w:cs) + ขนาด szCs และภาษา th-TH ให้ Word ตัดคำ/ตรวจคำภาษาไทยได้ถูก
 * ข้อความทุกตัวผ่าน xml() (escape + ตัดอักขระที่ XML ไม่อนุญาต) — ไม่มีการแทรก XML จากข้อมูลผู้ใช้
 */
(function () {
  'use strict';

  var MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  function xml(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\ufffe\uffff]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function halfPoints(pt) { return String(Math.round(pt * 2)); }

  /** บรรทัด → runs: ข้อความ, แท็บ (<w:tab/>), ขึ้นบรรทัดภายในย่อหน้า (<w:br/>) */
  function paragraph(para, size) {
    var lines = Array.isArray(para) ? para : para && Array.isArray(para.lines) ? para.lines : [];
    var scale = para && !Array.isArray(para) ? Number(para.scale) : 1;
    var rPr = '';
    if (isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 0.01) {
      var hp = halfPoints(Math.min(72, Math.max(6, size * scale)));
      rPr = '<w:rPr><w:sz w:val="' + hp + '"/><w:szCs w:val="' + hp + '"/></w:rPr>';
    }
    var parts = [];
    lines.forEach(function (line, i) {
      if (i) parts.push('<w:br/>');
      String(line).split('\t').forEach(function (seg, j) {
        if (j) parts.push('<w:tab/>');
        if (seg) parts.push('<w:t xml:space="preserve">' + xml(seg) + '</w:t>');
      });
    });
    return '<w:p><w:r>' + rPr + parts.join('') + '</w:r></w:p>';
  }

  function documentXml(pages, size) {
    var body = [];
    pages.forEach(function (paras, p) {
      if (p) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      if (!paras.length) body.push('<w:p/>');
      paras.forEach(function (para) { body.push(paragraph(para, size)); });
    });
    // A4, ขอบ 2.54 ซม.
    body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" ' +
      'w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>');
    return HEAD + '<w:document xmlns:w="' + W + '"><w:body>' + body.join('') + '</w:body></w:document>';
  }

  function stylesXml(font, size) {
    var f = xml(font), half = halfPoints(size);
    return HEAD + '<w:styles xmlns:w="' + W + '">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + f + '" w:hAnsi="' + f + '" w:eastAsia="' + f + '" w:cs="' + f + '"/>' +
      '<w:sz w:val="' + half + '"/><w:szCs w:val="' + half + '"/>' +
      '<w:lang w:val="th-TH" w:eastAsia="th-TH" w:bidi="th-TH"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '</w:styles>';
  }

  function coreXml(title) {
    return HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + xml(title) + '</dc:title><dc:language>th-TH</dc:language>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</dcterms:created>' +
      '</cp:coreProperties>';
  }

  var CONTENT_TYPES = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  var RELS = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  var DOC_RELS = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  var APP = HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
    '<Application>สแกนเอกสาร PDF</Application></Properties>';

  function create(opts) {
    opts = opts || {};
    var pages = Array.isArray(opts.pages) ? opts.pages : [];
    var font = String(opts.font || 'TH Sarabun New').slice(0, 64);
    var size = Math.min(72, Math.max(6, Number(opts.size) || 16));
    return window.Zip.create([
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: RELS },
      { name: 'docProps/core.xml', data: coreXml(opts.title || '') },
      { name: 'docProps/app.xml', data: APP },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/styles.xml', data: stylesXml(font, size) },
      { name: 'word/document.xml', data: documentXml(pages, size) }
    ], { type: MIME, compress: true });
  }

  window.Docx = { create: create, MIME: MIME, xml: xml };
})();
