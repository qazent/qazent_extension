/**
 * License module: shared types and DTOs
 */

export type LicenseStatus =
  | 'active'
  | 'expired'
  | 'none'
  | 'invalid'
  | 'suspended';

export interface LicenseStatusResponse {
  status: LicenseStatus;
  planName: string | null;
  expiresAt: string | null;
  message: string;
}

export interface LicenseActivateRequest {
  licenseKey: string;
  organization: string;
  userId: string;
}

export type LicenseActivateResponse = LicenseStatusResponse;

export interface LicenseRecord {
  id: string;
  licenseKeyHash: string;
  lemonLicenseId: number | null;
  lemonOrderId: number | null;
  lemonCustomerId: number | null;
  organization: string;
  status: LicenseStatus;
  plan: string;
  seatsUsed: number;
  seatsLimit: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LicenseSeatAssignment {
  id: string;
  licenseId: string;
  organization: string;
  userId: string;
  createdAt: Date;
}

export interface LicenseStore {
  findByOrg(organization: string): Promise<LicenseRecord | null>;
  findByLicenseHash(hash: string): Promise<LicenseRecord | null>;
  findByLemonOrderId(orderId: number): Promise<LicenseRecord[]>;
  bindOrganization(id: string, organization: string): Promise<LicenseRecord>;
  upsert(record: LicenseRecord): Promise<LicenseRecord>;
  update(id: string, patch: Partial<LicenseRecord>): Promise<LicenseRecord>;

  listSeats(licenseId: string): Promise<LicenseSeatAssignment[]>;
  addSeat(seat: LicenseSeatAssignment): Promise<void>;
  removeSeat(licenseId: string, userId: string): Promise<void>;
}
