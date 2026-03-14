/**
 * License module: Postgres-backed store (optional, when DATABASE_URL is set)
 */

import { Pool } from 'pg';
import type { LicenseRecord, LicenseSeatAssignment, LicenseStore } from './types';

const LICENSES_TABLE = 'license_records';
const SEATS_TABLE = 'license_seat_assignments';

export class PostgresLicenseStore implements LicenseStore {
  private pool: Pool;
  private tablesReady: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  private async ensureTables(): Promise<void> {
    if (this.tablesReady) {
      await this.tablesReady;
      return;
    }
    this.tablesReady = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${LICENSES_TABLE} (
            id VARCHAR(36) PRIMARY KEY,
            license_key_hash VARCHAR(64) NOT NULL UNIQUE,
            lemon_license_id INTEGER,
            lemon_order_id INTEGER,
            lemon_customer_id INTEGER,
            organization VARCHAR(2048) NOT NULL,
            status VARCHAR(32) NOT NULL,
            plan VARCHAR(256) NOT NULL,
            seats_used INTEGER NOT NULL DEFAULT 0,
            seats_limit INTEGER,
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_license_records_org ON ${LICENSES_TABLE}(organization);
          CREATE INDEX IF NOT EXISTS idx_license_records_hash ON ${LICENSES_TABLE}(license_key_hash);
          CREATE INDEX IF NOT EXISTS idx_license_records_lemon_order ON ${LICENSES_TABLE}(lemon_order_id);

          CREATE TABLE IF NOT EXISTS ${SEATS_TABLE} (
            id VARCHAR(36) PRIMARY KEY,
            license_id VARCHAR(36) NOT NULL REFERENCES ${LICENSES_TABLE}(id) ON DELETE CASCADE,
            organization VARCHAR(2048) NOT NULL,
            user_id VARCHAR(512) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(license_id, organization, user_id)
          );
          CREATE INDEX IF NOT EXISTS idx_license_seats_license_id ON ${SEATS_TABLE}(license_id);
        `);
      } finally {
        client.release();
      }
    })().catch((error) => {
      this.tablesReady = null;
      throw error;
    });
    await this.tablesReady;
  }

  private rowToRecord(row: Record<string, unknown>): LicenseRecord {
    return {
      id: row.id as string,
      licenseKeyHash: row.license_key_hash as string,
      lemonLicenseId: row.lemon_license_id as number | null,
      lemonOrderId: row.lemon_order_id as number | null,
      lemonCustomerId: row.lemon_customer_id as number | null,
      organization: row.organization as string,
      status: row.status as LicenseRecord['status'],
      plan: row.plan as string,
      seatsUsed: Number(row.seats_used) || 0,
      seatsLimit: row.seats_limit != null ? Number(row.seats_limit) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private rowToSeat(row: Record<string, unknown>): LicenseSeatAssignment {
    return {
      id: row.id as string,
      licenseId: row.license_id as string,
      organization: row.organization as string,
      userId: row.user_id as string,
      createdAt: new Date(row.created_at as string),
    };
  }

  async findByOrg(organization: string): Promise<LicenseRecord | null> {
    await this.ensureTables();
    const res = await this.pool.query(
      `SELECT * FROM ${LICENSES_TABLE} WHERE organization = $1`,
      [organization]
    );
    if (res.rows.length === 0) return null;
    return this.rowToRecord(res.rows[0]);
  }

  async findByLicenseHash(hash: string): Promise<LicenseRecord | null> {
    await this.ensureTables();
    const res = await this.pool.query(
      `SELECT * FROM ${LICENSES_TABLE} WHERE license_key_hash = $1`,
      [hash]
    );
    if (res.rows.length === 0) return null;
    return this.rowToRecord(res.rows[0]);
  }

  async findByLemonOrderId(orderId: number): Promise<LicenseRecord[]> {
    await this.ensureTables();
    const res = await this.pool.query(
      `SELECT * FROM ${LICENSES_TABLE} WHERE lemon_order_id = $1`,
      [orderId]
    );
    return res.rows.map((r) => this.rowToRecord(r));
  }

  async upsert(record: LicenseRecord): Promise<LicenseRecord> {
    await this.ensureTables();
    const now = new Date();
    await this.pool.query(
      `INSERT INTO ${LICENSES_TABLE} (
        id, license_key_hash, lemon_license_id, lemon_order_id, lemon_customer_id,
        organization, status, plan, seats_used, seats_limit, expires_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET
        license_key_hash = EXCLUDED.license_key_hash,
        lemon_license_id = EXCLUDED.lemon_license_id,
        lemon_order_id = EXCLUDED.lemon_order_id,
        lemon_customer_id = EXCLUDED.lemon_customer_id,
        organization = EXCLUDED.organization,
        status = EXCLUDED.status,
        plan = EXCLUDED.plan,
        seats_used = EXCLUDED.seats_used,
        seats_limit = EXCLUDED.seats_limit,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.licenseKeyHash,
        record.lemonLicenseId,
        record.lemonOrderId,
        record.lemonCustomerId,
        record.organization,
        record.status,
        record.plan,
        record.seatsUsed,
        record.seatsLimit,
        record.expiresAt?.toISOString() ?? null,
        (record.createdAt ?? now).toISOString(),
        now.toISOString(),
      ]
    );
    return { ...record, updatedAt: now };
  }

  async update(id: string, patch: Partial<LicenseRecord>): Promise<LicenseRecord> {
    await this.ensureTables();
    const current = await this.pool.query(`SELECT * FROM ${LICENSES_TABLE} WHERE id = $1`, [id]);
    if (current.rows.length === 0) throw new Error(`License not found: ${id}`);
    const existing = this.rowToRecord(current.rows[0]);
    const updated: LicenseRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date(),
    };
    await this.pool.query(
      `UPDATE ${LICENSES_TABLE} SET
        license_key_hash = $2, lemon_license_id = $3, lemon_order_id = $4, lemon_customer_id = $5,
        organization = $6, status = $7, plan = $8, seats_used = $9, seats_limit = $10,
        expires_at = $11, updated_at = $12
      WHERE id = $1`,
      [
        id,
        updated.licenseKeyHash,
        updated.lemonLicenseId,
        updated.lemonOrderId,
        updated.lemonCustomerId,
        updated.organization,
        updated.status,
        updated.plan,
        updated.seatsUsed,
        updated.seatsLimit,
        updated.expiresAt?.toISOString() ?? null,
        updated.updatedAt.toISOString(),
      ]
    );
    return updated;
  }

  async listSeats(licenseId: string): Promise<LicenseSeatAssignment[]> {
    await this.ensureTables();
    const res = await this.pool.query(
      `SELECT * FROM ${SEATS_TABLE} WHERE license_id = $1`,
      [licenseId]
    );
    return res.rows.map((r) => this.rowToSeat(r));
  }

  async addSeat(seat: LicenseSeatAssignment): Promise<void> {
    await this.ensureTables();
    await this.pool.query(
      `INSERT INTO ${SEATS_TABLE} (id, license_id, organization, user_id, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (license_id, organization, user_id) DO NOTHING`,
      [
        seat.id,
        seat.licenseId,
        seat.organization,
        seat.userId,
        seat.createdAt.toISOString(),
      ]
    );
  }

  async removeSeat(licenseId: string, userId: string): Promise<void> {
    await this.ensureTables();
    await this.pool.query(
      `DELETE FROM ${SEATS_TABLE} WHERE license_id = $1 AND user_id = $2`,
      [licenseId, userId]
    );
  }
}
