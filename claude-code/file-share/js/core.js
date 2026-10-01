/*
 * ShareCore — ฟังก์ชันล้วนของระบบฝากไฟล์ (ไม่ยุ่งกับหน้าเว็บ เทสต์ได้ใน Node: tests/harness.js)
 *
 *   PROVIDERS / provider(name)         ข้อมูลและขีดจำกัดของแต่ละที่ฝากไฟล์
 *   checkFile(file, provider)          ตรวจขนาดไฟล์ก่อนอัปโหลด → ข้อความแจ้งผู้ใช้ หรือ null
 *   driveName / oneDriveName / hostName ชื่อไฟล์ที่ปลอดภัยสำหรับแต่ละที่
 *   googleAuthUrl / microsoftAuthUrl   URL สำหรับเข้าสู่ระบบ (OAuth 2.0 แบบ redirect ไม่ใช้ไลบรารีภายนอก)
 *   randomToken / pkceChallenge        ค่าสุ่มสำหรับ state และ PKCE (RFC 7636)
 *   parseParams                        อ่านผลการเข้าสู่ระบบจาก #fragment
 *   safeLink                           ตรวจลิงก์จาก API ก่อนแสดง (https และโดเมนที่อนุญาตเท่านั้น)
 *   tmpfilesLinks / gofileLink         อ่านผลของเว็บฝากไฟล์ฟรี
 *   chunkRanges / nextRange            แบ่งไฟล์เป็นช่วงสำหรับ OneDrive upload session
 */
