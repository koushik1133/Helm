/* trial-early.js (0181) - FREE TRIAL studios only; look only, the server enforces every limit (0173 / 0181).
 * Loaded synchronously in <head> of the builder and the booklet (studio pages without the app shell in <head>;
 * the app pages get the same lines from shell-proto.js, and store-api.js repeats them for every other page).
 * A browser that last saw a studio in its free trial (localStorage "helm.trial" = "1", written by trial-lock.js)
 * gets html.helm-trial + helm-trial-early before first paint, so export / render / print buttons never flash
 * usable. trial-lock.js then asks the server: still a trial -> helm-trial stays (helm-trial-early is dropped);
 * paid, upgraded or signed out -> both classes come off again and the flag is cleared. */
(function () {
  try {
    if (window.localStorage.getItem("helm.trial") !== "1") return;
    var d = document.documentElement;
    if (!d.classList.contains("helm-trial")) { d.classList.add("helm-trial"); d.classList.add("helm-trial-early"); }
    if (!document.getElementById("trialLockCss")) {
      var l = document.createElement("link"); l.id = "trialLockCss"; l.rel = "stylesheet"; l.href = "/trial-lock.css?v=8";
      if (!document.body) l.setAttribute("blocking", "render");
      (document.head || d).appendChild(l);
    }
  } catch (e) {}
})();
