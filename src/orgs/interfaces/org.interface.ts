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

// A library snippet starred by someone in the org. The id is a snippet's
// ObjectId as a string — favorites are a pointer into the shared library, never
// a copy of it.
export interface FavoriteSnippet {
  snippetId: string;
  createdBy?: Types.ObjectId;
  addedAt?: Date;
}

/**
 * Left on a team org when its owner moves it down to a single-seat tier. The
 * subscription itself has already moved to the owner's personal org; this is
 * what keeps the team open until the period it paid for ends, and what undo
 * needs to move the subscription back. See PaymentsService.scheduleTeamDowngrade.
 */
export interface ScheduledDowngrade {
  /** End of the paid-up period. The team shuts when this passes. */
  until: Date;
  /** The team tier's product — what the team stays entitled to until then. */
  productId: string;
  /** The team price the subscription was on, for undo. */
  fromPriceId: string;
  /** The single-seat tier it moved to (display only). */
  toPlan: string;
  subscriptionId: string;
  personalOrgId: Types.ObjectId;
  /** A team custom domain the owner chose to carry over to their personal org. */
  keepDomainId?: Types.ObjectId;
  /** Set once the sweep has moved keepDomainId across. */
  domainCarriedAt?: Date;
  scheduledBy: Types.ObjectId;
  scheduledAt: Date;
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
  // Shared across the whole org, not per-member — see favorites.ts.
  favoriteSnippets?: FavoriteSnippet[];
  // occurred_at of the last subscription event applied. Paddle doesn't order
  // its webhooks, so this is how we drop ones that arrive late.
  subscriptionEventAt?: Date;
  scheduledDowngrade?: ScheduledDowngrade;
}
