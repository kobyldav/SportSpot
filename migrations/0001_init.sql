-- ============================================================
-- Migrace 0001 — Základní schéma rezervační platformy
-- D1 (SQLite) — Cloudflare
--
-- Principy:
--  * Všechny ID jsou TEXT (nanoid) — krátké, unikátní, bez kolizí
--  * Ceny v HALÉŘÍCH (INTEGER) — 30000 = 300 Kč, žádné float chyby
--  * Časy jako Unix timestamp (INTEGER) nebo TEXT pro datum/čas
--  * Indexy na všech často dotazovaných polích
-- ============================================================

-- ─── UŽIVATELÉ (zákazníci) ──────────────────────────
CREATE TABLE users (
  id                      TEXT PRIMARY KEY,
  email                   TEXT NOT NULL UNIQUE,
  name                    TEXT,
  apple_id                TEXT UNIQUE,
  google_id               TEXT UNIQUE,
  password_hash           TEXT,                       -- jen pro email registraci
  stripe_customer_id      TEXT,                       -- ID u platební brány
  default_payment_method  TEXT,                       -- token uložené karty
  push_token              TEXT,                       -- FCM token pro notifikace
  phone                   TEXT,                       -- volitelné, opt-in
  consent_data            INTEGER NOT NULL DEFAULT 0, -- GDPR souhlas se zpracováním 0/1
  consent_marketing       INTEGER NOT NULL DEFAULT 0, -- souhlas s analytikou/marketingem
  created_at              INTEGER NOT NULL,
  deleted_at              INTEGER                     -- soft delete (GDPR výmaz)
);

-- ─── PROVOZOVATELÉ ──────────────────────────────────
CREATE TABLE operators (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  push_token      TEXT,
  totp_secret     TEXT,                       -- pro generování členských kódů
  role            TEXT NOT NULL DEFAULT 'admin', -- admin / staff
  created_at      INTEGER NOT NULL
);

