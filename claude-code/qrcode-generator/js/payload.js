/*
 * QrPayload — สร้างข้อความที่ใส่ใน QR Code แต่ละประเภท (ไม่มีส่วนหน้าเว็บ เทสต์ได้ใน Node: tests/harness.js)
 *
 *   QrPayload.build(type, fields) → { data, error }
 *     type:   'url' | 'text' | 'wifi' | 'phone' | 'email' | 'promptpay'
 *     data:   ข้อความสำหรับ QR ('' = ยังไม่มีข้อมูลพอ)
 *     error:  ข้อความแจ้งผู้ใช้เมื่อข้อมูลผิด (null = ไม่มีปัญหา) — ถ้ามี error จะไม่สร้าง QR
 *   QrPayload.utf8Binary(text) → สตริงที่แต่ละตัวคือ 1 ไบต์ของ UTF-8 (qr-code-styling เข้ารหัสทีละไบต์แบบ Latin-1
 *     ถ้าส่งข้อความภาษาไทยตรง ๆ ตัวอักษรจะเพี้ยน)
 *   QrPayload.fitsQr(binary, level) → ข้อความจาก utf8Binary ใส่ใน QR ระดับแก้ข้อผิดพลาด level ('L'|'M'|'Q'|'H') ได้ไหม
 */
