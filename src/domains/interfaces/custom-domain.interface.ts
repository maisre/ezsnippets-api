import { Document } from 'mongoose';

export type CustomDomainStatus = 'pending' | 'active' | 'failed';

export interface CustomDomain extends Document {
  readonly id: string;
  readonly org: any;
  readonly hostname: string;
  readonly status: CustomDomainStatus;
  readonly lastError: string | null;
  readonly failureCount: number;
  readonly verifiedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly createdBy?: any;
}
