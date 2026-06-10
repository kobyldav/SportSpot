/**
 * Typy pro Cloudflare bindings (z wrangler.jsonc) a datové modely.
 */

import type { CourtBooking } from "./durable/CourtBooking";

/**
 * Env — všechny bindings dostupné ve Workeru.
 * Odpovídá konfiguraci v wrangler.jsonc.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  SESSIONS: KVNamespace;
  CACHE: KVNamespace;
  STORAGE: R2Bucket;
  COURT_BOOKING: DurableObjectNamespace<CourtBooking>;

  // Secrets (nastavené přes wrangler secret put)
  JWT_SECRET: string;
  QR_HMAC_SECRET: string;
}

// ─── DATOVÉ MODELY (odpovídají tabulkám) ────────────

export interface User {
  id: string;
  email: string;
  name: string | null;
  apple_id: string | null;
  google_id: string | null;
  password_hash: string | null;
  stripe_customer_id: string | null;
  default_payment_method: string | null;
  push_token: string | null;
  phone: string | null;
  consent_data: number;
  consent_marketing: number;
  created_at: number;
  deleted_at: number | null;
}

export interface Operator {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  push_token: string | null;
  totp_secret: string | null;
  role: string;
  created_at: number;
}

export interface Venue {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  sport_types: string;     // JSON
  open_hours: string;      // JSON
  description: string | null;
  phone: string | null;
  email: string | null;
  photos: string;          // JSON
  status: string;
  etag: string | null;
  stripe_account_id: string | null;
  billing_info: string;    // JSON
  created_at: number;
  updated_at: number;
}

export interface Court {
  id: string;
  venue_id: string;
  name: string;
  surface: string | null;
  is_covered: number;
  hourly_rate: number;     // haléře
  member_rate: number | null;
  min_booking_minutes: number;
  sort_order: number;
  status: string;
}

export type BookingStatus =
  | "pending" | "confirmed" | "active" | "completed"
  | "cancelled_free" | "cancelled_partial" | "cancelled_no_refund" | "no_show";

export interface Booking {
  id: string;
  court_id: string;
  venue_id: string;
  user_id: string;
  date: string;
  start_time: string;
  end_time: string;
  status: BookingStatus;
  customer_price: number;
  provider_amount: number;
  platform_fee: number;
  gateway_fee: number;
  platform_pct: number | null;
  payment_provider: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  payment_method: string | null;
  is_member_price: number;
  qr_hmac: string | null;
  qr_validated_at: number | null;
  overtime_charge: number;
  cancel_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClubMembership {
  id: string;
  user_id: string;
  venue_id: string;
  joined_at: number;
  status: string;
  cancelled_by: string | null;
}
