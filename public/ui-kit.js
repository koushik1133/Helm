/* Helm UI kit (window.HelmUI). DOM built with createElement/textContent only, no style attrs — CSP safe.
   Include: <link rel="stylesheet" href="ui-kit.css?v=1"> + <script src="ui-kit.js?v=1" defer></script> */
(function (root) {
  "use strict";
  var doc = root.document;
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  var FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var prev = doc.activeElement;
      var overlay = el("div", "hs-root hs-overlay");
      var dlg = el("div", "hs-dialog");
      var id = "hs-dlg-" + Math.random().toString(36).slice(2, 8);
      dlg.setAttribute("role", opts.danger ? "alertdialog" : "dialog");
      dlg.setAttribute("aria-modal", "true");
      dlg.setAttribute("aria-labelledby", id + "-t");
      dlg.tabIndex = -1;
      var h = el("h2", null, opts.title || "Are you sure?"); h.id = id + "-t";
      dlg.appendChild(h);
      if (opts.body) { var p = el("p", null, opts.body); p.id = id + "-b"; dlg.setAttribute("aria-describedby", p.id); dlg.appendChild(p); }
      var acts = el("div", "hs-actions");
      var cancel = el("button", "hs-btn", opts.cancelLabel || "Cancel"); cancel.type = "button";
      var ok = el("button", "hs-btn " + (opts.danger ? "hs-btn-danger" : "hs-btn-primary"), opts.confirmLabel || "Confirm"); ok.type = "button";
      acts.appendChild(cancel); acts.appendChild(ok); dlg.appendChild(acts);
      overlay.appendChild(dlg);
      var done = false;
      function close(v) {
        if (done) return; done = true;
        doc.removeEventListener("keydown", onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (prev && prev.focus) { try { prev.focus(); } catch (e) {} }
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === "Tab") {
          var f = Array.prototype.slice.call(dlg.querySelectorAll(FOCUSABLE));
          if (!f.length) return;
          var first = f[0], last = f[f.length - 1];
          if (e.shiftKey && (doc.activeElement === first || doc.activeElement === dlg)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
      cancel.addEventListener("click", function () { close(false); });
      ok.addEventListener("click", function () { close(true); });
      overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(false); });
      doc.addEventListener("keydown", onKey, true);
      doc.body.appendChild(overlay);
      (opts.danger ? cancel : ok).focus();
    });
  }

  var stack = null;
  function getStack() {
    if (stack && stack.isConnected !== false && stack.parentNode) return stack;
    stack = el("div", "hs-root hs-toasts");
    stack.setAttribute("role", "region");
    stack.setAttribute("aria-label", "Notifications");
    doc.body.appendChild(stack);
    return stack;
  }
  function toast(msg, opts) {
    opts = opts || {};
    var type = ["success", "error", "info"].indexOf(opts.type) >= 0 ? opts.type : "info";
    var t = el("div", "hs-toast hs-" + type);
    t.setAttribute("role", type === "error" ? "alert" : "status");
    t.appendChild(el("span", "hs-toast-msg", msg));
    var timer = null, closed = false;
    function dismiss() {
      if (closed) return; closed = true;
      if (timer) clearTimeout(timer);
      if (t.parentNode) t.parentNode.removeChild(t);
      if (opts.onClose) try { opts.onClose(); } catch (e) {}
    }
    if (opts.action && opts.action.label) {
      var a = el("button", "hs-toast-act", opts.action.label); a.type = "button";
      a.addEventListener("click", function () { try { opts.action.onClick && opts.action.onClick(); } finally { dismiss(); } });
      t.appendChild(a);
    }
    var x = el("button", "hs-toast-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", dismiss);
    t.appendChild(x);
    getStack().appendChild(t);
    var ms = opts.timeout == null ? (type === "error" ? 8000 : 4000) : opts.timeout;
    if (ms > 0) timer = setTimeout(dismiss, ms);
    return { el: t, dismiss: dismiss };
  }

  // mode "defer" (default): run() only after the window unless Undo is pressed.
  // mode "immediate": run() now; Undo calls undo().
  function undoable(o) {
    o = o || {};
    var ms = o.ms == null ? 5000 : o.ms;
    var immediate = o.mode === "immediate";
    return new Promise(function (resolve) {
      var undone = false, settled = false;
      function finish(v) { if (!settled) { settled = true; resolve(v); } }
      if (immediate) { try { Promise.resolve(o.run && o.run()).catch(function () {}); } catch (e) {} }
      toast(o.message || "Done.", {
        type: "info", timeout: ms,
        action: { label: "Undo", onClick: function () {
          undone = true;
          if (immediate && o.undo) { try { o.undo(); } catch (e) {} }
          finish({ undone: true });
        } },
        onClose: function () {
          if (undone) return;
          if (!immediate && o.run) {
            Promise.resolve().then(o.run).then(function () { finish({ undone: false }); },
              function (err) { toast("That didn't save. Please try again.", { type: "error" }); finish({ undone: false, error: err }); });
          } else finish({ undone: false });
        }
      });
    });
  }

  var PILL = { draft: "Draft", sent: "Sent", confirmed: "Confirmed", paid: "Paid", overdue: "Overdue", archived: "Archived" };
  function statusPill(status, label) {
    var k = String(status || "").toLowerCase().trim();
    var cls = PILL[k] ? k : "draft";
    return el("span", "hs-pill hs-" + cls, label || PILL[k] || (status ? String(status) : "Draft"));
  }

  function emptyState(o) {
    o = o || {};
    var w = el("div", "hs-root hs-empty");
    if (o.icon) { var i = el("div", "hs-empty-icon", o.icon); i.setAttribute("aria-hidden", "true"); w.appendChild(i); }
    if (o.title) w.appendChild(el("h3", null, o.title));
    if (o.text) w.appendChild(el("p", null, o.text));
    if (o.actionLabel) {
      var b = el("button", "hs-btn hs-btn-primary", o.actionLabel); b.type = "button";
      if (o.onAction) b.addEventListener("click", o.onAction);
      w.appendChild(b);
    }
    return w;
  }

  root.HelmUI = Object.assign(root.HelmUI || {}, { confirm: confirm, toast: toast, undoable: undoable, statusPill: statusPill, emptyState: emptyState, version: 1 });
})(typeof window !== "undefined" ? window : globalThis);
