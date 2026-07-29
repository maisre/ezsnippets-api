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
