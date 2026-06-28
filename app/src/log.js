// geeek — client logger. Captures structured events with FULL detail (including
// the non-enumerable Error properties that console.warn hides), keeps them in
// memory for inspection, and ships them to /api/log in small batches.
// Exposes window.SDD.log.{ev,flush,dump,sid}. Safe + best-effort: never throws,
// never blocks the UI, drops silently if the network/endpoint is unavailable.
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG || {};
  function api(p) { return (CFG.API_BASE || "/api") + p; }

  // Stable per-tab session id so we can group a whole flow together.
  var sid;
  try {
    sid = sessionStorage.getItem("sdd_sid");
    if (!sid) { sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); sessionStorage.setItem("sdd_sid", sid); }
  } catch (e) { sid = "n" + Date.now().toString(36); }

  var buf = [];     // pending (not yet shipped)
  var mem = [];     // rolling in-memory copy for SDD.log.dump()

  // Serialize anything safely — Errors, DOM events, and objects whose useful
  // fields live on NON-enumerable properties (MusicKit stashes errorCode /
  // description there, which is why they never showed up before).
  function ser(d, depth) {
    depth = depth || 0;
    try {
      if (d === null || d === undefined) return d;
      var t = typeof d;
      if (t === "string" || t === "number" || t === "boolean") return d;
      if (t === "function") return "[function " + (d.name || "") + "]";
      if (depth > 4) return "[deep]";
      if (Array.isArray(d)) return d.slice(0, 50).map(function (x) { return ser(x, depth + 1); });
      var out = {};
      var keys = [];
      try { keys = Object.getOwnPropertyNames(d); } catch (e) { try { keys = Object.keys(d); } catch (e2) { keys = []; } }
      if (d instanceof Error && keys.indexOf("stack") === -1) keys.push("stack");
      for (var i = 0; i < keys.length && i < 80; i++) {
        var k = keys[i];
        if (k === "stack" && typeof d[k] === "string") { out[k] = String(d[k]).split("\n").slice(0, 6).join(" | "); continue; }
        try {
          var v = d[k];
          if (typeof v === "function") continue;
          out[k] = ser(v, depth + 1);
        } catch (e3) { out[k] = "[unserializable]"; }
      }
      return out;
    } catch (e) { try { return String(d); } catch (e4) { return "[ser-failed]"; } }
  }

  function ev(cat, action, detail, level) {
    var e = {
      t: new Date().toISOString(),
      ms: (window.performance && performance.now ? Math.round(performance.now()) : null),
      sid: sid, cat: cat, action: action, level: level || "info",
      page: location.pathname
    };
    if (arguments.length >= 3) e.detail = ser(detail);
    buf.push(e); mem.push(e); if (mem.length > 1000) mem.shift();
    try { (level === "error" ? console.error : console.debug)("[geeek:" + cat + "] " + action, e.detail !== undefined ? e.detail : ""); } catch (x) {}
    if (buf.length >= 10) flush(false);
    return e;
  }

  function flush(useBeacon) {
    if (!buf.length) return;
    var batch = buf.splice(0, buf.length);
    var bodyStr;
    try { bodyStr = JSON.stringify({ events: batch, sid: sid }); } catch (e) { return; }
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(api("/log"), new Blob([bodyStr], { type: "application/json" }));
        return;
      }
    } catch (e) {}
    try {
      fetch(api("/log"), { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyStr, keepalive: true })["catch"](function () {});
    } catch (e) {}
  }

  try { setInterval(function () { flush(false); }, 4000); } catch (e) {}
  window.addEventListener("pagehide", function () { flush(true); });
  window.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(true); });
  window.addEventListener("error", function (e) {
    ev("window", "error", { message: e.message, src: e.filename, line: e.lineno, col: e.colno, error: e.error }, "error");
  });
  window.addEventListener("unhandledrejection", function (e) {
    ev("window", "unhandledrejection", { reason: e.reason }, "error");
  });

  window.SDD = window.SDD || {};
  window.SDD.log = { ev: ev, flush: flush, sid: sid, dump: function () { return mem.slice(); } };

  ev("app", "load", {
    ref: document.referrer, ua: navigator.userAgent, lang: navigator.language,
    cookieEnabled: navigator.cookieEnabled, origin: location.origin
  });
})();
