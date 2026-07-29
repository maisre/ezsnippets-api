import { hasActiveSubscription } from './subscription-status';

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
