import * as Sentry from '@sentry/nestjs';
import { FALLBACK_TIER, PLAN_TIERS, pickPlanRef } from './plan-catalog';
import { PlansService } from './plans.service';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));

const BASIC_MONTHLY = PLAN_TIERS[0].priceIds[0];
const PRO_MONTHLY = PLAN_TIERS[1].priceIds[0];

describe('PlansService', () => {
  let service: PlansService;

  beforeEach(() => {
    service = new PlansService(undefined);
    jest.clearAllMocks();
  });

  describe('findTier', () => {
    // Product ids aren't filled in yet, so set them for the duration of these
    // tests rather than skipping the path that matters most.
    const withProductIds = (fn: () => void) => {
      PLAN_TIERS[0].productId = 'prd_basic';
      PLAN_TIERS[1].productId = 'prd_pro';
      try {
        fn();
      } finally {
        delete PLAN_TIERS[0].productId;
        delete PLAN_TIERS[1].productId;
      }
    };

    it('resolves by price id when no product id is mapped', () => {
      expect(service.findTier({ priceId: PRO_MONTHLY })?.name).toBe('Pro');
    });

    it('resolves by product id', () => {
      withProductIds(() => {
        expect(service.findTier({ productId: 'prd_pro' })?.name).toBe('Pro');
      });
    });

    it('entitles an unknown price under a known product — the whole point', () => {
      withProductIds(() => {
        const tier = service.findTier({
          productId: 'prd_pro',
          priceId: 'pri_a_new_price_nobody_told_us_about',
        });
        expect(tier?.name).toBe('Pro');
      });
    });

    it('prefers the product over the price when they disagree', () => {
      withProductIds(() => {
        const tier = service.findTier({
          productId: 'prd_pro',
          priceId: BASIC_MONTHLY,
        });
        expect(tier?.name).toBe('Pro');
      });
    });

    it('returns null when nothing matches', () => {
      expect(service.findTier({ productId: 'prd_nope' })).toBeNull();
      expect(service.findTier({})).toBeNull();
    });
  });

  describe('getLimits', () => {
    it('returns the tier limits for a known plan', () => {
      expect(service.getLimits({ priceId: PRO_MONTHLY })).toEqual(
        PLAN_TIERS[1].limits,
      );
    });

    it('falls back to the least generous tier for an unmapped product', () => {
      expect(service.getLimits({ productId: 'prd_unmapped' })).toEqual(
        FALLBACK_TIER.limits,
      );
    });

    it('reports the unmapped product to Sentry rather than failing quietly', () => {
      service.getLimits({ productId: 'prd_unmapped' });
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('prd_unmapped'),
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('honours PLAN_LIMITS_OVERRIDE', () => {
      const overridden = new PlansService('2,1,10');
      expect(overridden.getLimits({ priceId: PRO_MONTHLY })).toEqual({
        maxPages: 2,
        maxLayouts: 1,
        maxSnippets: 10,
      });
    });
  });
});

describe('pickPlanRef', () => {
  const known = (ref: { priceId?: string }) => ref.priceId === PRO_MONTHLY;

  it('skips add-ons to find the item we recognise', () => {
    const ref = pickPlanRef(
      [
        { price: { id: 'pri_addon', productId: 'prd_addon' } },
        { price: { id: PRO_MONTHLY, productId: 'prd_pro' } },
      ],
      known,
    );
    expect(ref.priceId).toBe(PRO_MONTHLY);
  });

  it('falls back to the first item when nothing is recognised', () => {
    const ref = pickPlanRef(
      [{ price: { id: 'pri_x', productId: 'prd_x' } }],
      known,
    );
    expect(ref).toEqual({ priceId: 'pri_x', productId: 'prd_x' });
  });

  it('survives an empty or missing item list', () => {
    expect(pickPlanRef([], known)).toEqual({
      priceId: undefined,
      productId: undefined,
    });
    expect(pickPlanRef(undefined, known)).toEqual({
      priceId: undefined,
      productId: undefined,
    });
  });
});
