-- License store schema for Postgres (Supabase or any Postgres)
-- Run this in Supabase SQL Editor or: psql $DATABASE_URL -f scripts/license-schema.sql

-- License records: one row per activated license per organization
CREATE TABLE IF NOT EXISTS license_records (
  id VARCHAR(36) PRIMARY KEY,
  license_key_hash VARCHAR(64) NOT NULL UNIQUE,
  lemon_license_id INTEGER,
  lemon_order_id INTEGER,
  lemon_customer_id INTEGER,
  organization VARCHAR(2048) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  plan VARCHAR(256) NOT NULL,
  seats_used INTEGER NOT NULL DEFAULT 0,
  seats_limit INTEGER,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_license_records_org ON license_records(organization);
CREATE INDEX IF NOT EXISTS idx_license_records_hash ON license_records(license_key_hash);
CREATE INDEX IF NOT EXISTS idx_license_records_lemon_order ON license_records(lemon_order_id);

-- Seat assignments: one row per user/org using a license
CREATE TABLE IF NOT EXISTS license_seat_assignments (
  id VARCHAR(36) PRIMARY KEY,
  license_id VARCHAR(36) NOT NULL REFERENCES license_records(id) ON DELETE CASCADE,
  organization VARCHAR(2048) NOT NULL,
  user_id VARCHAR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(license_id, organization, user_id)
);

CREATE INDEX IF NOT EXISTS idx_license_seats_license_id ON license_seat_assignments(license_id);
