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

function loadUsers() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "users.json"), "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j.users) ? j.users : [];
  } catch (e) { return []; }
}

function isEnabled() {
  if (!SECRET) return false;
  return loadUsers().some(u => u && u.u && u.salt && u.hash);
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  try {
    const dk = crypto.scryptSync(String(password), user.salt, 32);
    const stored = Buffer.from(user.hash, "hex");
    return dk.length === stored.length && crypto.timingSafeEqual(dk, stored);
  } catch (e) { return false; }
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
  COOKIE, SESSION_DAYS, isEnabled, loadUsers, verifyPassword,
  signSession, verifySession, parseCookies, sessionFromReq, cookieHeader, corsHeaders, blockIfUnauthed
};
