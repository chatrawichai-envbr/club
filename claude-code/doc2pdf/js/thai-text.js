/*
 * ThaiText — ทำให้ข้อความภาษาไทยที่ดึงจากไฟล์ PDF ถูกต้องตามมาตรฐาน Unicode (คำไม่เพี้ยนเมื่อนำไปใช้ใน Word)
 *
 *   ThaiText.normalize(text) → string
 *     1. อักขระ PUA U+F700–U+F71A ของฟอนต์ไทยรุ่นเก่า (Tahoma, Angsana, Cordia ฯลฯ ที่ใช้ตำแหน่งพิเศษแทนสระ/วรรณยุกต์
 *        ที่เลื่อนตำแหน่ง) → อักขระไทยมาตรฐาน
 *     2. นิคหิต (ํ) + วรรณยุกต์? + สระอา (า) หรือ วรรณยุกต์ + นิคหิต + สระอา → วรรณยุกต์ + สระอำ (ำ) เช่น "น้ำ"
 *     3. เครื่องหมายบนตัวอักษรเดียวกัน: สระบน/ล่าง (ั ิ ี ึ ื ็ ุ ู ฺ) ก่อนวรรณยุกต์/ทัณฑฆาต (่ ้ ๊ ๋ ์) — PDF บางไฟล์
 *        เก็บตามลำดับที่วาด (วรรณยุกต์ก่อนสระ) ทำให้ค้นหา/ตรวจคำผิดไม่ได้; ตัดเครื่องหมายซ้ำที่ติดกัน
 *     4. ตัดอักขระที่มองไม่เห็น (zero-width, soft hyphen, BOM) และแปลงเป็น NFC
 *   ThaiText.fixLegacy(line) → string
 *     ไฟล์ PDF รุ่นเก่าที่ฟอนต์ไทยใช้รหัส TIS-620/Windows-874 แต่ไม่ได้บอกว่าเป็นอักษรไทย (ไม่มี ToUnicode) —
 *     ข้อความที่ดึงได้กลายเป็นอักษรละติน เช่น "¡ÒÃ" (= "การ") แปลงกลับเป็นอักษรไทยเฉพาะบรรทัดที่เข้าเงื่อนไขทั้งหมด:
 *     ไม่มีอักษรไทยอยู่แล้ว, อักษรในช่วง U+00A1–U+00FB อย่างน้อย 4 ตัวและเป็นส่วนใหญ่ของตัวอักษรในบรรทัด,
 *     ผลที่ได้มีสระ/วรรณยุกต์ และสะกดได้ตามหลักการเขียนภาษาไทย (สระบน/ล่าง/วรรณยุกต์ตามหลังพยัญชนะ ฯลฯ)
 *     — ข้อความภาษาอื่น (เช่น "Été à la plage", "°C ±5 ¼") ไม่ถูกแปลง; ญ ที่ PDF.js ให้มาเป็น "-" แก้ตามหลักภาษา
 *   ThaiText.isThai(ch) / ThaiText.isMark(ch)
 */
