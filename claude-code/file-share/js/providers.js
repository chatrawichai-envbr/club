/*
 * ShareProviders — อัปโหลดไฟล์ไปยังแต่ละที่ฝากไฟล์ด้วย REST API โดยตรง (ไม่ใช้ไลบรารีภายนอก)
 * ไฟล์ส่งตรงจากเบราว์เซอร์ไปยังผู้ให้บริการ ไม่ผ่านเซิร์ฟเวอร์อื่น
 *
 *   ShareProviders[name].upload(session, file, opts, onProgress, control) → Promise<{ name, size, link, id?, shared }>
 *     session: { token } (Google/OneDrive), opts: { share }, onProgress(loadedBytes), control: { cancel() ถูกใส่ให้ }
 *   google/onedrive ยังมี account(session), list(session), remove(session, id)
 */
(function () {
  'use strict';

  var C = window.ShareCore;
  var DRIVE = 'https://www.googleapis.com/drive/v3';
  var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var FOLDER_NAME = 'ระบบฝากไฟล์';
  var OD_CHUNK = 32 * 320 * 1024; // 10 MiB — OneDrive กำหนดให้เป็นพหุคูณของ 320 KiB และไม่เกิน 60 MiB ต่อครั้ง
  var OD_UPLOAD_HOSTS = ['api.onedrive.com', '*.onedrive.com', '*.sharepoint.com', '*.microsoftpersonalcontent.com'];

  function userError(message, extra) {
    var e = new Error(message);
    e.userMessage = message;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  function cancelledError() { return userError('ยกเลิกแล้ว', { cancelled: true }); }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /** XMLHttpRequest แบบ Promise (fetch ยังรายงานความคืบหน้าการอัปโหลดไม่ได้) */
  function xhr(o, control) {
    return new Promise(function (resolve, reject) {
      if (control && control.cancelled) { reject(cancelledError()); return; }
      var x = new XMLHttpRequest();
      x.open(o.method, o.url, true);
      Object.keys(o.headers || {}).forEach(function (k) { x.setRequestHeader(k, o.headers[k]); });
      if (o.onProgress && x.upload) x.upload.onprogress = function (e) { o.onProgress(e.loaded); };
      x.onload = function () {
        resolve({ status: x.status, text: x.responseText, json: parse(x.responseText), header: function (n) { return x.getResponseHeader(n); } });
      };
      x.onerror = function () { reject(userError(o.networkMessage || 'เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต', { network: true })); };
      x.onabort = function () { reject(cancelledError()); };
      if (control) control.abort = function () { try { x.abort(); } catch (e) { /* ignore */ } };
      x.send(o.body === undefined ? null : o.body);
    });
  }

  /** ข้อความจาก API (ตัดความยาว) — แสดงด้วย textContent เท่านั้น */
  function apiMessage(json) {
    var m = json && json.error && (json.error.message || json.error_description || json.error);
    return typeof m === 'string' ? m.slice(0, 200) : '';
  }

  function httpError(res, what) {
    var msg = apiMessage(res.json);
    var reason = res.json && res.json.error && Array.isArray(res.json.error.errors) && res.json.error.errors[0] ? String(res.json.error.errors[0].reason || '') : '';
    var code = res.json && res.json.error && res.json.error.code;
    var extra = { status: res.status };
    if (res.status === 401) { extra.auth = true; return userError('การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่', extra); }
    if (reason === 'storageQuotaExceeded' || code === 'quotaLimitReached' || res.status === 507) return userError('พื้นที่เก็บไฟล์ของคุณเต็ม', extra);
    if (res.status === 413) return userError('ไฟล์ใหญ่เกินกว่าที่บริการรับได้', extra);
    if (res.status === 429 || /rateLimit/i.test(reason)) return userError('ใช้งานถี่เกินไป บริการปฏิเสธชั่วคราว ลองใหม่ภายหลัง', extra);
    if (res.status === 403) return userError('ไม่มีสิทธิ์' + what + (msg ? ' (' + msg + ')' : ''), extra);
    if (res.status >= 500) return userError('เซิร์ฟเวอร์ของผู้ให้บริการขัดข้อง (HTTP ' + res.status + ') ลองใหม่ภายหลัง', extra);
    return userError(what + 'ไม่สำเร็จ (HTTP ' + res.status + ')' + (msg ? ' ' + msg : ''), extra);
  }

  function api(method, url, token, body, what) {
    return fetch(url, {
      method: method,
      headers: body === undefined ? { Authorization: 'Bearer ' + token } : { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (r) {
      return r.text().then(function (t) {
        var res = { status: r.status, text: t, json: parse(t) };
        if (!r.ok) throw httpError(res, what);
        return res.json || {};
      });
    }, function () {
      throw userError('เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต', { network: true });
    });
  }

  function mime(file) {
    var t = String(file.type || '');
    return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(t) && t.length < 100 ? t : 'application/octet-stream';
  }

  // ---------------------------------------------------------------- Google Drive

  function q(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

  /** โฟลเดอร์ "ระบบฝากไฟล์" ใน My Drive (สิทธิ์ drive.file เห็นเฉพาะโฟลเดอร์/ไฟล์ที่ระบบนี้สร้าง) */
  function googleFolder(session) {
    if (session.folderId) return Promise.resolve(session.folderId);
    var query = 'mimeType=' + q('application/vnd.google-apps.folder') + ' and name=' + q(FOLDER_NAME) + ' and trashed=false';
    return api('GET', DRIVE + '/files?spaces=drive&pageSize=1&fields=files(id)&q=' + encodeURIComponent(query), session.token, undefined, 'ค้นหาโฟลเดอร์')
      .then(function (r) {
        if (r.files && r.files[0] && /^[A-Za-z0-9_-]{10,100}$/.test(r.files[0].id)) return r.files[0].id;
        return api('POST', DRIVE + '/files?fields=id', session.token, { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }, 'สร้างโฟลเดอร์')
          .then(function (f) { return f.id; });
      }).then(function (id) {
        if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) throw userError('สร้างโฟลเดอร์ใน Google Drive ไม่สำเร็จ');
        session.folderId = id;
        return id;
      });
  }

  function driveLink(f) {
    return C.safeLink(f.webViewLink, C.PROVIDERS.google.links) ||
      (/^[A-Za-z0-9_-]{10,100}$/.test(String(f.id)) ? 'https://drive.google.com/file/d/' + f.id + '/view' : null);
  }

  var google = {
    upload: async function (session, file, opts, onProgress, control) {
      var name = C.driveName(file.name);
      var folder = await googleFolder(session);
      // resumable upload: ขอ URL สำหรับอัปโหลดก่อน แล้วส่งไฟล์ทั้งไฟล์ด้วย PUT (รองรับไฟล์ใหญ่และรายงานความคืบหน้าได้)
      var init = await xhr({
        method: 'POST',
        url: DRIVE_UPLOAD + '?uploadType=resumable&fields=id,name,size,webViewLink',
        headers: {
          Authorization: 'Bearer ' + session.token,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime(file),
          'X-Upload-Content-Length': String(file.size)
        },
        body: JSON.stringify({ name: name, parents: [folder] })
      }, control);
      if (init.status !== 200) throw httpError(init, 'เริ่มอัปโหลด');
      var sessionUrl = C.safeLink(init.header('Location'), ['www.googleapis.com']);
      // สำรอง: ถ้าเบราว์เซอร์อ่าน Location ไม่ได้ (CORS) ใช้รหัสอัปโหลดที่ Google เปิดให้อ่าน สร้าง URL เดียวกัน
      var uploadId = sessionUrl ? '' : String(init.header('X-GUploader-UploadID') || '');
      if (!sessionUrl && /^[A-Za-z0-9_-]{10,400}$/.test(uploadId)) {
        sessionUrl = DRIVE_UPLOAD + '?uploadType=resumable&fields=id,name,size,webViewLink&upload_id=' + uploadId;
      }
      if (!sessionUrl) throw userError('Google Drive ไม่ส่ง URL สำหรับอัปโหลดกลับมา');
      var put = await xhr({
        method: 'PUT',
        url: sessionUrl,
        headers: { 'Content-Type': mime(file) },
        body: file,
        onProgress: onProgress
      }, control);
      if (put.status !== 200 && put.status !== 201) throw httpError(put, 'อัปโหลด');
      var f = put.json || {};
      var shared = false, warning = null;
      if (opts.share && f.id) {
        try {
          await api('POST', DRIVE + '/files/' + encodeURIComponent(f.id) + '/permissions?fields=id', session.token,
            { role: 'reader', type: 'anyone' }, 'เปิดลิงก์แชร์');
          shared = true;
        } catch (e) {
          // บัญชีองค์กร/โรงเรียนบางแห่งห้ามแชร์ออกนอกองค์กร — ไฟล์อัปโหลดสำเร็จแล้ว แจ้งเตือนแต่ไม่ถือว่าล้มเหลว
          if (e.auth) throw e;
          warning = 'อัปโหลดสำเร็จ แต่เปิดลิงก์แชร์ไม่ได้: ' + (e.userMessage || 'ไม่ทราบสาเหตุ') + ' — ลิงก์นี้เปิดได้เฉพาะคุณ';
        }
      }
      return { name: f.name || name, size: Number(f.size) || file.size, id: f.id, link: driveLink(f), shared: shared, warning: warning };
    },

    account: async function (session) {
      var a = await api('GET', DRIVE + '/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)', session.token, undefined, 'อ่านข้อมูลบัญชี');
      var quota = a.storageQuota || {};
      return {
        name: a.user && a.user.displayName || '',
        email: a.user && a.user.emailAddress || '',
        used: Number(quota.usage) || 0,
        total: Number(quota.limit) || 0
      };
    },

    list: async function (session) {
      var folder = await googleFolder(session);
      var query = q(folder) + ' in parents and trashed=false';
      var r = await api('GET', DRIVE + '/files?spaces=drive&pageSize=50&orderBy=createdTime%20desc&fields=files(id,name,size,createdTime,webViewLink)&q=' +
        encodeURIComponent(query), session.token, undefined, 'อ่านรายการไฟล์');
      return (r.files || []).map(function (f) {
        return { id: f.id, name: String(f.name || ''), size: Number(f.size) || 0, time: f.createdTime || '', link: driveLink(f) };
      });
    },

    /** ย้ายไปถังขยะ (กู้คืนได้ใน Google Drive 30 วัน) แทนการลบถาวร */
    remove: function (session, id) {
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(id))) return Promise.reject(userError('รหัสไฟล์ไม่ถูกต้อง'));
      return api('PATCH', DRIVE + '/files/' + encodeURIComponent(id) + '?fields=id', session.token, { trashed: true }, 'ลบไฟล์');
    },

    /** ยกเลิกสิทธิ์ที่ให้ระบบนี้ (ออกจากระบบ) — ทำเท่าที่ได้ ไม่สำเร็จก็ไม่เป็นไร เพราะโทเคนหมดอายุเองใน 1 ชั่วโมง */
    revoke: function (session) {
      return fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=' + encodeURIComponent(session.token),
        credentials: 'omit'
      }).catch(function () { /* ignore */ });
    }
  };

  // ---------------------------------------------------------------- Microsoft OneDrive

  function itemId(id) { return /^[A-Za-z0-9!._-]{1,200}$/.test(String(id)) ? String(id) : null; }

  var onedrive = {
    upload: async function (session, file, opts, onProgress, control) {
      var name = C.oneDriveName(file.name);
      // เก็บในโฟลเดอร์ของแอป (OneDrive/Apps/<ชื่อแอป>) — OneDrive สร้างให้เองครั้งแรก
      var s = await api('POST', GRAPH + '/me/drive/special/approot:/' + encodeURIComponent(name) + ':/createUploadSession', session.token,
        { item: { '@microsoft.graph.conflictBehavior': 'rename', name: name } }, 'เริ่มอัปโหลด');
      var uploadUrl = C.safeLink(s.uploadUrl, OD_UPLOAD_HOSTS);
      if (!uploadUrl) throw userError('OneDrive ส่ง URL สำหรับอัปโหลดที่ไม่รู้จักกลับมา');
      control.onCancel = function () { fetch(uploadUrl, { method: 'DELETE', credentials: 'omit' }).catch(function () { /* ignore */ }); };
      var pos = 0, total = file.size, item = null, retries = 0;
      while (!item) {
        if (control.cancelled) throw cancelledError();
        var end = Math.min(total, pos + OD_CHUNK) - 1;
        var res;
        try {
          // uploadUrl มีสิทธิ์ในตัวอยู่แล้ว — ห้ามส่ง Authorization header ไปด้วย (ตามเอกสารของ Microsoft)
          res = await xhr({
            method: 'PUT',
            url: uploadUrl,
            headers: { 'Content-Range': 'bytes ' + pos + '-' + end + '/' + total },
            body: file.slice(pos, end + 1),
            onProgress: (function (base) { return function (n) { onProgress(base + n); }; })(pos)
          }, control);
        } catch (e) {
          if (e.cancelled || retries >= 3) throw e;
          res = null;
        }
        if (res && (res.status === 200 || res.status === 201)) { item = res.json || {}; break; }
        if (res && res.status === 202) {
          var next = C.nextRange(res.json);
          next = next >= 0 ? next : end + 1;
          // ต้องได้ความคืบหน้าเสมอ (กันวนส่งช่วงเดิมไม่รู้จบถ้าเซิร์ฟเวอร์ตอบแปลก ๆ)
          if (next <= pos || next > total) { if (++retries > 3) throw userError('OneDrive ไม่รับข้อมูลต่อ ลองใหม่ภายหลัง'); } else retries = 0;
          pos = Math.min(Math.max(next, 0), total - 1);
          continue;
        }
        // 416 = ส่งช่วงที่ OneDrive ได้รับแล้ว → ถามตำแหน่งใหม่เหมือนกรณีเน็ตหลุด
        if (res && res.status < 500 && res.status !== 0 && res.status !== 416) throw httpError(res, 'อัปโหลด');
        // เน็ตหลุด/เซิร์ฟเวอร์ขัดข้อง: ถามว่าได้ถึงไหนแล้ว แล้วส่งต่อจากตรงนั้น (ไม่เกิน 3 ครั้ง)
        if (++retries > 3) throw res ? httpError(res, 'อัปโหลด') : userError('เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต');
        await new Promise(function (r) { setTimeout(r, 1500 * retries); });
        var status = await fetch(uploadUrl, { credentials: 'omit' }).then(function (r) { return r.json(); }).catch(function () { return null; });
        var n2 = C.nextRange(status);
        if (n2 >= 0 && n2 < total) pos = n2;
      }
      var id = itemId(item.id);
      var link = C.safeLink(item.webUrl, C.PROVIDERS.onedrive.links);
      var shared = false;
      if (opts.share && id) {
        try {
          var l = await api('POST', GRAPH + '/me/drive/items/' + encodeURIComponent(id) + '/createLink', session.token, { type: 'view', scope: 'anonymous' }, 'สร้างลิงก์แชร์');
          var shareUrl = C.safeLink(l.link && l.link.webUrl, C.PROVIDERS.onedrive.links);
          if (shareUrl) { link = shareUrl; shared = true; }
        } catch (e) {
          // บัญชีองค์กรบางแห่งปิดลิงก์แบบไม่ระบุตัวตน — อัปโหลดสำเร็จแล้ว แจ้งเตือนแต่ไม่ถือว่าล้มเหลว
          if (e.auth) throw e;
          item.shareError = 'อัปโหลดสำเร็จ แต่สร้างลิงก์แชร์ไม่ได้: ' + (e.userMessage || 'ไม่ทราบสาเหตุ') + ' — ลิงก์นี้เปิดได้เฉพาะคุณ';
        }
      }
      return { name: item.name || name, size: Number(item.size) || file.size, id: id, link: link, shared: shared, warning: item.shareError || null };
    },

    account: async function (session) {
      var me = await api('GET', GRAPH + '/me?$select=displayName,mail,userPrincipalName', session.token, undefined, 'อ่านข้อมูลบัญชี');
      var drive = await api('GET', GRAPH + '/me/drive?$select=quota', session.token, undefined, 'อ่านพื้นที่').catch(function () { return {}; });
      var quota = drive.quota || {};
      return { name: me.displayName || '', email: me.mail || me.userPrincipalName || '', used: Number(quota.used) || 0, total: Number(quota.total) || 0 };
    },

    list: async function (session) {
      // ยังไม่เคยฝากไฟล์ = ยังไม่มีโฟลเดอร์ของแอป (404) → รายการว่าง
      var r = await api('GET', GRAPH + '/me/drive/special/approot/children?$top=100&$select=id,name,size,webUrl,createdDateTime,file', session.token, undefined, 'อ่านรายการไฟล์')
        .catch(function (e) { if (e.status === 404) return { value: [] }; throw e; });
      return (r.value || []).filter(function (f) { return f.file; }).map(function (f) {
        return { id: itemId(f.id), name: String(f.name || ''), size: Number(f.size) || 0, time: f.createdDateTime || '', link: C.safeLink(f.webUrl, C.PROVIDERS.onedrive.links) };
      }).sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 50);
    },

    /** ลบไปถังรีไซเคิลของ OneDrive (กู้คืนได้) */
    remove: function (session, id) {
      var safe = itemId(id);
      if (!safe) return Promise.reject(userError('รหัสไฟล์ไม่ถูกต้อง'));
      return api('DELETE', GRAPH + '/me/drive/items/' + encodeURIComponent(safe), session.token, undefined, 'ลบไฟล์');
    }
  };

  // ---------------------------------------------------------------- เว็บฝากไฟล์ฟรี (ไม่ต้องเข้าสู่ระบบ)

  function freeHost(url, field, parseLink, label) {
    return {
      upload: async function (session, file, opts, onProgress, control) {
        var form = new FormData();
        form.append(field, file, C.hostName(file.name));
        var res = await xhr({
          method: 'POST',
          url: url,
          body: form,
          onProgress: onProgress,
          networkMessage: 'เชื่อมต่อ ' + label + ' ไม่ได้ (บริการอาจปิดปรับปรุง เปลี่ยนวิธีเชื่อมต่อ หรือไม่อนุญาตให้อัปโหลดจากเว็บอื่น) ลองบริการอื่นแทน'
        }, control);
        if (res.status < 200 || res.status >= 300) throw httpError(res, 'อัปโหลดไปยัง ' + label + ' ');
        var links = parseLink(res.json);
        if (!links) throw userError(label + ' ตอบกลับในรูปแบบที่ไม่รู้จัก (บริการอาจเปลี่ยน API) ลองบริการอื่นแทน');
        return { name: C.hostName(file.name), size: file.size, link: links.page || links, direct: links.direct || null, shared: true };
      }
    };
  }

  window.ShareProviders = {
    google: google,
    onedrive: onedrive,
    tmpfiles: freeHost('https://tmpfiles.org/api/v1/upload', 'file', C.tmpfilesLinks, 'tmpfiles.org'),
    gofile: freeHost('https://upload.gofile.io/uploadfile', 'file', C.gofileLink, 'Gofile.io')
  };
})();
