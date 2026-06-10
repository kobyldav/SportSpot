/**
 * Hlavní Worker — vstupní bod API.
 *
 * Tento soubor:
 *   - Nastavuje Hono routing a middleware
 *   - Exportuje CourtBooking Durable Object
 *   - Obsahuje health check a ukázkové endpointy (auth, map, booking)
 *
 * Ukázkové endpointy demonstrují JAK používat připravené knihovny.
 * Dál na tento základ přidáváš další endpointy.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { newId, geoBounds } from "./lib/ids";
import { hashPassword, verifyPassword, signJwt, verifyJwt, signQr } from "./lib/auth";
import * as cache from "./lib/cache";
import { calculatePrice, calcOccupancy } from "./lib/pricing";
import { CourtLock } from "./durable/CourtBooking";

// Export Durable Object (musí být exportováno z hlavního souboru)
export { CourtBooking } from "./durable/CourtBooking";

const app = new Hono<{ Bindings: Env; Variables: { userId: string; userType: string } }>();

// ─── MIDDLEWARE ─────────────────────────────────────

app.use("*", cors({
  origin: ["http://localhost:3000", "https://rezervace.cz"], // doplň své domény
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "If-None-Match"],
}));

/**
 * Auth middleware — ověří JWT z Authorization hlavičky.
 * Použij na chráněné endpointy přes app.use().
 */
async function requireAuth(c: any, next: any) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "chybí token" }, 401);
  }
  const token = auth.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "neplatný nebo expirovaný token" }, 401);
  }
  c.set("userId", payload.sub);
  c.set("userType", payload.type);
  await next();
}

// ─── HEALTH CHECK ───────────────────────────────────

app.get("/health", async (c) => {
  try {
    // Ověř spojení s databází
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "ok", db: "connected" });
  } catch (e) {
    return c.json({ status: "error", db: "disconnected", detail: String(e) }, 500);
  }
});

// ════════════════════════════════════════════════════
// AUTH — ukázka registrace a přihlášení zákazníka
// ════════════════════════════════════════════════════

