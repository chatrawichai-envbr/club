/*
 * Dialog — หน้าต่างแจ้งเตือน/ยืนยัน/กรอกข้อมูล/รอ (แทน SweetAlert2 ซึ่งแทรก <style> เองจน CSP ของหน้าไม่อนุญาต)
 * ทุกอย่างสร้างด้วย DOM และ textContent — ข้อความจากไฟล์ PDF/ผู้ใช้/AI ไม่มีทางกลายเป็น HTML
 *
 *   Dialog.el(tag, props, children)   สร้าง element (props: class, text, value, attribute อื่น — ห้าม on*, style, innerHTML)
 *   Dialog.show(opts) → Promise       หน้าต่างทั่วไป (ดูคำอธิบายที่ฟังก์ชัน)
 *   Dialog.alert(title, message, kind) / Dialog.confirm(title, message, opts) / Dialog.busy(title, message)
 *   Dialog.isOpen()                   มีหน้าต่างเปิดอยู่ไหม (ใช้กันปุ่มลัดบนแป้นพิมพ์)
 */
(function (root) {
  'use strict';

  var seq = 0;
  var openCount = 0;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (/^on/i.test(k) || k === 'style' || k === 'innerHTML' || k === 'srcdoc') throw new Error('Dialog.el: ห้ามใช้ ' + k);
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }

  function icon(name, extra) {
    return el('i', { class: 'fa-solid fa-' + name + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
  }

  var KIND = {
    primary: 'dlg-btn dlg-btn-primary',
    danger: 'dlg-btn dlg-btn-danger',
    secondary: 'dlg-btn dlg-btn-secondary'
  };
  var ALERT_ICON = {
    error: ['circle-xmark', 'text-red-500'],
    warning: ['triangle-exclamation', 'text-amber-500'],
    success: ['circle-check', 'text-emerald-500'],
    info: ['circle-info', 'text-sky-500']
  };

  /**
   * opts: {
   *   title, icon: [ชื่อไอคอน, คลาสสี], body: Node | string | array, wide: boolean,
   *   buttons: [{ label, value, kind: 'primary'|'danger'|'secondary', icon, submit: boolean }],
   *   cancelValue: ค่าที่คืนเมื่อกด Esc/คลิกนอกหน้าต่าง, dismissible: false = ปิดด้วย Esc/คลิกนอกไม่ได้,
   *   onOpen(ctx), collect(ctx) → ค่าที่คืน หรือ { error: 'ข้อความ' } (เรียกเมื่อกดปุ่ม submit ถ้าเป็น Promise จะรอ)
   * }
   * ctx: { dialog, body, setError(msg), close(value), button(value) }
   */
  function show(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var id = 'dlg-' + (++seq);
      var dismissible = opts.dismissible !== false;
      var cancelValue = opts.cancelValue === undefined ? null : opts.cancelValue;
      var dlg = el('dialog', { class: 'app-dialog' + (opts.wide ? ' app-dialog-wide' : ''), 'aria-labelledby': id + '-title' });
      var inner = el('div', { class: 'dlg-inner' });
      var title = el('h2', { id: id + '-title', class: 'dlg-title' }, [opts.icon ? icon(opts.icon[0], opts.icon[1]) : null, el('span', { text: opts.title || '' })]);
      var body = el('div', { class: 'dlg-body' });
      append(body, typeof opts.body === 'string' ? el('p', { class: 'dlg-text', text: opts.body }) : opts.body);
      var error = el('p', { class: 'dlg-error hidden', role: 'alert' });
      var actions = el('div', { class: 'dlg-actions' });
      var buttons = {};
      var done = false;
      var working = false;

      var ctx = {
        dialog: dlg,
        body: body,
        setError: function (msg) {
          error.textContent = msg || '';
          error.classList.toggle('hidden', !msg);
        },
        close: finish,
        button: function (value) { return buttons[value]; }
      };

      function finish(value) {
        if (done) return;
        done = true;
        openCount = Math.max(0, openCount - 1);
        try { if (dlg.open && typeof dlg.close === 'function') dlg.close(); } catch (e) { /* ignore */ }
        dlg.remove();
        resolve(value);
      }

      function press(b) {
        if (done || (working && b.submit)) return; // ปุ่มปิด/ยกเลิกกดได้แม้กำลังรอ (เช่น รอคำตอบจาก AI)
        if (!b.submit || typeof opts.collect !== 'function') { finish(b.value); return; }
        ctx.setError('');
        working = true;
        Promise.resolve().then(function () { return opts.collect(ctx, b.value); }).then(function (result) {
          working = false;
          if (result && typeof result === 'object' && typeof result.error === 'string') { ctx.setError(result.error); return; }
          finish(result);
        }, function (e) {
          working = false;
          ctx.setError((e && e.message) || String(e));
        });
      }

      (opts.buttons || []).forEach(function (b) {
        var btn = el('button', { type: 'button', class: KIND[b.kind] || KIND.secondary }, [b.icon ? icon(b.icon) : null, b.label]);
        btn.addEventListener('click', function () { press(b); });
        buttons[b.value] = btn;
        actions.appendChild(btn);
      });

      // Enter ในช่องกรอกบรรทัดเดียว = กดปุ่ม submit ตัวแรก
      dlg.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.isComposing || !e.target || e.target.tagName !== 'INPUT') return;
        var first = (opts.buttons || []).filter(function (b) { return b.submit; })[0];
        if (first) { e.preventDefault(); press(first); }
      });
      dlg.addEventListener('cancel', function (e) {
        e.preventDefault();
        if (dismissible) finish(cancelValue);
      });
      dlg.addEventListener('close', function () { finish(cancelValue); }); // ปิดด้วยวิธีอื่นของเบราว์เซอร์
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg && dismissible) finish(cancelValue); // คลิกพื้นหลังนอกกรอบ
      });

      inner.appendChild(title);
      inner.appendChild(body);
      inner.appendChild(error);
      if (actions.childNodes.length) inner.appendChild(actions);
      dlg.appendChild(inner);
      document.body.appendChild(dlg);
      openCount++;
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else { dlg.setAttribute('open', ''); dlg.classList.add('app-dialog-fallback'); }
      if (typeof opts.onOpen === 'function') opts.onOpen(ctx);
    });
  }

  function alert(title, message, kind) {
    return show({
      title: title,
      icon: ALERT_ICON[kind] || ALERT_ICON.info,
      body: message || '',
      buttons: [{ label: 'ตกลง', value: true, kind: 'primary' }],
      cancelValue: true
    });
  }

  /** opts: { confirmLabel, cancelLabel, danger, icon } → Promise<boolean> */
  function confirm(title, message, opts) {
    opts = opts || {};
    return show({
      title: title,
      icon: opts.icon || (opts.danger ? ALERT_ICON.warning : ALERT_ICON.info),
      body: message || '',
      buttons: [
        { label: opts.cancelLabel || 'ยกเลิก', value: false },
        { label: opts.confirmLabel || 'ตกลง', value: true, kind: opts.danger ? 'danger' : 'primary' }
      ],
      cancelValue: false
    });
  }

  /** หน้าต่างรอ (ปิดเองไม่ได้) → { set(message), close() } */
  function busy(title, message) {
    var text = el('p', { class: 'dlg-text', text: message || '' });
    var closeFn = null;
    show({
      title: title,
      body: el('div', { class: 'flex items-center gap-3' }, [el('span', { class: 'dlg-spinner', 'aria-hidden': 'true' }), text]),
      dismissible: false,
      onOpen: function (ctx) { closeFn = ctx.close; ctx.dialog.setAttribute('aria-busy', 'true'); }
    });
    return {
      set: function (msg) { text.textContent = msg || ''; },
      close: function () { if (closeFn) closeFn(null); }
    };
  }

  root.Dialog = {
    el: el,
    icon: icon,
    show: show,
    alert: alert,
    confirm: confirm,
    busy: busy,
    isOpen: function () { return openCount > 0; }
  };
})(typeof self !== 'undefined' ? self : this);
