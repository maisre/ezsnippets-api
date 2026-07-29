import * as mongoose from 'mongoose';

/** Single-document collection — there is only ever one catalog. */
export const CATALOG_DOC_ID = 'catalog';

/**
 * A Paddle price, flattened to the fields the pricing page is built from.
 *
 * Deliberately the *input* to the mapping rather than the finished plans:
 * entitlement limits, display copy, and tier mapping all live in code, so a
 * deploy that changes plan-catalog.ts takes effect against the stored prices
 * immediately instead of waiting for the next refresh.
 */
export interface StoredPrice {
  id: string;
  productId: string;
  status: string;
  createdAt: string;
  billingCycle: { interval: string; frequency: number } | null;
  trialPeriod: { interval: string; frequency: number } | null;
  unitPrice: { amount: string; currencyCode: string } | null;
  customData: Record<string, unknown> | null;
}

export interface PaddleCatalogDoc {
  _id: string;
  prices: StoredPrice[];
  fetchedAt?: Date;
  /** Held by whichever instance is currently refreshing — see acquireLease. */
  refreshLeaseUntil?: Date;
}

export const PaddleCatalogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: CATALOG_DOC_ID },
    prices: { type: [mongoose.Schema.Types.Mixed], default: [] },
    fetchedAt: { type: Date },
    refreshLeaseUntil: { type: Date },
  },
  { versionKey: false },
);
