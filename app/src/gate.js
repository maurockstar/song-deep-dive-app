// geeek — sign-in gate (front door).
//
// On load it overlays the app with the black login landing, asks /api/session,
// and:
//   • dormant (auth not configured) or already signed in -> removes the overlay,
//     the app runs normally.
//   • signed out -> shows the animated logo; click it to open the glass dialog,
//     enter credentials, POST /api/auth, then reload into the app.
//
// Stays completely inert visually once authed, so it never gets in the way.
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG || {};
  function api(p) { return (CFG.API_BASE || "/api") + p; }

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
    '#gkGate .dlg{width:320px;max-width:88%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-radius:16px;padding:24px 22px 22px;color:#fff}' +
    '#gkGate .hd{display:flex;align-items:center;justify-content:space-between;font-size:17px;font-weight:500}' +
    '#gkGate .sub{font-size:12.5px;color:rgba(255,255,255,.6);margin:4px 0 16px}' +
    '#gkGate .x{cursor:pointer;color:rgba(255,255,255,.55);font-size:20px;line-height:1}' +
    '#gkGate input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:10px;color:#fff;padding:12px 14px;font-size:15px;margin-top:10px;outline:none;font-family:inherit}' +
    '#gkGate input::placeholder{color:rgba(255,255,255,.45)}' +
    '#gkGate input:focus{border-color:rgba(255,159,77,.7);box-shadow:0 0 0 3px rgba(255,138,77,.18)}' +
    '#gkGate .enter{width:100%;margin-top:16px;padding:12px;border:none;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:700;font-size:15px;background:linear-gradient(180deg,#FFB14D,#FF8A4D);color:#1A0B05}' +
    '#gkGate .msg{min-height:18px;margin-top:12px;font-size:12.5px;text-align:center;color:rgba(255,255,255,.7)}' +
    '</style>' +
    '<div class="lg" id="gkLg" role="button" tabindex="0" aria-label="Open sign in">g<span class="bars"><i></i><i></i><i></i></span>k</div>' +
    '<div class="hint">click the logo to sign in</div>' +
    '<div class="ov" id="gkOv"><div class="dlg" id="gkDlg">' +
    '<div class="hd"><span>Sign in to geeek</span><span class="x" id="gkX">&times;</span></div>' +
    '<div class="sub">Enter your credentials to continue</div>' +
    '<input id="gkU" type="text" placeholder="Username" autocomplete="username" />' +
    '<input id="gkP" type="password" placeholder="Password" autocomplete="current-password" />' +
    '<button class="enter" id="gkGo">Enter</button>' +
    '<div class="msg" id="gkMsg"></div>' +
    '</div></div>';

  function mount() {
    if (document.getElementById("gkGate")) return;
    (document.body || document.documentElement).appendChild(root);
    wire();
    check();
  }

  function hideGate() { root.classList.add("gk-hide"); }
  function showLogin() { /* gate already visible; nothing else needed */ }

  function wire() {
    var ov = root.querySelector("#gkOv");
    var lg = root.querySelector("#gkLg");
    var u = root.querySelector("#gkU");
    var p = root.querySelector("#gkP");
    var msg = root.querySelector("#gkMsg");

    function open() { ov.classList.add("show"); msg.textContent = ""; setTimeout(function () { u.focus(); }, 60); }
    function close() { ov.classList.remove("show"); }
    lg.onclick = open;
    lg.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") open(); };
    root.querySelector("#gkX").onclick = close;
    ov.onclick = function (e) { if (e.target === ov) close(); };

    function go() {
      var un = (u.value || "").trim(), pw = p.value || "";
      if (!un || !pw) { msg.style.color = "rgba(255,255,255,.7)"; msg.textContent = "Enter a username and password."; return; }
      msg.style.color = "rgba(255,255,255,.7)"; msg.textContent = "Signing in…";
      fetch(api("/auth"), {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: un, password: pw })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.ok) {
            msg.style.color = "#7CE2A8"; msg.textContent = "Welcome — opening geeek…";
            setTimeout(function () { location.reload(); }, 400);
          } else {
            msg.style.color = "#FF8C7A"; msg.textContent = (res.j && res.j.error) || "Wrong username or password.";
          }
        }).catch(function () { msg.style.color = "#FF8C7A"; msg.textContent = "Couldn't reach the server. Try again."; });
    }
    root.querySelector("#gkGo").onclick = go;
    p.onkeydown = function (e) { if (e.key === "Enter") go(); };
    u.onkeydown = function (e) { if (e.key === "Enter") p.focus(); };
  }

  function check() {
    fetch(api("/session"), { credentials: "include", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.enabled === false || j.authed === true) { hideGate(); }
        else { showLogin(); }
      })
      .catch(function () { hideGate(); }); // fail open to the app; data APIs still enforce
  }

  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });

  window.SDD = window.SDD || {};
  window.SDD.gate = { logout: function () { return fetch(api("/auth") + "?logout=1", { method: "POST", credentials: "include" }).then(function () { location.reload(); }); } };
})();
