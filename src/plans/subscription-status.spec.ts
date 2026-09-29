import {
  downgradeGraceProductId,
  hasActiveSubscription,
  isWorkspaceOpen,
} from './subscription-status';

describe('hasActiveSubscription', () => {
  const plan = 'pri_01kr05y9cq25yt75ey1ddkpger';

  it('denies orgs with no plan', () => {
    expect(hasActiveSubscription(null)).toBe(false);
    expect(hasActiveSubscription(undefined)).toBe(false);
    expect(hasActiveSubscription({})).toBe(false);
    expect(hasActiveSubscription({ subscriptionStatus: 'active' })).toBe(false);
  });

  it('allows the statuses that are still being paid for', () => {
    for (const subscriptionStatus of ['active', 'trialing', 'past_due']) {
      expect(hasActiveSubscription({ plan, subscriptionStatus })).toBe(true);
    }
  });

  it('denies lapsed subscriptions even though plan is still set', () => {
    for (const subscriptionStatus of ['canceled', 'paused']) {
      expect(hasActiveSubscription({ plan, subscriptionStatus })).toBe(false);
    }
  });

  it('allows a plan granted by hand, with no Paddle status', () => {
    expect(hasActiveSubscription({ plan })).toBe(true);
  });

  it('denies a charged-back org whatever Paddle still reports', () => {
    expect(
      hasActiveSubscription({
        plan,
        subscriptionStatus: 'active',
        billingBlocked: true,
      }),
    ).toBe(false);
  });
});

describe('downgrade grace', () => {
  const agency = 'pro_agency';
  const now = Date.parse('2026-10-01T00:00:00Z');
  const future = new Date(now + 86_400_000);
  const past = new Date(now - 1);

  it('keeps the team tier until the paid-up period ends', () => {
    const team = { scheduledDowngrade: { until: future, productId: agency } };
    expect(downgradeGraceProductId(team, now)).toBe(agency);
  });

  it('ends exactly when the period does', () => {
    expect(
      downgradeGraceProductId({ scheduledDowngrade: { until: past, productId: agency } }, now),
    ).toBeUndefined();
  });

  it('is revoked by a chargeback like any other access', () => {
    expect(
      downgradeGraceProductId(
        { billingBlocked: true, scheduledDowngrade: { until: future, productId: agency } },
        now,
      ),
    ).toBeUndefined();
  });

  it('reads a stored ISO string the same as a Date', () => {
    expect(
      downgradeGraceProductId(
        { scheduledDowngrade: { until: future.toISOString(), productId: agency } },
        now,
      ),
    ).toBe(agency);
  });
});

describe('isWorkspaceOpen', () => {
  const plan = 'pri_team';

  it('always opens a personal workspace, plan or not', () => {
    expect(isWorkspaceOpen({ personal: true })).toBe(true);
    expect(isWorkspaceOpen({ personal: true, plan, subscriptionStatus: 'canceled' })).toBe(true);
  });

  it('opens a team only while it is paid for', () => {
    expect(isWorkspaceOpen({ personal: false, plan, subscriptionStatus: 'active' })).toBe(true);
    expect(isWorkspaceOpen({ personal: false, plan, subscriptionStatus: 'past_due' })).toBe(true);
    expect(isWorkspaceOpen({ personal: false, plan, subscriptionStatus: 'canceled' })).toBe(false);
    // A team org made at checkout that was never paid for.
    expect(isWorkspaceOpen({ personal: false })).toBe(false);
  });

  it('keeps a downgraded team open through its paid-up period', () => {
    const until = new Date(Date.now() + 60_000);
    expect(
      isWorkspaceOpen({ personal: false, scheduledDowngrade: { until, productId: 'pro_agency' } }),
    ).toBe(true);
  });

  it('shuts a team with a chargeback', () => {
    expect(
      isWorkspaceOpen({ personal: false, plan, subscriptionStatus: 'active', billingBlocked: true }),
    ).toBe(false);
  });

  it('treats a missing org as closed', () => {
    expect(isWorkspaceOpen(null)).toBe(false);
  });
});
