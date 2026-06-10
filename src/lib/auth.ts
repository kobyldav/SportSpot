/**
 * Autentizace a bezpečnost — vše přes Web Crypto (nativní ve Workers).
 * Žádné externí závislosti, žádný Node crypto.
 *
 *  - Hesla: PBKDF2 (100k iterací, SHA-256)
 *  - JWT: HMAC-SHA256 podepsané tokeny
 *  - QR: HMAC podpis proti padělání
 */

const encoder = new TextEncoder();

// ─── HESLA (PBKDF2) ─────────────────────────────────

/**
 * Zahashuje heslo. Vrací string "salt:hash" pro uložení do DB.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial, 256
  );
  const saltHex = bufToHex(salt);
  const hashHex = bufToHex(new Uint8Array(bits));
  return `${saltHex}:${hashHex}`;
}

/**
 * Ověří heslo proti uloženému hashi. Časově konstantní porovnání.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = hexToBuf(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return timingSafeEqual(bufToHex(new Uint8Array(bits)), hashHex);
}

// ─── JWT (HMAC-SHA256) ──────────────────────────────

interface JwtPayload {
  sub: string;          // user/operator ID
  type: "user" | "operator";
  exp: number;          // expiration (Unix seconds)
  [key: string]: unknown;
}

/**
 * Vytvoří podepsaný JWT token.
 */
export async function signJwt(payload: Omit<JwtPayload, "exp">, secret: string, ttlSeconds: number): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload: JwtPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(data, secret);
  return `${data}.${signature}`;
}

/**
 * Ověří a dekóduje JWT token. Vrací payload nebo null pokud neplatný/expirovaný.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signature] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const expected = await hmacSign(data, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expirovaný
    return payload;
  } catch {
    return null;
  }
}

// ─── QR KÓD PODPIS ──────────────────────────────────

/**
 * Vytvoří HMAC podpis pro QR kód. Brání padělání rezervací.
 * QR obsahuje: bookingId.signature
 */
export async function signQr(bookingId: string, secret: string): Promise<string> {
  const sig = await hmacSign(bookingId, secret);
  return `${bookingId}.${sig.slice(0, 24)}`; // zkrácený podpis stačí
}

/**
 * Ověří QR kód. Vrací bookingId pokud platný, jinak null.
 */
export async function verifyQr(qrData: string, secret: string): Promise<string | null> {
  const [bookingId, sig] = qrData.split(".");
  if (!bookingId || !sig) return null;
  const expected = await hmacSign(bookingId, secret);
  if (!timingSafeEqual(sig, expected.slice(0, 24))) return null;
  return bookingId;
}

// ─── TOTP (členské kódy) ────────────────────────────

/**
 * Vygeneruje 6místný TOTP kód z tajného klíče sportoviště.
 * Mění se každou hodinu (timeStep = 3600s).
 */
export async function generateTotp(secret: string, timeStep = 3600): Promise<string> {
  const counter = Math.floor(Date.now() / 1000 / timeStep);
  const sig = await hmacSign(String(counter), secret);
  // Z hex podpisu vezmi číslo a omez na 6 číslic
  const num = parseInt(sig.slice(0, 8), 16) % 1_000_000;
  return num.toString().padStart(6, "0");
}

/**
 * Ověří TOTP kód s tolerancí ±1 časové okno (předchozí/aktuální/příští hodina).
 */
export async function verifyTotp(code: string, secret: string, timeStep = 3600): Promise<boolean> {
  const current = Math.floor(Date.now() / 1000 / timeStep);
  for (const offset of [-1, 0, 1]) {
    const counter = current + offset;
    const sig = await hmacSign(String(counter), secret);
    const num = (parseInt(sig.slice(0, 8), 16) % 1_000_000).toString().padStart(6, "0");
    if (timingSafeEqual(code, num)) return true;
  }
  return false;
}

// ─── INTERNÍ POMOCNÉ FUNKCE ─────────────────────────

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return bufToHex(new Uint8Array(sig));
}

function bufToHex(buf: Uint8Array): string {
  return [...buf].map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return atob(str);
}

/**
 * Časově konstantní porovnání — brání timing útokům.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
