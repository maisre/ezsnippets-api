// Which Paddle subscription statuses still grant access.
//
// `past_due` is deliberately included: Paddle is still retrying the payment
// during dunning, and cutting a paying customer off mid-retry is worse than
// carrying them for a few days. When Paddle gives up it cancels the
// subscription, which lands here as `canceled` and does revoke access.
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

type SubscriptionFields = {
  plan?: string;
  subscriptionStatus?: string;
  billingBlocked?: boolean;
  personal?: boolean;
  scheduledDowngrade?: { until?: Date | string | null; productId?: string } | null;
};

// Type predicate: a true result also means `plan` is set, which is what the
// callers immediately go on to look limits up by.
export function hasActiveSubscription<T extends SubscriptionFields>(
  org: T | null | undefined,
): org is T & { plan: string } {
  if (!org?.plan) return false;
  // A chargeback means the money went back — access goes with it, whatever
  // Paddle still says the subscription's status is.
  if (org.billingBlocked) return false;
  // A plan with no status was granted by hand (comped account) — everything
  // that goes through Paddle gets a status on subscription.created.
  if (!org.subscriptionStatus) return true;
  return ENTITLED_STATUSES.has(org.subscriptionStatus);
}

/**
 * The product a team org is still paid up on after its owner downgraded it.
 *
 * Paddle can't schedule a plan change, so a downgrade moves the subscription
 * off the team straight away (billed as the lower tier from the next renewal)
 * and leaves `scheduledDowngrade` behind. Until `until` passes, the team keeps
 * the tier it already paid for this period. Undefined once it has passed.
 */
export function downgradeGraceProductId(
  org: SubscriptionFields | null | undefined,
  now = Date.now(),
): string | undefined {
  const grace = org?.scheduledDowngrade;
  if (!grace?.until || !grace.productId || org?.billingBlocked) return undefined;
  return new Date(grace.until).getTime() > now ? grace.productId : undefined;
}

/** Paying for itself now, or still inside a downgrade's paid-up period. */
export function hasPaidAccess(org: SubscriptionFields | null | undefined): boolean {
  return hasActiveSubscription(org) || !!downgradeGraceProductId(org);
}

/**
 * Can anyone use this workspace at all?
 *
 * A personal workspace always opens — without a plan it simply can't create
 * anything. A team workspace exists only while someone pays for it: once the
 * plan ends (downgrade takes effect, cancellation runs out, dunning gives up)
 * it is shut for every member, owner included. No read-only mode, no grace.
 * Buying the team plan again reopens it with its content intact.
 */
export function isWorkspaceOpen(org: SubscriptionFields | null | undefined): boolean {
  if (!org) return false;
  return !!org.personal || hasPaidAccess(org);
}
