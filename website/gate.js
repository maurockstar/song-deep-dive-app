// geeek website — sign-in gate (Sign in with Apple only).
// Static site: talks to the APP's auth API cross-origin. The session cookie is
// scoped to .geeek.fm, so a sign-in here is shared with app.geeek.fm. Dormant
// until auth is configured.
(function () {
  "use strict";
  var API = "https://app.geeek.fm/api";
  function api(p) { return API + p; }
  var APPLE_CLIENT_ID = "";
  var appleReady = false;

  var root = document.createElement("div");
  root.id = "gkGate";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Sign in to geeek");
  root.innerHTML =
    '<style>' +
    '#gkGate{position:fixed;inset:0;z-index:99999;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:"Space Grotesk",system-ui,sans-serif}' +
    '#gkGate.gk-hide{display:none}' +
    '#gkGate .lg{cursor:pointer;font-weight:700;font-size:62px;letter-spacing:-.03em;line-height:1;color:#F6ECE0;white-space:nowrap;user-select:none;transition:transform .18s ease,filter .18s ease}' +
    '#gkGate .lg:hover{transform:scale(1.05);filter:drop-shadow(0 0 22px rgba(255,138,77,.5))}' +
    '#gkGate .bars{display:inline-flex;align-items:flex-end;gap:3px;height:31px;margin:0 5px;vertical-align:baseline}' +
    '#gkGate .bars i{width:8px;border-radius:3px;background:linear-gradient(180deg,#FFC64B,#FF8A4D);display:block}' +
    '#gkGate .bars i:nth-child(1){animation:gkB1 .9s ease-in-out infinite alternate}' +
    '#gkGate .bars i:nth-child(2){animation:gkB2 .78s ease-in-out infinite alternate}' +
    '#gkGate .bars i:nth-child(3){animation:gkB3 1.05s ease-in-out infinite alternate}' +
    '@keyframes gkB1{from{height:14px}to{height:31px}}@keyframes gkB2{from{height:30px}to{height:14px}}@keyframes gkB3{from{height:18px}to{height:31px}}' +
    '@keyframes gkHint{0%,100%{opacity:.35}50%{opacity:.7}}' +
    '#gkGate .hint{margin-top:22px;font-size:13px;letter-spacing:.04em;color:#fff;animation:gkHint 2.2s ease-in-out infinite}' +
    '#gkGate .ov{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}' +
    '#gkGate .ov.show{display:flex}' +
    '#gkGate .dlg{width:320px;max-width:88%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-radius:16px;padding:24px 22px 22px;color:#fff;text-align:center}' +
    '#gkGate .hd{display:flex;align-items:center;justify-content:space-between;font-size:17px;font-weight:500;text-align:left}' +
    '#gkGate .sub{font-size:12.5px;color:rgba(255,255,255,.6);margin:4px 0 18px;text-align:left}' +
    '#gkGate .x{cursor:pointer;color:rgba(255,255,255,.55);font-size:20px;line-height:1}' +
    '#gkGate .appleBtn{width:100%;padding:12px 14px;border:none;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:600;font-size:15px;background:#fff;color:#000;display:flex;align-items:center;justify-content:center;gap:8px}' +
    '#gkGate .msg{min-height:18px;margin-top:14px;font-size:12.5px;color:rgba(255,255,255,.7);line-height:1.5}' +
    '</style>' +
    '<div class="lg" id="gkLg" role="button" tabindex="0" aria-label="Open sign in">g<span class="bars"><i></i><i></i><i></i></span>k</div>' +
    '<div class="hint">click the logo to sign in</div>' +
    '<div class="ov" id="gkOv"><div class="dlg" id="gkDlg">' +
    '<div class="hd"><span>Sign in to geeek</span><span class="x" id="gkX">&times;</span></div>' +
    '<div class="sub">Use your Apple ID to continue</div>' +
    '<button class="appleBtn" id="gkApple">' +
    '<svg width="16" height="16" viewBox="0 0 384 512" fill="#000" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>' +
    'Sign in with Apple</button>' +
    '<div class="msg" id="gkMsg"></div>' +
    '</div></div>';

  function mount() { if (document.getElementById("gkGate")) return; root.classList.add("gk-hide"); (document.body || document.documentElement).appendChild(root); wire(); check(); }
  function removePre() { var e = document.getElementById("gk-pre"); if (e && e.parentNode) e.parentNode.removeChild(e); }
  function hideGate() { root.classList.add("gk-hide"); removePre(); }
  function showGate() { root.classList.remove("gk-hide"); removePre(); }
  function setMsg(t, c) { var m = root.querySelector("#gkMsg"); m.style.color = c || "rgba(255,255,255,.7)"; m.innerHTML = t || ""; }

  function loadAppleJs() {
    return new Promise(function (resolve, reject) {
      if (window.AppleID && window.AppleID.auth) { resolve(); return; }
      var s = document.createElement("script");
      s.src = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
      s.async = true; s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error("apple js failed")); };
      document.head.appendChild(s);
    });
  }
  function initApple() {
    if (appleReady || !APPLE_CLIENT_ID || !window.AppleID) return;
    AppleID.auth.init({ clientId: APPLE_CLIENT_ID, scope: "name email", redirectURI: location.origin + "/", usePopup: true });
    appleReady = true;
  }
  function signInApple() {
    if (!APPLE_CLIENT_ID) { setMsg("Sign-in isn't fully configured yet.", "#FF8C7A"); return; }
    setMsg("Opening Apple…");
    loadAppleJs().then(function () { initApple(); return AppleID.auth.signIn(); }).then(function (res) {
      var idt = res && res.authorization && res.authorization.id_token;
      if (!idt) { setMsg("No token returned from Apple.", "#FF8C7A"); return; }
      setMsg("Verifying…");
      return fetch(api("/apple-auth"), { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id_token: idt }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (out) {
          if (out.ok && out.j && out.j.ok) {
            if (out.j.token) { try { document.cookie = "gk_sess=" + out.j.token + "; path=/; domain=.geeek.fm; secure; samesite=lax; max-age=7776000"; } catch (e) {} }
            setMsg("Welcome — opening geeek…", "#7CE2A8"); setTimeout(function () { location.reload(); }, 400);
          }
          else { setMsg((out.j && out.j.error) || "This Apple ID isn't approved yet.", "#FF8C7A"); }
        });
    }).catch(function (e) {
      if (e && (e.error === "popup_closed_by_user" || e.error === "user_cancelled_authorize")) { setMsg(""); return; }
      setMsg("Apple sign-in didn't complete. Try again.", "#FF8C7A");
    });
  }
  function wire() {
    var ov = root.querySelector("#gkOv"); var lg = root.querySelector("#gkLg");
    function open() { ov.classList.add("show"); setMsg(""); } function close() { ov.classList.remove("show"); }
    lg.onclick = open; lg.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") open(); };
    root.querySelector("#gkX").onclick = close; ov.onclick = function (e) { if (e.target === ov) close(); };
    root.querySelector("#gkApple").onclick = signInApple;
  }
  function check() {
    fetch(api("/session"), { credentials: "include", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.enabled === false || j.authed === true) { hideGate(); return; }
        APPLE_CLIENT_ID = j.appleClientId || "";
        showGate();
        loadAppleJs().then(initApple).catch(function () {});
      })
      .catch(function () { hideGate(); });
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
