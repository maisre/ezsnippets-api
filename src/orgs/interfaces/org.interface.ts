import { Document, Types } from 'mongoose';

export interface OrgMember {
  readonly user: Types.ObjectId;
  readonly role: 'owner' | 'admin' | 'member';
}

// A Paddle adjustment mirrored onto the org for support/debugging. Never
// returned by the API — see the toJSON transform in org.schema.ts.
export interface BillingEvent {
  action: string;
  amount: string;
  currency: string;
  status?: string;
  reason?: string;
  adjustmentId: string;
  transactionId?: string;
  occurredAt?: Date;
}

export interface Org extends Document {
  readonly name: string;
  readonly personal: boolean;
  readonly members: OrgMember[];
  paddleCustomerId?: string;
  subscriptionId?: string;
  /** Paddle price id — display and history. */
  plan?: string;
  /** Paddle product id — what entitlements are actually keyed on. */
  productId?: string;
  subscriptionStatus?: string;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: number;
  cardExpYear?: number;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  // Set when Paddle reports a chargeback against this org. Independent of
  // subscriptionStatus, which stays whatever Paddle says it is.
  billingBlocked?: boolean;
  billingEvents?: BillingEvent[];
  // occurred_at of the last subscription event applied. Paddle doesn't order
  // its webhooks, so this is how we drop ones that arrive late.
  subscriptionEventAt?: Date;
}