(function (root) {
  'use strict';

  var MiB = 1024 * 1024;

  // ขีดจำกัดของระบบนี้: ไฟล์ละไม่เกิน 100 MB — บางบริการจำกัดเข้มกว่า
  var PROVIDERS = {
    google: {
      label: 'Google Drive',
      maxBytes: 100 * MiB,
      links: ['drive.google.com', 'docs.google.com']
    },
    onedrive: {
      label: 'Microsoft OneDrive',
      maxBytes: 100 * MiB,
      links: ['1drv.ms', 'onedrive.live.com', '*.sharepoint.com', '*.onedrive.com', '*.microsoftpersonalcontent.com']
    },
    tmpfiles: {
      label: 'tmpfiles.org',
      maxBytes: 100 * 1000 * 1000, // บริการจำกัด 100 MB (ฐานสิบ)
      links: ['tmpfiles.org']
    },
    gofile: {
      label: 'Gofile.io',
      maxBytes: 100 * MiB,
      links: ['gofile.io']
    }
  };

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function provider(name) { return own(PROVIDERS, name) ? PROVIDERS[name] : null; }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    var num = function (x, d) { return x.toFixed(d).replace(/\.0+$/, ''); };
    if (v < MiB) return num(v / 1024, 1) + ' KB';
    if (v < 1024 * MiB) return num(v / MiB, 1) + ' MB';
    return num(v / (1024 * MiB), 2) + ' GB';
  }

  function checkFile(file, name) {
    var p = provider(name);
    if (!p) return 'ไม่รู้จักที่ฝากไฟล์';
    var size = Number(file && file.size);
    if (!(size > 0)) return 'ไฟล์ว่างเปล่า';
    if (size > p.maxBytes) return 'ไฟล์ใหญ่เกิน ' + formatBytes(p.maxBytes) + ' (ขนาด ' + formatBytes(size) + ')';
    return null;
  }

  // ---------------------------------------------------------------- ชื่อไฟล์

  // อักขระควบคุม อักขระล่องหน และอักขระกลับทิศข้อความ (ทำให้ชื่อไฟล์ที่เห็นไม่ตรงกับจริง เช่น ชื่อที่มีอักขระ U+202E)
  var HIDDEN = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

  function baseOf(name) {
    return str(name).replace(HIDDEN, '').split(/[\\/]/).pop();
  }

  /** ตัดชื่อให้ไม่เกิน max ตัวอักษร โดยคงนามสกุลไว้ */
  function limit(name, max) {
    if (name.length <= max) return name;
    var dot = name.lastIndexOf('.');
    var ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    return name.slice(0, max - ext.length) + ext;
  }

  function trimEdges(name) {
    var start = 0, end = name.length;
    while (start < end && /[\s.]/.test(name.charAt(start))) start++;
    while (end > start && /[\s.]/.test(name.charAt(end - 1))) end--;
    return name.slice(start, end);
  }

  /** ชื่อไฟล์สำหรับแสดงบนหน้าเว็บ: ตัดอักขระล่องหน/กลับทิศข้อความ (กันชื่อหลอกตา เช่น ไฟล์ .exe ที่ดูเหมือน .png) */
  function displayName(name) {
    return limit(baseOf(name), 200) || 'file';
  }

  /** Google Drive รับชื่อได้เกือบทุกแบบ — ตัดอักขระล่องหนและ path */
  function driveName(name) {
    var n = baseOf(name).trim();
    return limit(n, 250) || 'file';
  }

  /** OneDrive: ห้าม " * : < > ? / \ | ขึ้นต้น/ลงท้ายด้วยช่องว่างหรือจุด และชื่อสงวนของ Windows */
  function oneDriveName(name) {
    var n = trimEdges(baseOf(name).replace(/["*:<>?|]/g, '_'));
    if (!n) return 'file';
    var stem = n.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/.test(stem) || /^(desktop\.ini|\.lock)$/i.test(n) || n.indexOf('_vti_') >= 0) n = '_' + n;
    return limit(n, 200);
  }

  /** เว็บฝากไฟล์ฟรี: ตัวอักษร ตัวเลข และสัญลักษณ์ที่ปลอดภัยใน URL */
  function hostName(name) {
    var n = trimEdges(baseOf(name).replace(/["*:<>?|#%&{}$!'`@+=;,^~[\]]/g, '_'));
    return limit(n || 'file', 150);
  }

  // ---------------------------------------------------------------- OAuth

  function base64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/={1,2}$/, ''); // base64 มี = ท้ายไม่เกิน 2 ตัว (=+$ ช้าแบบกำลังสอง)
  }

  /** ค่าสุ่มสำหรับ state/PKCE verifier (32 ไบต์ → 43 ตัวอักษร base64url) */
  function randomToken(cryptoObj, bytes) {
    var b = new Uint8Array(bytes || 32);
    cryptoObj.getRandomValues(b);
    return base64url(b);
  }

  /** PKCE code_challenge = BASE64URL(SHA-256(verifier)) */
  function pkceChallenge(verifier, subtle) {
    var data = new TextEncoder().encode(str(verifier));
    return subtle.digest('SHA-256', data).then(function (hash) { return base64url(new Uint8Array(hash)); });
  }

  function query(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  var GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var MICROSOFT_SCOPE = 'Files.ReadWrite User.Read';

  /** Google OAuth 2.0 (implicit grant แบบ redirect) — ได้ access token ใน #fragment ไม่ผ่านเซิร์ฟเวอร์ใด */
  function googleAuthUrl(o) {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + query({
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      response_type: 'token',
      scope: GOOGLE_SCOPE,
      include_granted_scopes: 'false',
      state: o.state,
      prompt: 'select_account'
    });
  }

  /** Microsoft identity platform (authorization code + PKCE สำหรับ SPA ไม่ต้องใช้ client secret) */
  function microsoftAuthUrl(o) {
    return 'https://login.microsoftonline.com/' + authority(o.authority) + '/oauth2/v2.0/authorize?' + query({
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      response_type: 'code',
      response_mode: 'fragment',
      scope: MICROSOFT_SCOPE,
      state: o.state,
      code_challenge: o.challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    });
  }

  function microsoftTokenUrl(a) {
    return 'https://login.microsoftonline.com/' + authority(a) + '/oauth2/v2.0/token';
  }

  /** authority ที่อนุญาต: common, consumers, organizations หรือ tenant ID (GUID) — กันการแทรก path อื่น */
  function authority(a) {
    var s = str(a).trim().toLowerCase();
    if (s === 'common' || s === 'consumers' || s === 'organizations') return s;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return s;
    return 'common';
  }

  /** ข้อความบอกผู้ใช้ว่าบัญชี Microsoft แบบไหนเข้าสู่ระบบได้ (ขึ้นกับ authority ที่ตั้งตามการลงทะเบียนแอป) */
  function msAccountsNote(a) {
    var s = authority(a);
    if (s === 'consumers') return 'ใช้ได้เฉพาะบัญชี Microsoft ส่วนตัว (Outlook.com, Hotmail, Live) — บัญชีองค์กร/โรงเรียน (Microsoft 365) ใช้ไม่ได้';
    var org = 'ผู้ดูแลขององค์กรอาจต้องอนุญาตแอปก่อน และอาจปิดลิงก์แชร์แบบไม่ต้องเข้าสู่ระบบ';
    if (s === 'common') return 'ใช้ได้ทั้งบัญชีส่วนตัว (Outlook/Hotmail) และบัญชีองค์กร/โรงเรียน — ' + org;
    return 'ใช้ได้เฉพาะบัญชีองค์กร/โรงเรียน (Microsoft 365) — ' + org;
  }

  // รหัส error ของ Microsoft ที่เกิดจากการตั้งค่าแอปผิด → คำแนะนำภาษาไทย (วิธีแก้อยู่ในตารางของ README.md)
  var AUTH_HINTS = [
    [['AADSTS70002', 'AADSTS7000218', 'AADSTS9002326'],
      'ผู้ดูแลระบบลงทะเบียน redirect URI ของแอป Microsoft เป็นแพลตฟอร์ม Web ต้องย้ายไปเป็น Single-page application (ระบบนี้ไม่ใช้ Client Secret)'],
    [['AADSTS9002331', 'AADSTS50194'], 'ประเภทบัญชีของแอป Microsoft ไม่ตรงกับ microsoftAuthority ใน js/config.js'],
    [['AADSTS50011'], 'ผู้ดูแลระบบยังไม่ได้ลงทะเบียน redirect URI ของหน้านี้กับแอป Microsoft'],
    [['AADSTS65001'], 'ยังไม่ได้อนุญาตสิทธิ์ให้แอป ลองเข้าสู่ระบบใหม่แล้วกดยอมรับ']
  ];

  /**
   * ข้อความแจ้งผู้ใช้เมื่อเข้าสู่ระบบไม่สำเร็จ (error/error_description มาจากเซิร์ฟเวอร์ ไม่น่าเชื่อถือ — แสดงด้วย textContent)
   * ตัด Trace ID / Correlation ID / Timestamp ที่ยาวออก จำกัดความยาว และเติมคำแนะนำของรหัสที่รู้จัก
   */
  function authErrorText(error, description) {
    var err = str(error).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60) || 'error';
    var d = str(description).replace(/\s+/g, ' ');
    var cut = d.indexOf(' Trace ID:');
    if (cut >= 0) d = d.slice(0, cut);
    d = d.trim().slice(0, 200);
    var code = (/AADSTS[0-9]{4,9}/.exec(d) || [''])[0];
    for (var i = 0; code && i < AUTH_HINTS.length; i++) {
      if (AUTH_HINTS[i][0].indexOf(code) >= 0) return 'เข้าสู่ระบบไม่สำเร็จ: ' + AUTH_HINTS[i][1] + ' (' + code + ')';
    }
    return 'เข้าสู่ระบบไม่สำเร็จ (' + err + ')' + (d ? ': ' + d : '');
  }

  /** Client ID ที่ดูถูกต้อง (กันการตั้งค่าผิดจนส่งค่าแปลกไปหน้าเข้าสู่ระบบ) */
  function validClientId(kind, id) {
    var s = str(id).trim();
    if (kind === 'google') return /^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/.test(s) ? s : '';
    if (kind === 'microsoft') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : '';
    return '';
  }

  /** "a=1&b=2" (จาก #fragment หรือ ?query ที่ตัดเครื่องหมายนำหน้าแล้ว) → object ที่ไม่มี prototype */
  function parseParams(s) {
    var out = Object.create(null);
    str(s).replace(/^[#?]/, '').split('&').slice(0, 50).forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = i < 0 ? pair : pair.slice(0, i);
      var v = i < 0 ? '' : pair.slice(i + 1);
      try {
        k = decodeURIComponent(k.replace(/\+/g, ' '));
        v = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (e) { return; }
      if (k && k.length <= 64 && v.length <= 8192 && !(k in out)) out[k] = v;
    });
    return out;
  }

  // ---------------------------------------------------------------- ผลลัพธ์จาก API

  function hostAllowed(host, allowed) {
    return allowed.some(function (a) {
      if (a.charAt(0) === '*') {
        var suffix = a.slice(1); // ".sharepoint.com"
        return host.length > suffix.length && host.slice(-suffix.length) === suffix;
      }
      return host === a;
    });
  }

  /** ลิงก์ที่ได้จาก API: ต้องเป็น https และอยู่ในโดเมนที่อนุญาต ไม่งั้นคืน null (กัน javascript: หรือหน้าหลอก) */
  function safeLink(url, allowed) {
    var u;
    try { u = new URL(str(url)); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!hostAllowed(u.hostname.toLowerCase(), allowed || [])) return null;
    return u.href;
  }

  /**
   * tmpfiles.org: {status:'success', data:{url:'https://tmpfiles.org/<รหัส>/a.png'}} → หน้าไฟล์และลิงก์ดาวน์โหลดตรง (/dl/<รหัส>/a.png)
   * รหัสเดิมเป็นตัวเลขล้วน (/123/) ตอนนี้เป็นตัวอักษรผสม (/wsARwlEoEnhy/) — รับทั้งสองแบบ
   */
  function tmpfilesLinks(json) {
    var url = json && json.status === 'success' && json.data ? json.data.url : null;
    var page = safeLink(str(url).replace(/^http:\/\//i, 'https://'), PROVIDERS.tmpfiles.links);
    if (!page) return null;
    var u = new URL(page);
    if (!/^\/[A-Za-z0-9_-]{1,64}\/[^/]+$/.test(u.pathname) || /^\/dl\//i.test(u.pathname)) return { page: page, direct: page };
    u.pathname = '/dl' + u.pathname;
    return { page: page, direct: u.href };
  }

  /** Gofile: {status:'ok', data:{downloadPage:'https://gofile.io/d/abc'}} → ลิงก์หน้าดาวน์โหลด */
  function gofileLink(json) {
    var url = json && json.status === 'ok' && json.data ? json.data.downloadPage : null;
    return safeLink(url, PROVIDERS.gofile.links);
  }

  /** ช่วงไบต์สำหรับ OneDrive upload session (ขนาดต้องเป็นพหุคูณของ 320 KiB) → [[start, endInclusive], ...] */
  function chunkRanges(total, chunk) {
    var out = [];
    for (var s = 0; s < total; s += chunk) out.push([s, Math.min(total, s + chunk) - 1]);
    return out;
  }

  /** {nextExpectedRanges: ["26214400-"]} → 26214400 (ส่งต่อจากตรงนี้) หรือ -1 */
  function nextRange(json) {
    var r = json && Array.isArray(json.nextExpectedRanges) ? str(json.nextExpectedRanges[0]) : '';
    var m = /^([0-9]{1,15})-/.exec(r);
    return m ? Number(m[1]) : -1;
  }

  var api = {
    MiB: MiB,
    PROVIDERS: PROVIDERS,
    GOOGLE_SCOPE: GOOGLE_SCOPE,
    MICROSOFT_SCOPE: MICROSOFT_SCOPE,
    provider: provider,
    formatBytes: formatBytes,
    checkFile: checkFile,
    displayName: displayName,
    driveName: driveName,
    oneDriveName: oneDriveName,
    hostName: hostName,
    base64url: base64url,
    randomToken: randomToken,
    pkceChallenge: pkceChallenge,
    googleAuthUrl: googleAuthUrl,
    microsoftAuthUrl: microsoftAuthUrl,
    microsoftTokenUrl: microsoftTokenUrl,
    authority: authority,
    msAccountsNote: msAccountsNote,
    authErrorText: authErrorText,
    validClientId: validClientId,
    parseParams: parseParams,
    safeLink: safeLink,
    tmpfilesLinks: tmpfilesLinks,
    gofileLink: gofileLink,
    chunkRanges: chunkRanges,
    nextRange: nextRange
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShareCore = api;
})(typeof self !== 'undefined' ? self : this);
