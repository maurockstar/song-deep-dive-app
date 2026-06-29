// geeek — shared auth helpers (no external deps; Node crypto only).
//
// DORMANT-SAFE: the whole auth layer stays inert until BOTH of these are true:
//   1) Azure App Setting  AUTH_SECRET  is set (a long random string), and
//   2) app/api/shared/users.json has at least one user with a salt + hash.
// Until then isEnabled() === false and every gate falls open, so the app and
// site behave exactly as before. Set the secret + a password to activate.
//
// Passwords: salted scrypt. Sessions: compact HS256 JWT in an http-only,
// Secure, SameSite=Lax cookie scoped to .geeek.fm (shared by app + website).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SECRET = process.env.AUTH_SECRET || "";
const SESSION_DAYS = 90;
const COOKIE = "gk_sess";
const COOKIE_DOMAIN = process.env.AUTH_COOKIE_DOMAIN || ".geeek.fm";

// Sign in with Apple — the Services ID (web client_id / token audience).
const APPLE_SERVICES_ID = process.env.APPLE_SIWA_SERVICES_ID || "";
const APPLE_ISS = "https://appleid.apple.com";

function readStore() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "users.json"), "utf8")); }
  catch (e) { return {}; }
}
function loadAllow() { const j = readStore(); return Array.isArray(j.allow) ? j.allow : []; }
function appleClientId() { return APPLE_SERVICES_ID; }

function isEnabled() {
  if (!SECRET || !APPLE_SERVICES_ID) return false;
  return loadAllow().some(a => a && (a.email || a.sub) && a.approved !== false);
}

// Is this Apple identity on the approved allowlist?
function appleAllowed(email, sub) {
  const e = String(email || "").toLowerCase();
  return loadAllow().find(a => a && a.approved !== false && (
    (a.email && String(a.email).toLowerCase() === e && e) ||
    (a.sub && sub && String(a.sub) === String(sub))
  )) || null;
}

// Apple's public signing keys (cached ~1h).
let _appleKeys = null, _appleKeysAt = 0;
async function appleKeys() {
  if (_appleKeys && (Date.now() - _appleKeysAt) < 3600000) return _appleKeys;
  try {
    const r = await fetch("https://appleid.apple.com/auth/keys");
    if (!r.ok) return _appleKeys || [];
    const j = await r.json();
    _appleKeys = (j && j.keys) || [];
    _appleKeysAt = Date.now();
  } catch (e) { /* keep last */ }
  return _appleKeys || [];
}

// Verify a Sign in with Apple identity token. Returns its claims or null.
async function verifyAppleIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(b64urlDecode(parts[0])); payload = JSON.parse(b64urlDecode(parts[1])); } catch (e) { return null; }
  const keys = await appleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const sig = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (!crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, sig)) return null;
  } catch (e) { return null; }
  if (payload.iss !== APPLE_ISS) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (APPLE_SERVICES_ID && auds.indexOf(APPLE_SERVICES_ID) === -1) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function signSession(username) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ u: username, iat: now, exp: now + SESSION_DAYS * 86400 }));
  const data = head + "." + payload;
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  return data + "." + sig;
}

function verifySession(token) {
  if (!SECRET || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const expected = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  const a = Buffer.from(expected), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

function parseCookies(req) {
  const h = (req && req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  const out = {};
  String(h).split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function sessionFromReq(req) {
  return verifySession(parseCookies(req)[COOKIE]);
}

function cookieHeader(token, maxAgeSec) {
  const parts = [
    COOKIE + "=" + (token || ""),
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    "Max-Age=" + (maxAgeSec != null ? maxAgeSec : SESSION_DAYS * 86400)
  ];
  if (COOKIE_DOMAIN) parts.push("Domain=" + COOKIE_DOMAIN);
  return parts.join("; ");
}

// CORS for the website (geeek.fm) calling the app's auth endpoints cross-origin.
// Credentialed requests require an explicit origin echo (never "*").
const ALLOWED_ORIGINS = (process.env.AUTH_ALLOWED_ORIGINS
  ? process.env.AUTH_ALLOWED_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : ["https://geeek.fm", "https://www.geeek.fm", "https://app.geeek.fm",
     "https://zealous-pond-0200e1e10.7.azurestaticapps.net", "https://ashy-bush-0b7f9b110.7.azurestaticapps.net"]);
function corsHeaders(req) {
  const origin = (req && req.headers && (req.headers.origin || req.headers.Origin)) || "";
  if (!origin || ALLOWED_ORIGINS.indexOf(origin) === -1) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

// Guard helper for data APIs: returns true if the request should be blocked.
function blockIfUnauthed(context, req) {
  if (!isEnabled()) return false;            // dormant → allow
  if (sessionFromReq(req)) return false;     // valid session → allow
  context.res = {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: { error: "Unauthorized", needsLogin: true }
  };
  return true;
}

module.exports = {
  COOKIE, SESSION_DAYS, isEnabled, loadAllow, appleClientId, appleAllowed, verifyAppleIdToken,
  signSession, verifySession, parseCookies, sessionFromReq, cookieHeader, corsHeaders, blockIfUnauthed
};
