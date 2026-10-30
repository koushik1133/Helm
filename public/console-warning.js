/* ============================================================================
 * console-warning.js — R104 self-XSS warning in the browser DevTools console.
 * The same idea Facebook/Instagram, Discord, Slack and Google use: scammers tell
 * people to "paste this code in the console" to steal their session. We print a
 * big red STOP once per page load so anyone who opens DevTools sees the warning.
 * This is NOT devtools detection/blocking (that is security theater and hurts
 * developers + accessibility) — it only logs a message. No DOM, no network.
 * ========================================================================== */
(function () {
  'use strict';
  try {
    if (window.__helmConsoleWarned) return;
    window.__helmConsoleWarned = true;
    var c = window.console;
    if (!c || typeof c.log !== 'function') return;
    var h = location.hostname || '';
    var local = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.(localhost|test)$/.test(h);
    if (local) {
      c.log('%cHelm (local dev): never paste code here that someone sent you.', 'color:#b91c1c;font-weight:700');
      return;
    }
    c.log('%cStop!', 'color:#dc2626;font-size:48px;font-weight:800;-webkit-text-stroke:1px #7f1d1d;font-family:system-ui,sans-serif');
    c.log('%cThis is a browser feature intended for developers. If someone told you to copy and paste something here to "unlock" a feature, get a discount or fix your account, it is a scam and will give them access to your Helm account, your studio\'s clients and payments.',
      'font-size:16px;line-height:1.5;font-family:system-ui,sans-serif');
    c.log('%cHelm staff will never ask you to paste anything here. If you were asked to, close this panel and tell your studio owner.',
      'font-size:14px;color:#525252;font-family:system-ui,sans-serif');
  } catch (e) { /* never break the page */ }
})();