app.post("/api/auth/register", async (c) => {
  const { email, password, name, consentData } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "email a heslo jsou povinné" }, 400);
  }
  if (!consentData) {
    return c.json({ error: "souhlas se zpracováním údajů je povinný" }, 400);
  }

  // Zkontroluj jestli email už existuje
  const existing = await c.env.DB
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email).first();
  if (existing) {
    return c.json({ error: "email už je registrován" }, 409);
  }

  // Vytvoř uživatele
  const id = newId.user();
  const hash = await hashPassword(password);
  await c.env.DB.prepare(`
    INSERT INTO users (id, email, name, password_hash, consent_data, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).bind(id, email, name ?? null, hash, Date.now()).run();

  // Vytvoř session token
  const token = await signJwt({ sub: id, type: "user" }, c.env.JWT_SECRET, 86400);
  await cache.storeSession(c.env.SESSIONS, token, { userId: id, type: "user" });

  return c.json({ token, user: { id, email, name } });
});

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json();

  const user = await c.env.DB
    .prepare("SELECT id, email, name, password_hash FROM users WHERE email = ? AND deleted_at IS NULL")
    .bind(email).first<{ id: string; email: string; name: string; password_hash: string }>();

  if (!user || !user.password_hash) {
    return c.json({ error: "nesprávný email nebo heslo" }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "nesprávný email nebo heslo" }, 401);
  }

  const token = await signJwt({ sub: user.id, type: "user" }, c.env.JWT_SECRET, 86400);
  await cache.storeSession(c.env.SESSIONS, token, { userId: user.id, type: "user" });

  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// ════════════════════════════════════════════════════
// MAP — ukázka vyhledávání s cache a ETag
// ════════════════════════════════════════════════════

app.get("/api/map", async (c) => {
  const lat = parseFloat(c.req.query("lat") ?? "");
  const lng = parseFloat(c.req.query("lng") ?? "");
  const radius = parseFloat(c.req.query("radius") ?? "5"); // km

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "lat a lng jsou povinné" }, 400);
  }

  const clientEtag = c.req.header("If-None-Match") ?? null;

  // 1. Zkus cache (s ETag)
  const cached = await cache.getMapCache(c.env.CACHE, lat, lng, clientEtag);
  if (cached.notModified) {
    return c.body(null, 304, { "ETag": cached.etag! }); // klient má aktuální data
  }
  if (cached.data) {
    return c.json(cached.data, 200, { "ETag": cached.etag! });
  }

  // 2. Cache miss → jeden D1 JOIN dotaz
  const today = new Date().toISOString().slice(0, 10);
  const b = geoBounds(lat, lng, radius);

  const result = await c.env.DB.prepare(`
    SELECT
      v.id, v.name, v.lat, v.lng, v.sport_types, v.open_hours, v.status,
      COUNT(DISTINCT c.id) AS total_courts,
      COUNT(DISTINCT CASE WHEN bk.status IN ('confirmed','active') THEN bk.id END) AS booked_today
    FROM venues v
    LEFT JOIN courts c ON c.venue_id = v.id AND c.status = 'active'
    LEFT JOIN bookings bk ON bk.venue_id = v.id AND bk.date = ?
    WHERE v.lat BETWEEN ? AND ? AND v.lng BETWEEN ? AND ?
      AND v.status = 'active'
    GROUP BY v.id
  `).bind(today, b.latMin, b.latMax, b.lngMin, b.lngMax).all();

  const venues = result.results;

  // 3. Ulož do cache + vrať s ETagem
  const etag = await cache.setMapCache(c.env.CACHE, lat, lng, venues);
  return c.json(venues, 200, { "ETag": etag });
});

// ════════════════════════════════════════════════════
// BOOKING — ukázka rezervace přes Durable Object
// ════════════════════════════════════════════════════

app.post("/api/bookings", requireAuth, async (c) => {
  const userId = c.get("userId");
  const { courtId, date, startTime, endTime, paymentMethod } = await c.req.json();

  // 1. Načti kurt a jeho cenu
  const court = await c.env.DB
    .prepare("SELECT id, venue_id, hourly_rate, member_rate FROM courts WHERE id = ? AND status = 'active'")
    .bind(courtId)
    .first<{ id: string; venue_id: string; hourly_rate: number; member_rate: number | null }>();

  if (!court) {
    return c.json({ error: "kurt neexistuje" }, 404);
  }

  // 2. Zjisti jestli je zákazník člen (pro členskou cenu)
  const membership = await c.env.DB
    .prepare("SELECT 1 FROM club_memberships WHERE user_id = ? AND venue_id = ? AND status = 'active'")
    .bind(userId, court.venue_id).first();
  const isMember = !!membership && court.member_rate !== null;
  const baseRate = isMember ? court.member_rate! : court.hourly_rate;

  // 3. Zjisti obsazenost pro dynamic pricing
  const occ = await c.env.DB.prepare(`
    SELECT COUNT(*) AS booked FROM bookings
    WHERE court_id = ? AND date = ? AND status IN ('confirmed','active')
  `).bind(courtId, date).first<{ booked: number }>();
  const occupancy = calcOccupancy(occ?.booked ?? 0, 14); // ~14 slotů/den

  // 4. Vypočti cenu
  const now = new Date();
  const slotDate = new Date(`${date}T${startTime}`);
  const minutesUntil = (slotDate.getTime() - now.getTime()) / 60000;
  const pricing = calculatePrice({
    providerRate: baseRate,
    occupancyRatio: occupancy,
    minutesUntilSlot: minutesUntil,
    dayOfWeek: slotDate.getDay(),
    hour: slotDate.getHours(),
    paymentMethod: paymentMethod ?? "qr",
  });

  // 5. POKUS O ZAMKNUTÍ SLOTU přes Durable Object (atomicky!)
  const lock = new CourtLock(c.env.COURT_BOOKING, courtId);
  const reserved = await lock.reserve(date, startTime, userId);
  if (!reserved.success) {
    return c.json({ error: "slot není dostupný", reason: reserved.reason }, 409);
  }

  // 6. Vytvoř rezervaci ve stavu pending
  const bookingId = newId.booking();
  try {
    await c.env.DB.prepare(`
      INSERT INTO bookings (
        id, court_id, venue_id, user_id, date, start_time, end_time, status,
        customer_price, provider_amount, platform_fee, gateway_fee, platform_pct,
        payment_method, is_member_price, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      bookingId, courtId, court.venue_id, userId, date, startTime, endTime,
      pricing.customerPrice, pricing.providerAmount, pricing.platformFee,
      pricing.gatewayFee, pricing.platformPct,
      paymentMethod ?? "qr", isMember ? 1 : 0, Date.now(), Date.now()
    ).run();
  } catch (e) {
    // Pokud INSERT selže, uvolni slot
    await lock.release(date, startTime);
    return c.json({ error: "rezervace selhala", detail: String(e) }, 500);
  }

  // 7. Tady by následovala platba (GoPay/Stripe) — zatím placeholder
  //    Po úspěšné platbě webhook zavolá lock.confirm() a vygeneruje QR

  return c.json({
    bookingId,
    status: "pending",
    price: {
      customer: pricing.customerPrice,
      provider: pricing.providerAmount,
      platformFee: pricing.platformFee,
      isMember,
      discountReason: pricing.discountReason,
    },
    lockExpiresAt: reserved.lockExpiresAt,
    // payment: { ... } — doplníš po integraci platební brány
  });
});

// ════════════════════════════════════════════════════
// QR — servírování QR kódu rezervace z R2
// ════════════════════════════════════════════════════

app.get("/api/bookings/:id/qr", requireAuth, async (c) => {
  const bookingId = c.req.param("id");
  const obj = await c.env.STORAGE.get(`qr/${bookingId}.png`);
  if (!obj) return c.json({ error: "QR kód nenalezen" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { headers });
});

// ─── FALLBACK ───────────────────────────────────────

app.notFound((c) => c.json({ error: "endpoint neexistuje" }, 404));

app.onError((err, c) => {
  console.error("Worker error:", err);
  return c.json({ error: "interní chyba serveru" }, 500);
});

export default app;
