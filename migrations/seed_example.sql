-- ============================================================
-- Ukázková testovací data — pro lokální vývoj
-- Spustit: npm run db:seed:local
-- ============================================================

-- Ukázkový provozovatel (heslo bude nastaveno přes API registraci)
INSERT INTO operators (id, email, password_hash, name, role, created_at)
VALUES ('op_test001', 'spravce@tkmohelnice.cz', 'PLACEHOLDER_HASH', 'Tomáš Václavek', 'admin', unixepoch());

-- Ukázkové sportoviště — TK Mohelnice
INSERT INTO venues (id, name, address, lat, lng, sport_types, open_hours, description, phone, status, created_at, updated_at)
VALUES (
  'ven_moh001',
  'TK Mohelnice',
  'Sportovní 1, Mohelnice',
  49.7765, 16.9176,
  '["tenis"]',
  '{"mo":"07:00-22:00","tu":"07:00-22:00","we":"07:00-22:00","th":"07:00-22:00","fr":"07:00-22:00","sa":"08:00-21:00","su":"08:00-21:00"}',
  'Tenisový klub s venkovními kurty a krytou halou. Celoroční provoz.',
  '739486989',
  'active',
  unixepoch(), unixepoch()
);

-- Propojení provozovatele se sportovištěm
INSERT INTO operator_venues (operator_id, venue_id)
VALUES ('op_test001', 'ven_moh001');

-- Kurty — venkovní (200 Kč) a hala (490 Kč)
INSERT INTO courts (id, venue_id, name, surface, is_covered, hourly_rate, member_rate, min_booking_minutes, sort_order, status)
VALUES
  ('crt_moh_v1', 'ven_moh001', 'Venkovní kurt 1', 'antuka', 0, 20000, 15000, 60, 1, 'active'),
  ('crt_moh_v2', 'ven_moh001', 'Venkovní kurt 2', 'antuka', 0, 20000, 15000, 60, 2, 'active'),
  ('crt_moh_h1', 'ven_moh001', 'Krytá hala',      'umely',  1, 49000, 40000, 60, 3, 'active');

-- Ukázkový zákazník
INSERT INTO users (id, email, name, consent_data, created_at)
VALUES ('usr_test001', 'hrac@example.cz', 'Jan Novák', 1, unixepoch());

-- Ukázkové členství
INSERT INTO club_memberships (id, user_id, venue_id, joined_at, status)
VALUES ('mem_test001', 'usr_test001', 'ven_moh001', unixepoch(), 'active');