-- ─── SPORTOVIŠTĚ ────────────────────────────────────
CREATE TABLE venues (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  address             TEXT,
  lat                 REAL NOT NULL,
  lng                 REAL NOT NULL,
  sport_types         TEXT NOT NULL DEFAULT '[]',  -- JSON: ["tenis","badminton"]
  open_hours          TEXT NOT NULL DEFAULT '{}',  -- JSON: {"mo":"07:00-22:00",...}
  description         TEXT,
  phone               TEXT,
  email               TEXT,
  photos              TEXT NOT NULL DEFAULT '[]',  -- JSON: pole R2 klíčů
  status              TEXT NOT NULL DEFAULT 'active', -- active/inactive/suspended
  etag                TEXT,                        -- hash pro cache invalidaci
  stripe_account_id   TEXT,                        -- Stripe Connect / GoPay sub-účet
  billing_info        TEXT NOT NULL DEFAULT '{}',  -- JSON: fakturační údaje
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- ─── VAZBA PROVOZOVATEL ↔ SPORTOVIŠTĚ (M:N) ─────────
-- Jeden provozovatel může spravovat více sportovišť
CREATE TABLE operator_venues (
  operator_id   TEXT NOT NULL,
  venue_id      TEXT NOT NULL,
  PRIMARY KEY (operator_id, venue_id),
  FOREIGN KEY (operator_id) REFERENCES operators(id) ON DELETE CASCADE,
  FOREIGN KEY (venue_id)    REFERENCES venues(id)    ON DELETE CASCADE
);

-- ─── KURTY ──────────────────────────────────────────
-- Každé sportoviště může mít více kurtů s vlastní cenou
CREATE TABLE courts (
  id                    TEXT PRIMARY KEY,
  venue_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,               -- "Kurt 1", "Krytá hala"
  surface               TEXT,                        -- antuka/umely/indoor/trava/beton
  is_covered            INTEGER NOT NULL DEFAULT 0,  -- 0/1 krytý kurt
  hourly_rate           INTEGER NOT NULL,            -- cena v haléřích (co chce provozovatel)
  member_rate           INTEGER,                     -- členská cena v haléřích (nullable)
  min_booking_minutes   INTEGER NOT NULL DEFAULT 60,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active', -- active/inactive
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

-- ─── REZERVACE (jádro systému) ──────────────────────
CREATE TABLE bookings (
  id                  TEXT PRIMARY KEY,            -- také se používá v QR kódu
  court_id            TEXT NOT NULL,
  venue_id            TEXT NOT NULL,               -- denormalizace pro rychlé statistiky
  user_id             TEXT NOT NULL,
  date                TEXT NOT NULL,               -- "2025-01-17"
  start_time          TEXT NOT NULL,               -- "17:00"
  end_time            TEXT NOT NULL,               -- "18:00"
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending / confirmed / active / completed
  -- cancelled_free / cancelled_partial / cancelled_no_refund / no_show

  -- Finanční rozpad (vše v haléřích)
  customer_price      INTEGER NOT NULL,            -- co zaplatil zákazník
  provider_amount     INTEGER NOT NULL,            -- co dostane provozovatel
  platform_fee        INTEGER NOT NULL,            -- čistý výnos platformy
  gateway_fee         INTEGER NOT NULL,            -- poplatek platební brány
  platform_pct        REAL,                        -- použité % provize (pro audit)

  -- Platba
  payment_provider    TEXT,                        -- gopay / stripe
  payment_intent_id   TEXT,                        -- pi_xxx / GoPay payment ID
  charge_id           TEXT,                        -- po dokončení
  payment_method      TEXT,                        -- qr / card / apple_pay / google_pay / tap_to_pay

  -- Členství a QR
  is_member_price     INTEGER NOT NULL DEFAULT 0,  -- 0/1
  qr_hmac             TEXT,                         -- podpis QR kódu
  qr_validated_at     INTEGER,                      -- timestamp naskenování

  -- Přečas a storno
  overtime_charge     INTEGER NOT NULL DEFAULT 0,
  cancel_reason       TEXT,

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  FOREIGN KEY (court_id) REFERENCES courts(id),
  FOREIGN KEY (venue_id) REFERENCES venues(id),
  FOREIGN KEY (user_id)  REFERENCES users(id)
);

-- ─── ČLENSTVÍ VE SPOLKU ─────────────────────────────
CREATE TABLE club_memberships (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  venue_id      TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active / cancelled
  cancelled_by  TEXT,                            -- user / operator / null
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
);

-- ─── BLOKOVANÉ TERMÍNY ──────────────────────────────
CREATE TABLE slots_blocked (
  id            TEXT PRIMARY KEY,
  court_id      TEXT NOT NULL,
  date_from     TEXT NOT NULL,                   -- "2025-01-17"
  date_to       TEXT NOT NULL,
  time_from     TEXT,                            -- null = celý den
  time_to       TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
);

-- ─── AKTIVITNÍ LOG (analytika) ──────────────────────
-- Sbíráno se souhlasem, anonymizovatelné, pro budoucí monetizaci
CREATE TABLE user_activity_log (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,                        -- nullable pro anonymizaci
  sport_type        TEXT,
  venue_id          TEXT,
  court_id          TEXT,
  day_of_week       INTEGER,                     -- 0=Ne, 6=So
  hour              INTEGER,                     -- 0-23
  duration_minutes  INTEGER,
  price_paid        INTEGER,                     -- haléře
  used_discount     INTEGER NOT NULL DEFAULT 0,  -- 0/1
  is_member         INTEGER NOT NULL DEFAULT 0,  -- 0/1
  is_group          INTEGER NOT NULL DEFAULT 0,  -- 0/1
  created_at        INTEGER NOT NULL
);

-- ============================================================
-- INDEXY — kritické pro výkon a šetření D1 operací
-- ============================================================

-- Vyhledávání sportovišť v geografické oblasti (bounding box)
CREATE INDEX idx_venues_geo ON venues(lat, lng);
CREATE INDEX idx_venues_status ON venues(status);

-- Kurty daného sportoviště
CREATE INDEX idx_courts_venue ON courts(venue_id, status);

-- NEJDŮLEŽITĚJŠÍ — zabraňuje dvojí rezervaci stejného slotu
-- Unikátní index na (kurt, datum, čas) pro nezrušené rezervace
CREATE UNIQUE INDEX idx_bookings_slot_unique
  ON bookings(court_id, date, start_time)
  WHERE status NOT IN ('cancelled_free','cancelled_partial','cancelled_no_refund');

-- Obsazenost sportoviště pro mapu
CREATE INDEX idx_bookings_venue_date ON bookings(venue_id, date, status);

-- Rezervace zákazníka (jeho historie)
CREATE INDEX idx_bookings_user ON bookings(user_id, status);

-- Faktury a statistiky podle data vytvoření
CREATE INDEX idx_bookings_created ON bookings(created_at, status);

-- Členství — unikátní vazba zákazník-spolek
CREATE UNIQUE INDEX idx_membership_unique
  ON club_memberships(user_id, venue_id);

-- Blokované termíny kurtu
CREATE INDEX idx_blocked_court ON slots_blocked(court_id, date_from, date_to);

-- Aktivitní log pro analytiku
CREATE INDEX idx_activity_created ON user_activity_log(created_at);
CREATE INDEX idx_activity_venue ON user_activity_log(venue_id, sport_type);
