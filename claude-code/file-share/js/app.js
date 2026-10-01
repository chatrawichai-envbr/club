/*
 * หน้าฝากไฟล์: เลือกที่ฝาก → เข้าสู่ระบบ (Google/Microsoft แบบ redirect) → อัปโหลดทีละไฟล์ → ลิงก์แชร์
 *
 * ความปลอดภัยของการเข้าสู่ระบบ:
 * - access token อยู่ในหน่วยความจำเท่านั้น (ไม่บันทึกลง storage ที่ทุกแอปใต้ envburiramclub.github.io อ่านร่วมกันได้)
 * - ระหว่างไปหน้าเข้าสู่ระบบ เก็บเฉพาะ state/PKCE verifier ใน sessionStorage (ลบทันทีที่กลับมา อายุไม่เกิน 10 นาที)
 * - ตรวจ state ทุกครั้ง (กันการปลอมผลการเข้าสู่ระบบ) และลบโทเคน/code ออกจาก URL ทันที
 */
(function () {
  'use strict';

  var C = window.ShareCore;
  var P = window.ShareProviders;
  var CFG = window.FILE_SHARE_CONFIG || {};

  var AUTH_KEY = 'file-share:auth';
  var PROVIDER_KEY = 'file-share:provider';
  var AUTH_TTL = 10 * 60 * 1000;
  var CHOICES = ['google', 'onedrive', 'free'];
  var LOGIN_LABEL = { google: 'เข้าสู่ระบบด้วย Google (Gmail)', onedrive: 'เข้าสู่ระบบด้วย Microsoft (Outlook/Hotmail)' };
  var README = 'https://github.com/envburiramclub/claude-code/blob/main/file-share/README.md';

  var GOOGLE_ID = C && C.validClientId('google', CFG.googleClientId);
  var MS_ID = C && C.validClientId('microsoft', CFG.microsoftClientId);
  var MS_AUTHORITY = C && C.authority(CFG.microsoftAuthority);

  var S = {
    choice: null,
    sessions: { google: null, onedrive: null },  // { token, expires, account }
    queue: [],
    running: false
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function toast(message, kind) {
    var box = $('toasts');
    while (box.children.length >= 3) box.firstChild.remove();
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'error' ? 7000 : 3500);
  }

  function errorText(e) {
    return String((e && (e.userMessage || e.message)) || e || 'เกิดข้อผิดพลาด').slice(0, 300);
  }

  function redirectUri() {
    // ต้องตรงกับที่ลงทะเบียนไว้กับ Google/Microsoft ทุกตัวอักษร (ไม่มี ?query หรือ #fragment)
    var u = new URL('index.html', location.href);
    return u.origin + u.pathname;
  }

  function configured(kind) { return kind === 'google' ? !!GOOGLE_ID : kind === 'onedrive' ? !!MS_ID : true; }

  function session(kind) {
    var s = S.sessions[kind];
    if (s && s.expires - 30000 > Date.now()) return s;
    if (s) S.sessions[kind] = null; // หมดอายุ
    return null;
  }

  function target() {
    if (S.choice !== 'free') return S.choice;
    var r = document.querySelector('input[name="host"]:checked');
    return r && (r.value === 'gofile' || r.value === 'tmpfiles') ? r.value : 'tmpfiles';
  }

  // ---------------------------------------------------------------- หน้าจอ

  function render() {
    var choice = S.choice;
    Array.prototype.forEach.call(document.querySelectorAll('.provider'), function (b) {
      var on = b.getAttribute('data-provider') === choice;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
    });
    CHOICES.forEach(function (c) { $('limits-' + c).hidden = c !== choice; });
    $('ms-accounts').textContent = C.msAccountsNote(MS_AUTHORITY);
    var needsLogin = choice === 'google' || choice === 'onedrive';
    var s = needsLogin ? session(choice) : null;
    $('account-card').hidden = !needsLogin;
    if (needsLogin) {
      var ok = configured(choice);
      var notice = $('not-configured');
      notice.hidden = ok;
      notice.replaceChildren();
      if (!ok) {
        notice.appendChild(document.createTextNode('ผู้ดูแลระบบยังไม่ได้ใส่ ' + (choice === 'google' ? 'Google OAuth Client ID' : 'Microsoft Application (client) ID') +
          ' ใน file-share/js/config.js จึงยังใช้ ' + C.provider(choice).label + ' ไม่ได้ — ใช้เว็บฝากไฟล์ฟรีไปก่อนได้ '));
        var a = el('a', null, 'วิธีตั้งค่า');
        a.href = README;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        notice.appendChild(a);
      }
      $('signed-out').hidden = !ok || !!s;
      $('btn-login').textContent = LOGIN_LABEL[choice];
      $('ms-login-hint').hidden = choice !== 'onedrive';
      $('signed-in').hidden = !s;
      if (s) renderAccount(s);
    }
    var ready = choice === 'free' || !!s;
    $('upload-card').hidden = !choice || !ready;
    $('step3-num').textContent = needsLogin ? '3' : '2';
    $('share-row').hidden = !needsLogin;
    var max = choice ? C.provider(target()).maxBytes : C.PROVIDERS.google.maxBytes;
    $('max-size').textContent = C.formatBytes(max);
    $('files-card').hidden = !(needsLogin && s);
  }

  function renderAccount(s) {
    var a = s.account || {};
    $('account-name').textContent = a.name || 'เข้าสู่ระบบแล้ว';
    $('account-email').textContent = a.email ? '(' + a.email + ')' : '';
    $('account-quota').textContent = a.total ? 'ใช้พื้นที่ไป ' + C.formatBytes(a.used) + ' จาก ' + C.formatBytes(a.total) +
      ' (ว่าง ' + C.formatBytes(Math.max(0, a.total - a.used)) + ')' : '';
    var t = new Date(s.expires);
    $('account-expiry').textContent = 'การเข้าสู่ระบบใช้ได้ถึง ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ' น.';
  }

  function choose(choice) {
    if (CHOICES.indexOf(choice) < 0) return;
    S.choice = choice;
    try { localStorage.setItem(PROVIDER_KEY, choice); } catch (e) { /* ignore */ }
    render();
    if ((choice === 'google' || choice === 'onedrive') && session(choice)) refreshFiles();
  }

  // ---------------------------------------------------------------- เข้าสู่ระบบ

  async function login(kind) {
    if (!configured(kind)) return;
    try {
      var state = C.randomToken(crypto, 32);
      var verifier = kind === 'onedrive' ? C.randomToken(crypto, 48) : '';
      var url = kind === 'google'
        ? C.googleAuthUrl({ clientId: GOOGLE_ID, redirectUri: redirectUri(), state: state })
        : C.microsoftAuthUrl({ clientId: MS_ID, authority: MS_AUTHORITY, redirectUri: redirectUri(), state: state, challenge: await C.pkceChallenge(verifier, crypto.subtle) });
      sessionStorage.setItem(AUTH_KEY, JSON.stringify({ provider: kind, state: state, verifier: verifier, time: Date.now() }));
      location.assign(url);
    } catch (e) {
      toast('เริ่มเข้าสู่ระบบไม่ได้: ' + errorText(e) + ' (เบราว์เซอร์อาจปิดการเก็บข้อมูลชั่วคราว)', 'error');
    }
  }

  function takePending() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(AUTH_KEY);
      sessionStorage.removeItem(AUTH_KEY);
    } catch (e) { return null; }
    var p = null;
    try { p = JSON.parse(raw); } catch (e) { return null; }
    if (!p || typeof p !== 'object') return null;
    var own = function (k) { return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : null; };
    var provider = own('provider'), state = own('state'), verifier = own('verifier'), time = Number(own('time'));
    if ((provider !== 'google' && provider !== 'onedrive') || typeof state !== 'string' || !(time > 0)) return null;
    if (Date.now() - time > AUTH_TTL || Date.now() < time) return null;
    return { provider: provider, state: state, verifier: typeof verifier === 'string' ? verifier : '' };
  }

  function authMessage(params) {
    var err = params.error;
    if (err === 'access_denied') return 'คุณยกเลิกการเข้าสู่ระบบ หรือไม่อนุญาตให้ระบบเข้าถึงไฟล์';
    return C.authErrorText(err, params.error_description);
  }

  /** กลับมาจากหน้าเข้าสู่ระบบ: อ่านผลจาก #fragment ตรวจ state แล้วลบออกจาก URL ทันที */
  async function handleRedirect() {
    var hash = location.hash;
    if (!hash || hash.length < 2) return;
    var params = C.parseParams(hash);
    if (!params.state && !params.access_token && !params.code && !params.error) return;
    history.replaceState(null, '', location.pathname + location.search);
    var pending = takePending();
    if (!pending || pending.state !== params.state) {
      toast('ผลการเข้าสู่ระบบไม่ถูกต้องหรือหมดเวลา กรุณาเข้าสู่ระบบใหม่', 'error');
      return;
    }
    var kind = pending.provider;
    S.choice = kind;
    if (params.error) { render(); toast(authMessage(params), 'error'); return; }
    try {
      var token, expiresIn;
      if (kind === 'google') {
        // ผู้ใช้เอาเครื่องหมายอนุญาตสิทธิ์ Drive ออกได้ในหน้ายินยอม — ต้องตรวจว่าได้สิทธิ์จริง
        if (params.scope && String(params.scope).split(' ').indexOf(C.GOOGLE_SCOPE) < 0) throw new Error('ไม่ได้อนุญาตให้ระบบเข้าถึง Google Drive (ต้องติ๊กอนุญาตในหน้ายินยอม)');
        token = params.access_token;
        expiresIn = Number(params.expires_in);
      } else {
        if (!params.code) throw new Error('ไม่ได้รับรหัสยืนยันจาก Microsoft');
        var res = await fetch(C.microsoftTokenUrl(MS_AUTHORITY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: [
            'client_id=' + encodeURIComponent(MS_ID),
            'grant_type=authorization_code',
            'code=' + encodeURIComponent(params.code),
            'redirect_uri=' + encodeURIComponent(redirectUri()),
            'code_verifier=' + encodeURIComponent(pending.verifier),
            'scope=' + encodeURIComponent(C.MICROSOFT_SCOPE)
          ].join('&'),
          credentials: 'omit'
        });
        var json = await res.json().catch(function () { return null; });
        if (!res.ok || !json || !json.access_token) throw new Error(json && json.error ? authMessage(json) : 'แลกรหัสเข้าสู่ระบบไม่สำเร็จ (HTTP ' + res.status + ')');
        token = json.access_token;
        expiresIn = Number(json.expires_in);
      }
      if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{10,16384}$/.test(token)) throw new Error('ได้โทเคนที่ไม่ถูกต้อง');
      var life = expiresIn > 0 ? Math.min(expiresIn, 3600) : 3600;
      S.sessions[kind] = { token: token, expires: Date.now() + life * 1000, account: null };
      try { localStorage.setItem(PROVIDER_KEY, kind); } catch (e) { /* ignore */ }
      render();
      toast('เข้าสู่ระบบ ' + C.provider(kind).label + ' แล้ว', 'ok');
      loadAccount(kind);
      refreshFiles();
    } catch (e) {
      render();
      toast(errorText(e), 'error');
    }
  }

  function loadAccount(kind) {
    var s = session(kind);
    if (!s) return;
    P[kind].account(s).then(function (a) {
      s.account = a;
      if (S.choice === kind) render();
    }, function (e) { handleAuthError(kind, e, s); });
  }

  function logout() {
    var kind = S.choice;
    var s = S.sessions[kind];
    if (kind !== 'google' && kind !== 'onedrive') return;
    S.sessions[kind] = null;
    S.queue.forEach(function (x) { if (x.session && x.session === s) cancelEntry(x); });
    if (s && kind === 'google') P.google.revoke(s);
    render();
    toast('ออกจากระบบแล้ว');
  }

  /** โทเคนหมดอายุ/ถูกยกเลิก → ออกจากระบบ (เฉพาะเมื่อข้อผิดพลาดมาจาก session ปัจจุบัน ไม่ใช่ session เก่าที่ค้างในคิว) */
  function handleAuthError(kind, e, s) {
    if (e && e.auth) {
      if (s && S.sessions[kind] !== s) return true;
      S.sessions[kind] = null;
      render();
      toast('การเข้าสู่ระบบ ' + C.provider(kind).label + ' หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'error');
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- อัปโหลด

  function copyLink(url) {
    var done = function () { toast('คัดลอกลิงก์แล้ว', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { toast('คัดลอกไม่ได้ กดค้างที่ลิงก์เพื่อคัดลอกเอง', 'error'); });
    } else toast('คัดลอกไม่ได้ กดค้างที่ลิงก์เพื่อคัดลอกเอง', 'error');
  }

  function linkRow(url, label) {
    var row = el('div', 'links');
    var a = el('a', 'link', label || url);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    var copy = el('button', 'btn btn-small', 'คัดลอก');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyLink(url); });
    row.appendChild(a);
    row.appendChild(copy);
    return row;
  }

  function renderEntry(entry) {
    var li = entry.node;
    li.replaceChildren();
    li.className = 'q-item ' + entry.status;
    var head = el('div', 'q-head');
    head.appendChild(el('span', 'q-name', C.displayName(entry.file.name)));
    head.appendChild(el('span', 'q-size muted', C.formatBytes(entry.file.size) + ' → ' + C.provider(entry.target).label));
    li.appendChild(head);
    if (entry.status === 'uploading' || entry.status === 'waiting') {
      var bar = el('progress');
      bar.max = 100;
      if (entry.status === 'uploading') bar.value = Math.round(entry.loaded * 100 / Math.max(1, entry.file.size));
      entry.bar = bar;
      li.appendChild(bar);
      entry.text = el('p', 'q-status small', entry.status === 'waiting' ? 'รอคิว' : 'กำลังอัปโหลด...');
      li.appendChild(entry.text);
      var cancel = el('button', 'btn btn-small', 'ยกเลิก');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { cancelEntry(entry); });
      li.appendChild(cancel);
    } else if (entry.status === 'done') {
      var r = entry.result;
      li.appendChild(el('p', 'q-status small ok', r.shared ? 'ฝากไฟล์เรียบร้อย — ทุกคนที่มีลิงก์ดาวน์โหลดได้' : 'ฝากไฟล์เรียบร้อย — ลิงก์นี้เปิดได้เฉพาะคุณ'));
      if (r.link) li.appendChild(linkRow(r.link));
      if (r.direct && r.direct !== r.link) li.appendChild(linkRow(r.direct, 'ลิงก์ดาวน์โหลดตรง: ' + r.direct));
      if (r.warning) li.appendChild(el('p', 'q-status small warn', r.warning));
    } else {
      li.appendChild(el('p', 'q-status small err', entry.message || 'ไม่สำเร็จ'));
    }
  }

  function cancelEntry(entry) {
    if (entry.status === 'waiting') { entry.status = 'cancelled'; entry.message = 'ยกเลิกแล้ว'; renderEntry(entry); return; }
    if (entry.status !== 'uploading') return;
    var c = entry.control;
    c.cancelled = true;
    if (c.abort) c.abort();
    if (c.onCancel) c.onCancel();
  }

  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []).filter(Boolean);
    if (!files.length) return;
    var tgt = target();
    var s = tgt === 'google' || tgt === 'onedrive' ? session(tgt) : null;
    if ((tgt === 'google' || tgt === 'onedrive') && !s) { render(); toast('กรุณาเข้าสู่ระบบก่อน', 'error'); return; }
    // ใช้พื้นที่เกินโควตาอยู่แล้ว (used > total) → ว่าง 0 ไม่ใช่ติดลบ
    var free = s && s.account && s.account.total ? Math.max(0, s.account.total - s.account.used) : Infinity;
    files.slice(0, 50).forEach(function (file) {
      var entry = { file: file, target: tgt, session: s, share: $('share').checked, status: 'waiting', loaded: 0, control: {}, node: el('li') };
      var err = C.checkFile(file, tgt);
      if (!err && file.size > free) err = 'พื้นที่ว่างใน ' + C.provider(tgt).label + ' ไม่พอ (ว่าง ' + C.formatBytes(free) + ')';
      if (err) { entry.status = 'error'; entry.message = err; }
      else free -= file.size;
      S.queue.push(entry);
      $('queue').insertBefore(entry.node, $('queue').firstChild);
      renderEntry(entry);
    });
    if (files.length > 50) toast('เลือกได้ครั้งละไม่เกิน 50 ไฟล์', 'error');
    run();
  }

  /**
   * ไฟล์จากการลากวาง — ข้ามโฟลเดอร์ (เบราว์เซอร์ให้มาเป็น File ที่อ่านไม่ได้ อัปโหลดแล้วขึ้นว่าเชื่อมต่อไม่ได้ ผิดสาเหตุ)
   * ต้องเรียกระหว่าง event drop เท่านั้น (หลังจากนั้น dataTransfer อ่านไม่ได้แล้ว)
   */
  function droppedFiles(dt) {
    var items = dt.items;
    if (!items || !items.length || typeof items[0].webkitGetAsEntry !== 'function') return Array.prototype.slice.call(dt.files || []);
    var files = [], folders = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      var entry = items[i].webkitGetAsEntry();
      if (entry && entry.isDirectory) { folders++; continue; }
      var f = items[i].getAsFile();
      if (f) files.push(f);
    }
    if (folders) toast('ฝากทั้งโฟลเดอร์ไม่ได้ (' + folders + ' โฟลเดอร์) — เลือกไฟล์ในโฟลเดอร์แทน หรือบีบอัดเป็น .zip ก่อน', 'error');
    return files;
  }

  async function run() {
    if (S.running) return;
    S.running = true;
    try {
      for (;;) {
        var entry = S.queue.filter(function (e) { return e.status === 'waiting'; })[0];
        if (!entry) break;
        if (entry.session && (S.sessions[entry.target] !== entry.session || !session(entry.target))) {
          entry.status = 'error';
          entry.message = 'ออกจากระบบหรือการเข้าสู่ระบบหมดอายุก่อนถึงคิว กรุณาเข้าสู่ระบบแล้วเลือกไฟล์ใหม่';
          renderEntry(entry);
          continue;
        }
        entry.status = 'uploading';
        renderEntry(entry);
        try {
          entry.result = await P[entry.target].upload(entry.session || {}, entry.file, { share: entry.share }, function (n) {
            entry.loaded = n;
            if (entry.bar) entry.bar.value = Math.round(n * 100 / Math.max(1, entry.file.size));
            if (entry.text) entry.text.textContent = 'กำลังอัปโหลด ' + C.formatBytes(n) + ' / ' + C.formatBytes(entry.file.size);
          }, entry.control);
          entry.status = 'done';
          toast('ฝาก ' + C.displayName(entry.file.name).slice(0, 60) + ' เรียบร้อย', 'ok');
        } catch (e) {
          entry.status = e && e.cancelled ? 'cancelled' : 'error';
          entry.message = errorText(e);
          if (e && e.auth) handleAuthError(entry.target, e, entry.session);
        }
        renderEntry(entry);
      }
    } finally {
      S.running = false;
    }
    if (S.choice === 'google' || S.choice === 'onedrive') { refreshFiles(); loadAccount(S.choice); }
  }

  // ---------------------------------------------------------------- ไฟล์ที่ฝากไว้

  var listSeq = 0;

  function refreshFiles() {
    var kind = S.choice;
    var s = (kind === 'google' || kind === 'onedrive') ? session(kind) : null;
    if (!s) return;
    var seq = ++listSeq;
    $('files-status').textContent = 'กำลังโหลดรายการ...';
    P[kind].list(s).then(function (files) {
      if (seq !== listSeq || S.choice !== kind) return;
      var ul = $('files');
      ul.replaceChildren();
      $('files-status').textContent = files.length ? 'ไฟล์ล่าสุด ' + files.length + ' ไฟล์ (เฉพาะที่ฝากผ่านระบบนี้)' : 'ยังไม่มีไฟล์ที่ฝากผ่านระบบนี้';
      files.forEach(function (f) {
        var li = el('li', 'f-item');
        var head = el('div', 'q-head');
        head.appendChild(el('span', 'q-name', C.displayName(f.name)));
        var when = f.time ? new Date(f.time) : null;
        head.appendChild(el('span', 'q-size muted', C.formatBytes(f.size) + (when && !isNaN(when) ? ' · ' + when.toLocaleString('th-TH') : '')));
        li.appendChild(head);
        var actions = el('div', 'links');
        if (f.link) {
          var a = el('a', 'link', 'เปิด');
          a.href = f.link;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          actions.appendChild(a);
          var copy = el('button', 'btn btn-small', 'คัดลอกลิงก์');
          copy.type = 'button';
          copy.addEventListener('click', function () { copyLink(f.link); });
          actions.appendChild(copy);
        }
        var del = el('button', 'btn btn-small danger', 'ลบ');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!window.confirm('ลบ "' + C.displayName(f.name).slice(0, 80) + '" ไปถังขยะของ ' + C.provider(kind).label + '?')) return;
          del.disabled = true;
          P[kind].remove(s, f.id).then(function () { toast('ลบไฟล์แล้ว (กู้คืนได้จากถังขยะ)', 'ok'); refreshFiles(); loadAccount(kind); }, function (e) {
            del.disabled = false;
            if (!handleAuthError(kind, e, s)) toast(errorText(e), 'error');
          });
        });
        actions.appendChild(del);
        li.appendChild(actions);
        ul.appendChild(li);
      });
    }, function (e) {
      if (seq !== listSeq) return;
      if (!handleAuthError(kind, e, s)) $('files-status').textContent = 'โหลดรายการไม่สำเร็จ: ' + errorText(e);
    });
  }

  // ---------------------------------------------------------------- เริ่มต้น

  function init() {
    if (!C || !P) return;
    Array.prototype.forEach.call(document.querySelectorAll('.provider'), function (b) {
      b.addEventListener('click', function () { choose(b.getAttribute('data-provider')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="host"]'), function (r) {
      r.addEventListener('change', render);
    });
    $('btn-login').addEventListener('click', function () { login(S.choice); });
    $('btn-logout').addEventListener('click', logout);
    $('btn-refresh').addEventListener('click', refreshFiles);
    $('btn-pick').addEventListener('click', function (e) { e.stopPropagation(); $('file-input').value = ''; $('file-input').click(); });
    $('dropzone').addEventListener('click', function () { $('file-input').value = ''; $('file-input').click(); });
    $('file-input').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      addFiles(files);
    });
    var dz = $('dropzone');
    document.addEventListener('dragover', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      if (!$('upload-card').hidden) dz.classList.add('over');
    });
    document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) dz.classList.remove('over'); });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      dz.classList.remove('over');
      if ($('upload-card').hidden) { toast('เลือกที่ฝากไฟล์และเข้าสู่ระบบก่อน', 'error'); return; }
      addFiles(droppedFiles(e.dataTransfer));
    });
    window.addEventListener('beforeunload', function (e) {
      if (!S.queue.some(function (x) { return x.status === 'uploading' || x.status === 'waiting'; })) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // โทเคนหมดอายุ: อัปเดตหน้าจอทุก 30 วินาที
    setInterval(function () {
      if (S.choice && S.sessions[S.choice] && !session(S.choice)) { render(); toast('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่', 'error'); }
    }, 30000);

    var saved = null;
    try { saved = localStorage.getItem(PROVIDER_KEY); } catch (e) { /* ignore */ }
    S.choice = CHOICES.indexOf(saved) >= 0 ? saved : null;
    render();
    handleRedirect();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
