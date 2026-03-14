/**
 * License module: in-memory store (default) or Postgres store when DATABASE_URL is set
 */

import * as crypto from 'crypto';
import { loadLicenseConfig } from '../config/license-config';
import type {
  LicenseRecord,
  LicenseSeatAssignment,
  LicenseStore,
} from './types';

const uuid = (): string => crypto.randomUUID();

export class InMemoryLicenseStore implements LicenseStore {
  private records = new Map<string, LicenseRecord>();
  private byOrg = new Map<string, string>();
  private byHash = new Map<string, string>();
  private seats = new Map<string, LicenseSeatAssignment[]>();

  async findByOrg(organization: string): Promise<LicenseRecord | null> {
    const id = this.byOrg.get(organization);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  async findByLicenseHash(hash: string): Promise<LicenseRecord | null> {
    const id = this.byHash.get(hash);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  async findByLemonOrderId(orderId: number): Promise<LicenseRecord[]> {
    const out: LicenseRecord[] = [];
    for (const r of this.records.values()) {
      if (r.lemonOrderId === orderId) out.push(r);
    }
    return out;
  }

  async upsert(record: LicenseRecord): Promise<LicenseRecord> {
    const existing = this.records.get(record.id);
    if (existing) {
      this.byHash.delete(existing.licenseKeyHash);
    }
    this.records.set(record.id, record);
    this.byOrg.set(record.organization, record.id);
    this.byHash.set(record.licenseKeyHash, record.id);
    return record;
  }

  async update(id: string, patch: Partial<LicenseRecord>): Promise<LicenseRecord> {
    const current = this.records.get(id);
    if (!current) throw new Error(`License not found: ${id}`);
    const updated: LicenseRecord = { ...current, ...patch, updatedAt: new Date() };
    if (patch.organization !== undefined && patch.organization !== current.organization) {
      this.byOrg.delete(current.organization);
    }
    if (patch.licenseKeyHash !== undefined && patch.licenseKeyHash !== current.licenseKeyHash) {
      this.byHash.delete(current.licenseKeyHash);
    }
    this.records.set(id, updated);
    this.byOrg.set(updated.organization, id);
    if (patch.licenseKeyHash !== undefined) this.byHash.set(updated.licenseKeyHash, id);
    return updated;
  }

  async listSeats(licenseId: string): Promise<LicenseSeatAssignment[]> {
    return this.seats.get(licenseId) ?? [];
  }

  async addSeat(seat: LicenseSeatAssignment): Promise<void> {
    const list = this.seats.get(seat.licenseId) ?? [];
    if (list.some(s => s.userId === seat.userId && s.organization === seat.organization)) return;
    list.push(seat);
    this.seats.set(seat.licenseId, list);
  }

  async removeSeat(licenseId: string, userId: string): Promise<void> {
    const list = this.seats.get(licenseId) ?? [];
    const next = list.filter(s => s.userId !== userId);
    if (next.length < list.length) this.seats.set(licenseId, next);
  }
}

/** Factory: single shared store instance (in-memory or Postgres when DATABASE_URL is set) */
let defaultStore: LicenseStore | null = null;

export function getDefaultLicenseStore(): LicenseStore {
  if (defaultStore) return defaultStore;
  const config = loadLicenseConfig();
  const store: LicenseStore =
    config.databaseUrl && config.databaseUrl.trim()
      ? new (require('./postgres-store').PostgresLicenseStore)(config.databaseUrl.trim())
      : new InMemoryLicenseStore();
  defaultStore = store;
  return store;
}

export function createSeatAssignment(
  licenseId: string,
  organization: string,
  userId: string
): LicenseSeatAssignment {
  return {
    id: uuid(),
    licenseId,
    organization,
    userId,
    createdAt: new Date(),
  };
}

export function createLicenseRecord(partial: Partial<LicenseRecord>): LicenseRecord {
  const now = new Date();
  return {
    id: partial.id ?? uuid(),
    licenseKeyHash: partial.licenseKeyHash ?? '',
    lemonLicenseId: partial.lemonLicenseId ?? null,
    lemonOrderId: partial.lemonOrderId ?? null,
    lemonCustomerId: partial.lemonCustomerId ?? null,
    organization: partial.organization ?? '',
    status: partial.status ?? 'active',
    plan: partial.plan ?? 'default',
    seatsUsed: partial.seatsUsed ?? 0,
    seatsLimit: partial.seatsLimit ?? null,
    expiresAt: partial.expiresAt ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}