(function () {
  'use strict';

  // Microsoft/Monotype Thai PUA → มาตรฐาน (ตำแหน่งที่ฟอนต์ใช้วาดสระ/วรรณยุกต์เลื่อนซ้าย/ต่ำ)
  var PUA = {
    '\uf700': 'ฐ', '\uf701': 'ิ', '\uf702': 'ี', '\uf703': 'ึ', '\uf704': 'ื',
    '\uf705': '่', '\uf706': '้', '\uf707': '๊', '\uf708': '๋', '\uf709': '์',
    '\uf70a': '่', '\uf70b': '้', '\uf70c': '๊', '\uf70d': '๋', '\uf70e': '์',
    '\uf70f': 'ญ', '\uf710': 'ั', '\uf711': 'ํ', '\uf712': '็', '\uf713': '่',
    '\uf714': '้', '\uf715': '๊', '\uf716': '๋', '\uf717': '์', '\uf718': 'ุ',
    '\uf719': 'ู', '\uf71a': 'ฺ'
  };
  var PUA_RE = /[\uf700-\uf71a]/g;
  var INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

  // ลำดับของเครื่องหมายบนตัวอักษรเดียวกัน: 0 = สระบน/ล่าง, 1 = วรรณยุกต์/ทัณฑฆาต/นิคหิต/ยามักการ
  var VOWEL_MARK = /[ัิ-ฺ็]/;
  var TONE_MARK = /[่-๎]/;
  var MARKS = /[ัิ-ฺ็-๎]/;

  function isThai(ch) { return ch >= '\u0e00' && ch <= '\u0e7f'; }
  function isMark(ch) { return MARKS.test(ch); }
  function rank(ch) { return VOWEL_MARK.test(ch) ? 0 : 1; }

  function orderMarks(text) {
    return text.replace(/[ัิ-ฺ็-๎]{2,}/g, function (run) {
      var marks = Array.from(run);
      // เรียงแบบคงลำดับเดิมในกลุ่มเดียวกัน (stable) แล้วตัดตัวซ้ำที่ติดกัน (PDF ที่วาดทับสองครั้ง)
      var sorted = marks.map(function (c, i) { return { c: c, i: i }; })
        .sort(function (a, b) { return rank(a.c) - rank(b.c) || a.i - b.i; }).map(function (x) { return x.c; });
      return sorted.filter(function (c, i) { return c !== sorted[i - 1]; }).join('');
    });
  }

  function normalize(text) {
    var s = String(text == null ? '' : text);
    s = s.replace(PUA_RE, function (c) { return PUA[c]; });
    s = s.replace(INVISIBLE, '');
    // สระอำที่เก็บแยกเป็นนิคหิต + สระอา (วรรณยุกต์อาจอยู่ก่อนหรือระหว่าง)
    s = s.replace(/ํ([่-๋]?)า/g, '$1ำ');
    s = s.replace(/([่-๋])ํา/g, '$1ำ');
    s = orderMarks(s);
    // สระอำที่ตามหลังวรรณยุกต์ถูกแล้ว; สระอำก่อนวรรณยุกต์ (ำ่) → วรรณยุกต์ก่อน
    s = s.replace(/ำ([่-๋])/g, '$1ำ');
    return s.normalize('NFC');
  }

  // TIS-620: ไบต์ 0xA1–0xDA, 0xDF–0xFB = U+0E01–U+0E3A, U+0E3F–U+0E5B
  var LEGACY = /[\u00A1-\u00DA\u00DF-\u00FB]/g;
  var CONSONANT = /[ก-ฮ]/;
  var LEADING = /[เ-ไ]/;               // สระหน้า: ต้องตามด้วยพยัญชนะ
  var VOWEL_OR_MARK = /[ะ-ฺเ-ๅ็-๎]/;

  /** สะกดได้ตามหลักการเขียนภาษาไทย (ตรวจอย่างหยาบ): เครื่องหมายบน/ล่างตามหลังพยัญชนะ สระหน้าตามด้วยพยัญชนะ */
  function plausibleThai(s) {
    var chars = Array.from(s), vowels = 0;
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      if (!isThai(c)) continue;
      if (VOWEL_OR_MARK.test(c)) vowels++;
      if (isMark(c)) {
        var prev = chars[i - 1] || '';
        if (!CONSONANT.test(prev) && !isMark(prev) && prev !== 'ฤ' && prev !== 'ฦ') return false;
      } else if (LEADING.test(c)) {
        if (!CONSONANT.test(chars[i + 1] || '')) return false;
      }
    }
    return vowels > 0;
  }

  function fixLegacy(line) {
    var s = String(line == null ? '' : line);
    if (/[\u0E00-\u0E7F]/.test(s)) return s;
    // PDF.js แปลง µ (0xB5 = ต) เป็นอักษรกรีก μ ด้วย NFKC — นับเป็นไบต์ 0xB5 เฉพาะเมื่อบรรทัดเข้าเงื่อนไขด้านล่าง
    var orig = s;
    s = s.replace(/\u03BC/g, '\u00B5');
    var hi = (s.match(LEGACY) || []).length;
    if (hi < 4) return orig;
    var letters = (s.match(/[A-Za-z\u00C0-\u024F]/g) || []).length; // รวมอักษรละตินมีเครื่องหมาย (ส่วนหนึ่งซ้ำกับ hi)
    var ascii = (s.match(/[A-Za-z]/g) || []).length;
    if (ascii * 2 > hi || hi < letters * 0.6) return orig;
    var out = s.replace(LEGACY, function (c) { return String.fromCharCode(0x0E00 + c.charCodeAt(0) - 0xA0); });
    // ญ (0xAD) ตรงกับ soft hyphen ของ Latin-1 ซึ่ง PDF.js แปลงเป็น "-" — ขีดที่อยู่หลังไม้หันอากาศ หรือตามด้วยสระ/วรรณยุกต์
    // เป็นขีดจริงไม่ได้ตามหลักภาษา (เช่น "ใหญ่" "บัญชี" "ญาติ") จึงเป็น ญ
    out = out.replace(/ั-|-(?=[ะ-ฺๅ็-๎])/g, function (m) { return m.charAt(0) === 'ั' ? 'ัญ' : 'ญ'; });
    return plausibleThai(out) ? out : orig;
  }

  window.ThaiText = { normalize: normalize, fixLegacy: fixLegacy, isThai: isThai, isMark: isMark };
})();
