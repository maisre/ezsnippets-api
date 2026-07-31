import * as Sentry from '@sentry/nestjs';
import {
  FALLBACK_TIER,
  PRODUCT_IDS,
  pickPlanRef,
  tierForProduct,
} from './plan-catalog';
import { PlansService } from './plans.service';

jest.mock('@sentry/nestjs', () => ({ captureMessage: jest.fn() }));

const SANDBOX_PRO = PRODUCT_IDS.sandbox.Pro;
const SANDBOX_BASIC = PRODUCT_IDS.sandbox.Basic;

describe('PlansService', () => {
  let service: PlansService;

  beforeEach(() => {
    service = new PlansService(undefined, 'sandbox');
    jest.clearAllMocks();
  });

  describe('findTier', () => {
    it('resolves a product to its tier', () => {
      expect(service.findTier(SANDBOX_PRO)?.name).toBe('Pro');
      expect(service.findTier(SANDBOX_BASIC)?.name).toBe('Basic');
    });

    it('returns null for an unknown or missing product', () => {
      expect(service.findTier('prd_nope')).toBeNull();
      expect(service.findTier(undefined)).toBeNull();
      expect(service.findTier('')).toBeNull();
    });

    // The point of keying on the product: a brand new price under an existing
    // product needs no code change at all, so there's nothing here to test
    // about prices — which is why priceIds no longer exist.
    it('is unaffected by which price was bought', () => {
      expect(service.findTier(SANDBOX_PRO)?.limits.maxPages).toBe(25);
    });
  });

  describe('environment separation', () => {
    it('does not resolve sandbox products when pointed at production', () => {
      const live = new PlansService(undefined, 'production');
      // The exact failure this design guards against: client on production,
      // entitlements still holding sandbox ids.
      expect(live.findTier(SANDBOX_PRO)).toBeNull();
    });

    it('keeps the two id sets distinct', () => {
      const sandboxIds = Object.values(PRODUCT_IDS.sandbox).filter(Boolean);
      const liveIds = Object.values(PRODUCT_IDS.production).filter(Boolean);
      const overlap = sandboxIds.filter((id) => liveIds.includes(id));
      expect(overlap).toEqual([]);
    });
  });

  describe('getLimits', () => {
    it('returns the tier limits for a known product', () => {
      expect(service.getLimits(SANDBOX_PRO).maxPages).toBe(25);
    });

    it('falls back to the least generous tier for an unmapped product', () => {
      expect(service.getLimits('prd_unmapped')).toEqual(FALLBACK_TIER.limits);
    });

    it('reports the unmapped product to Sentry rather than failing quietly', () => {
      service.getLimits('prd_unmapped');
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('prd_unmapped'),
        expect.objectContaining({ level: 'error' }),
      );
    });

    it('honours PLAN_LIMITS_OVERRIDE', () => {
      const overridden = new PlansService('2,1,10', 'sandbox');
      expect(overridden.getLimits(SANDBOX_PRO)).toEqual({
        maxPages: 2,
        maxLayouts: 1,
        maxSnippets: 10,
      });
    });
  });
});

describe('tierForProduct', () => {
  it('is scoped to the environment it is given', () => {
    expect(tierForProduct('sandbox', SANDBOX_PRO)?.name).toBe('Pro');
    expect(tierForProduct('production', SANDBOX_PRO)).toBeNull();
  });

  it('treats an unset product id as no match rather than a wildcard', () => {
    // production ids are empty until the live products exist; an empty
    // configured id must never match an empty/undefined lookup.
    expect(tierForProduct('production', '')).toBeNull();
    expect(tierForProduct('production', undefined)).toBeNull();
  });
});

describe('pickPlanRef', () => {
  const known = (ref: { productId?: string }) => ref.productId === SANDBOX_PRO;

  it('skips add-ons to find the item we recognise', () => {
    const ref = pickPlanRef(
      [
        { price: { id: 'pri_addon', productId: 'prd_addon' } },
        { price: { id: 'pri_pro', productId: SANDBOX_PRO } },
      ],
      known,
    );
    expect(ref.productId).toBe(SANDBOX_PRO);
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
