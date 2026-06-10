/**
 * Cache vrstva nad KV Store.
 *
 * Strategie:
 *  - Čtení mapy/slotů jde primárně z KV (rychlé, levné)
 *  - D1 se volá jen při cache miss
 *  - ETag pro conditional requests (304 Not Modified)
 *  - Cílená invalidace — maže se jen co se změnilo
 *
 * Tím se 95 % čtení vyřídí z KV a D1 operace klesnou na zlomek.
 */

import { geohash } from "./ids";

// ─── KLÍČE A TTL ────────────────────────────────────

const TTL = {
  map: 60,          // mapa s obsazeností — 60s
  venue: 300,       // detail sportoviště — 5 min
  slots: 30,        // volné sloty — 30s
  pricing: 300,     // dynamic pricing cache — 5 min
  session: 86400,   // session zákazníka — 24h
  sessionOp: 28800, // session provozovatele — 8h
};

const key = {
  map: (geo: string) => `map:${geo}`,
  mapEtag: (geo: string) => `etag:map:${geo}`,
  venue: (id: string) => `venue:${id}`,
  slots: (courtId: string, date: string) => `slots:${courtId}:${date}`,
  pricing: (courtId: string, date: string) => `pricing:${courtId}:${date}`,
  session: (token: string) => `session:${token}`,
};

// ─── SESSION ────────────────────────────────────────

export async function storeSession(
  kv: KVNamespace, token: string,
  data: { userId: string; type: "user" | "operator" }
): Promise<void> {
  const ttl = data.type === "operator" ? TTL.sessionOp : TTL.session;
  await kv.put(key.session(token), JSON.stringify(data), { expirationTtl: ttl });
}

export async function getSession(
  kv: KVNamespace, token: string
): Promise<{ userId: string; type: string } | null> {
  const raw = await kv.get(key.session(token));
  return raw ? JSON.parse(raw) : null;
}

export async function deleteSession(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(key.session(token));
}

// ─── MAPA (s ETag) ──────────────────────────────────

/**
 * Pokusí se vrátit cache mapy. Pokud klientův ETag odpovídá,
 * vrací { notModified: true } — klient nestahuje data znovu.
 */
export async function getMapCache(
  kv: KVNamespace, lat: number, lng: number, clientEtag: string | null
): Promise<{ notModified: boolean; data: unknown | null; etag: string | null }> {
  const geo = geohash(lat, lng, 6);
  const etag = await kv.get(key.mapEtag(geo));

  if (clientEtag && etag && clientEtag === etag) {
    return { notModified: true, data: null, etag };
  }

  const data = await kv.get(key.map(geo), "json");
  return { notModified: false, data, etag };
}

/**
 * Uloží data mapy do cache + vygeneruje nový ETag.
 */
export async function setMapCache(
  kv: KVNamespace, lat: number, lng: number, data: unknown
): Promise<string> {
  const geo = geohash(lat, lng, 6);
  const etag = await computeEtag(data);
  await Promise.all([
    kv.put(key.map(geo), JSON.stringify(data), { expirationTtl: TTL.map }),
    kv.put(key.mapEtag(geo), etag, { expirationTtl: TTL.map }),
  ]);
  return etag;
}

// ─── SLOTY ──────────────────────────────────────────

export async function getSlotsCache(
  kv: KVNamespace, courtId: string, date: string
): Promise<unknown | null> {
  return kv.get(key.slots(courtId, date), "json");
}

export async function setSlotsCache(
  kv: KVNamespace, courtId: string, date: string, data: unknown
): Promise<void> {
  await kv.put(key.slots(courtId, date), JSON.stringify(data), { expirationTtl: TTL.slots });
}

// ─── DETAIL SPORTOVIŠTĚ ─────────────────────────────

export async function getVenueCache(kv: KVNamespace, id: string): Promise<unknown | null> {
  return kv.get(key.venue(id), "json");
}

export async function setVenueCache(kv: KVNamespace, id: string, data: unknown): Promise<void> {
  await kv.put(key.venue(id), JSON.stringify(data), { expirationTtl: TTL.venue });
}

// ─── INVALIDACE (cílená) ────────────────────────────

/**
 * Po rezervaci/zrušení — invaliduje JEN dotčené klíče.
 * Nemaže celou cache, jen sloty kurtu + mapu jeho oblasti.
 */
export async function invalidateAfterBooking(
  kv: KVNamespace,
  params: { courtId: string; date: string; lat: number; lng: number }
): Promise<void> {
  const geo = geohash(params.lat, params.lng, 6);
  await Promise.all([
    kv.delete(key.slots(params.courtId, params.date)),
    kv.delete(key.pricing(params.courtId, params.date)),
    kv.delete(key.map(geo)),
    kv.delete(key.mapEtag(geo)),
    // venue detail NEMAŽEME — kurty a info se nezměnily
  ]);
}

/**
 * Po změně sportoviště provozovatelem — invaliduje detail + mapu.
 */
export async function invalidateVenue(
  kv: KVNamespace, venueId: string, lat: number, lng: number
): Promise<void> {
  const geo = geohash(lat, lng, 6);
  await Promise.all([
    kv.delete(key.venue(venueId)),
    kv.delete(key.map(geo)),
    kv.delete(key.mapEtag(geo)),
  ]);
}

// ─── ETag výpočet ───────────────────────────────────

async function computeEtag(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(json));
  const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 16)}"`; // zkrácený ETag v uvozovkách (HTTP standard)
}
