/**
 * Úložiště nad R2.
 *
 * Organizace klíčů:
 *   qr/{bookingId}.png        — QR kódy rezervací
 *   photos/{venueId}/{n}.jpg  — fotky sportovišť
 *   invoices/{venueId}/{ym}.pdf — měsíční faktury
 *
 * R2 je S3-kompatibilní, free tier 10 GB + 1M operací/měsíc.
 */

// ─── QR KÓDY ────────────────────────────────────────

export async function storeQrCode(
  r2: R2Bucket, bookingId: string, pngData: ArrayBuffer | Uint8Array
): Promise<string> {
  const path = `qr/${bookingId}.png`;
  await r2.put(path, pngData, {
    httpMetadata: { contentType: "image/png" },
  });
  return path;
}

export async function getQrCode(r2: R2Bucket, bookingId: string): Promise<R2ObjectBody | null> {
  return r2.get(`qr/${bookingId}.png`);
}

export async function deleteQrCode(r2: R2Bucket, bookingId: string): Promise<void> {
  await r2.delete(`qr/${bookingId}.png`);
}

// ─── FOTKY SPORTOVIŠŤ ───────────────────────────────

export async function storeVenuePhoto(
  r2: R2Bucket, venueId: string, index: number,
  imageData: ArrayBuffer | Uint8Array, contentType = "image/jpeg"
): Promise<string> {
  const path = `photos/${venueId}/${index}.jpg`;
  await r2.put(path, imageData, {
    httpMetadata: { contentType },
  });
  return path;
}

export async function getVenuePhoto(r2: R2Bucket, path: string): Promise<R2ObjectBody | null> {
  return r2.get(path);
}

/**
 * Smaže všechny fotky sportoviště (při deaktivaci).
 */
export async function deleteVenuePhotos(r2: R2Bucket, venueId: string): Promise<void> {
  const list = await r2.list({ prefix: `photos/${venueId}/` });
  await Promise.all(list.objects.map(obj => r2.delete(obj.key)));
}

// ─── FAKTURY ────────────────────────────────────────

export async function storeInvoice(
  r2: R2Bucket, venueId: string, yearMonth: string, pdfData: ArrayBuffer | Uint8Array
): Promise<string> {
  const path = `invoices/${venueId}/${yearMonth}.pdf`;
  await r2.put(path, pdfData, {
    httpMetadata: { contentType: "application/pdf" },
  });
  return path;
}

export async function getInvoice(
  r2: R2Bucket, venueId: string, yearMonth: string
): Promise<R2ObjectBody | null> {
  return r2.get(`invoices/${venueId}/${yearMonth}.pdf`);
}

/**
 * Pomocná funkce — vrátí R2 objekt jako HTTP Response s cache hlavičkami.
 * Použití v endpointu který servíruje QR/fotky.
 */
export function r2ToResponse(obj: R2ObjectBody, cacheSeconds = 3600): Response {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("cache-control", `public, max-age=${cacheSeconds}`);
  return new Response(obj.body, { headers });
}
