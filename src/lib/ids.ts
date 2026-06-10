/**
 * Generování unikátních ID — bez externí závislosti.
 * Používá Web Crypto (dostupné ve Workers nativně).
 *
 * Formát: prefix_xxxxxxxxxxxxxxxxxxxxx
 * Např. usr_V1StGXR8Z5jdHi6BmyT — krátké, URL-safe, prakticky bez kolizí.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Vygeneruje náhodné ID dané délky.
 */
function randomId(size = 21): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

/**
 * ID s prefixem podle typu entity.
 * Prefix usnadňuje debugging — hned vidíš o jaký objekt jde.
 */
export const newId = {
  user:       () => `usr_${randomId(18)}`,
  operator:   () => `op_${randomId(18)}`,
  venue:      () => `ven_${randomId(18)}`,
  court:      () => `crt_${randomId(18)}`,
  booking:    () => `bk_${randomId(20)}`,   // delší — používá se v QR
  membership: () => `mem_${randomId(18)}`,
  blocked:    () => `blk_${randomId(18)}`,
  activity:   () => `act_${randomId(18)}`,
};

/**
 * Geohash — převede lat/lng na krátký řetězec pro cache klíče.
 * Sportoviště blízko sebe spadnou do stejného "čtverce" → stejná cache.
 *
 * precision 6 ≈ čtverce ~1.2 km × 0.6 km
 */
export function geohash(lat: number, lng: number, precision = 6): string {
  const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let idx = 0, bit = 0, even = true;
  let hash = "";
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng > mid) { idx = idx * 2 + 1; lngMin = mid; }
      else { idx = idx * 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat > mid) { idx = idx * 2 + 1; latMin = mid; }
      else { idx = idx * 2; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

/**
 * Vypočítá bounding box pro vyhledávání v okruhu (km).
 * Vrací hranice lat/lng pro SQL WHERE.
 */
export function geoBounds(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 111;                      // 1° lat ≈ 111 km
  const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lngMin: lng - lngDelta,
    lngMax: lng + lngDelta,
  };
}