(function (root) {
  'use strict';

  var MAX_AMOUNT = 9999999999.99; // ช่องจำนวนเงินของพร้อมเพย์ (EMVCo tag 54) ยาวได้ไม่เกิน 13 ตัวอักษร
  // ความจุสูงสุดของ QR Code (รุ่น 40) ตามโหมดที่ qr-code-styling เลือกจากข้อความ ยาวเกินนี้ไลบรารีจะ throw
  var CAPACITY = {
    Numeric: { L: 7089, M: 5596, Q: 3993, H: 3057 },
    Alphanumeric: { L: 4296, M: 3391, Q: 2420, H: 1852 },
    Byte: { L: 2953, M: 2331, Q: 1663, H: 1273 }
  };

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function result(data, error) { return { data: error ? '' : data, error: error || null }; }

  function utf8Binary(text) {
    var bytes = new TextEncoder().encode(str(text)); // อักขระครึ่งตัว (lone surrogate) กลายเป็น U+FFFD ไม่ throw
    var out = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return out;
  }

  /** โหมดที่ qr-code-styling ใช้ (เงื่อนไขเดียวกับในไลบรารี): ตัวเลขล้วน / ตัวพิมพ์ใหญ่และสัญลักษณ์บางตัว / ไบต์ */
  function qrMode(binary) {
    if (/^[0-9]*$/.test(binary)) return 'Numeric';
    if (/^[0-9A-Z $%*+\-./:]*$/.test(binary)) return 'Alphanumeric';
    return 'Byte';
  }

  function fitsQr(binary, level) {
    var text = str(binary);
    var table = CAPACITY[qrMode(text)];
    return Object.prototype.hasOwnProperty.call(table, level) && text.length <= table[level];
  }

  /** เว็บไซต์: ไม่มี scheme (เช่น www.example.com) → เติม https:// ให้แอปสแกนเปิดเป็นลิงก์ได้ */
  function url(value) {
    var v = str(value).trim();
    if (!v) return result('');
    return result(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v);
  }

  /** WiFi (รูปแบบ WIFI: ของ ZXing): \ ; , : " ใน SSID/รหัสผ่านต้อง escape ด้วย backslash */
  function escapeWifi(value) {
    return str(value).replace(/[\\;,:"]/g, function (c) { return '\\' + c; });
  }

  function wifi(ssid, password, security) {
    var name = str(ssid);
    if (!name) return result('');
    var type = security === 'WEP' || security === 'nopass' ? security : 'WPA';
    // ไม่มีรหัสผ่าน: ไม่ใส่ P: (เดิมใส่รหัสที่พิมพ์ค้างไว้ไปด้วย แอปสแกนบางตัวเลยสับสน)
    var pass = type === 'nopass' ? '' : 'P:' + escapeWifi(password) + ';';
    return result('WIFI:S:' + escapeWifi(name) + ';T:' + type + ';' + pass + 'H:false;;');
  }

  /** เบอร์โทร: tel: ห้ามมีช่องว่าง (RFC 3966) เก็บเฉพาะตัวเลข + * # และขีด/จุด/วงเล็บที่ใช้แบ่งเลข */
  function phone(value) {
    var v = str(value).replace(/[^0-9+*#().-]/g, '');
    if (!/[0-9]/.test(v)) return result('', str(value).trim() ? 'เบอร์โทรต้องมีตัวเลข' : null);
    return result('tel:' + v);
  }

  /** อีเมล: encode ที่อยู่ด้วย ไม่งั้น ? หรือ & ในช่องอีเมลจะกลายเป็นหัวข้ออื่นของ mailto: */
  function email(to, subject) {
    var addr = str(to).trim();
    if (!addr) return result('');
    var out = 'mailto:' + encodeURIComponent(addr).replace(/%40/g, '@');
    var sub = str(subject).trim();
    return result(sub ? out + '?subject=' + encodeURIComponent(sub) : out);
  }

  /** CRC-16/CCITT-FALSE (poly 0x1021, เริ่ม 0xFFFF) ตามสเปก EMVCo — คืนเลขฐาน 16 ตัวใหญ่ 4 หลัก */
  function crc16(text) {
    var crc = 0xFFFF;
    for (var i = 0; i < text.length; i++) {
      crc ^= text.charCodeAt(i) << 8;
      for (var j = 0; j < 8; j++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
    }
    return ('000' + crc.toString(16).toUpperCase()).slice(-4);
  }

  function tlv(tag, value) { return tag + ('0' + value.length).slice(-2) + value; }

  /**
   * ผู้รับเงินพร้อมเพย์: เบอร์มือถือ 10 หลัก (หรือ 66 + 9 หลัก), เลขประจำตัวประชาชน/ผู้เสียภาษี 13 หลัก, e-Wallet 15 หลัก
   * เดิมรับทุกความยาวตั้งแต่ 10 หลัก เช่น 11/12/14 หลักถูกนับเป็นเบอร์โทร ได้ QR ที่โอนไปบัญชีผิด/ไม่มีอยู่จริง
   */
  function promptpayTarget(id) {
    var d = str(id).replace(/[^0-9]/g, '');
    if (d.length === 11 && d.slice(0, 2) === '66') d = '0' + d.slice(2); // ใส่รหัสประเทศ 66 มา
    if (d.length === 10 && d.charAt(0) === '0') return { tag: '01', value: '0066' + d.slice(1) };
    if (d.length === 13) return { tag: '02', value: d };
    if (d.length === 15) return { tag: '03', value: d };
    return null;
  }

  function promptpay(id, amount) {
    if (!str(id).trim()) return result('');
    var target = promptpayTarget(id);
    if (!target) {
      return result('', 'เลขพร้อมเพย์ไม่ถูกต้อง: ใช้เบอร์มือถือ 10 หลัก เลขบัตรประชาชน/ผู้เสียภาษี 13 หลัก หรือ e-Wallet 15 หลัก');
    }
    var amountText = str(amount).trim();
    var value = null;
    if (amountText) {
      // เฉพาะเลขฐานสิบ (Number() รับ 0x10 = 16 ด้วย)
      var n = /^[0-9.eE+]+$/.test(amountText) ? Number(amountText) : NaN;
      if (!isFinite(n) || n < 0 || n > MAX_AMOUNT) return result('', 'จำนวนเงินต้องอยู่ระหว่าง 0 ถึง 9,999,999,999.99 บาท');
      // ปัดเป็นสตางค์ก่อน: 0.001 ต้องเป็น "ผู้จ่ายกรอกเอง" ไม่ใช่ QR เรียกเก็บ 0.00 บาท
      var cents = Math.round(n * 100);
      if (cents > 0) value = (cents / 100).toFixed(2);
    }
    // Point of Initiation: 11 = ผู้จ่ายกรอกจำนวนเงินเอง, 12 = ระบุจำนวนเงินมาแล้ว
    var merchant = tlv('00', 'A000000677010111') + tlv(target.tag, target.value);
    var p = tlv('00', '01') + tlv('01', value ? '12' : '11') + tlv('29', merchant) + tlv('58', 'TH') + tlv('53', '764');
    if (value) p += tlv('54', value);
    p += '6304';
    return result(p + crc16(p));
  }

  function build(type, f) {
    f = f || {};
    switch (type) {
      case 'url': return url(f.url);
      case 'text': return result(str(f.text));
      case 'wifi': return wifi(f.ssid, f.password, f.security);
      case 'phone': return phone(f.phone);
      case 'email': return email(f.to, f.subject);
      case 'promptpay': return promptpay(f.id, f.amount);
      default: return result('');
    }
  }

  var api = {
    build: build, utf8Binary: utf8Binary, fitsQr: fitsQr, crc16: crc16, escapeWifi: escapeWifi, promptpayTarget: promptpayTarget
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QrPayload = api;
})(typeof self !== 'undefined' ? self : this);
