import { PaddleCatalogService } from './paddle-catalog.service';
import { PRODUCT_IDS } from './plan-catalog';
import { CATALOG_DOC_ID, StoredPrice } from './schemas/paddle-catalog.schema';

jest.mock('@sentry/nestjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const BASIC_PRODUCT = PRODUCT_IDS.sandbox.Basic;
const PRO_PRODUCT = PRODUCT_IDS.sandbox.Pro;
const PRO_MONTHLY = 'pri_pro_monthly';
const PRO_YEARLY = 'pri_pro_yearly';
const BASIC_MONTHLY = 'pri_basic_monthly';

/** A Paddle price as the SDK hands it to us (before flattening). */
function sdkPrice(overrides: Partial<any> = {}): any {
  return {
    id: PRO_MONTHLY,
    productId: PRO_PRODUCT,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    billingCycle: { interval: 'month', frequency: 1 },
    trialPeriod: null,
    unitPrice: { amount: '2500', currencyCode: 'USD' },
    customData: { display: true },
    ...overrides,
  };
}

/** A price as it sits in Mongo. */
function stored(overrides: Partial<StoredPrice> = {}): StoredPrice {
  const p = sdkPrice(overrides);
  return { ...p, ...overrides } as StoredPrice;
}

function collectionOf(prices: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of prices) yield p;
    },
  };
}

/**
 * Enough of a Mongoose model to exercise the read/lease/write paths, with the
 * stored doc exposed so tests can assert it survived a bad refresh.
 */
function fakeModel(initial: any = null) {
  const state: { doc: any } = { doc: initial };
  let leaseHeldByOther = false;

  return {
    state,
    holdLeaseElsewhere: () => (leaseHeldByOther = true),
    findById: jest.fn(() => ({
      lean: () => ({ exec: async () => state.doc }),
    })),
    updateOne: jest.fn((filter: any, update: any, opts: any = {}) => ({
      exec: async () => {
        const set = update.$set ?? {};
        const unset = update.$unset ?? {};
        const setOnInsert = update.$setOnInsert ?? {};

        if (!state.doc) {
          if (opts.upsert) {
            state.doc = { _id: CATALOG_DOC_ID, ...setOnInsert, ...set };
            return { modifiedCount: 0, upsertedCount: 1 };
          }
          return { modifiedCount: 0, upsertedCount: 0 };
        }

        // Simulate another instance holding the refresh lease.
        if (filter.$or && leaseHeldByOther) {
          return { modifiedCount: 0, upsertedCount: 0 };
        }

        Object.assign(state.doc, set);
        for (const key of Object.keys(unset)) delete state.doc[key];
        return { modifiedCount: 1, upsertedCount: 0 };
      },
    })),
  };
}

function build(prices: any[] | Error, initialDoc: any = null, products: any[] = []) {
  const model = fakeModel(initialDoc);
  const paddle = {
    products: { list: jest.fn(() => collectionOf(products)) },
    prices: {
      list: jest.fn(() => {
        if (prices instanceof Error) throw prices;
        return collectionOf(prices);
      }),
    },
  };
  const service = new PaddleCatalogService(paddle as any, 'sandbox', model as any);
  return { service, model, paddle };
}

/** Same, but pointed at an arbitrary environment for the startup check. */
function buildForEnv(env: any, products: any[] = []) {
  const model = fakeModel(null);
  const paddle = {
    products: { list: jest.fn(() => collectionOf(products)) },
    prices: { list: jest.fn(() => collectionOf([])) },
  };
  const service = new PaddleCatalogService(paddle as any, env, model as any);
  return { service, model, paddle };
}

describe('PaddleCatalogService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('building plans', () => {
    it('includes only prices flagged for display in Paddle', async () => {
      const { service } = build([
        sdkPrice({ id: PRO_MONTHLY }),
        sdkPrice({ id: BASIC_MONTHLY, productId: BASIC_PRODUCT, customData: null }),
      ]);

      const catalog = await service.getCatalog();
      expect(catalog.source).toBe('live');
      expect(catalog.plans.map((p) => p.name)).toEqual(['Pro']);
    });

    it('accepts a stringified flag, since the dashboard stores text', async () => {
      const { service } = build([sdkPrice({ customData: { display: 'true' } })]);
      expect((await service.getCatalog()).plans).toHaveLength(1);
    });

    it('rejects anything that is not an actual true', async () => {
      for (const customData of [
        { dsiplay: true },
        { display: 'yes' },
        { display: 1 },
        { display: false },
        {},
      ]) {
        const { service } = build([sdkPrice({ customData })]);
        expect((await service.getCatalog()).plans).toHaveLength(0);
      }
    });

    it('refuses a flagged price whose product has no entitlement mapping', async () => {
      const { service } = build([
        sdkPrice({ id: 'pri_mystery', productId: 'prd_mystery' }),
      ]);
      expect((await service.getCatalog()).plans).toHaveLength(0);
    });

    it('buckets monthly and yearly prices under one plan', async () => {
      const { service } = build([
        sdkPrice({ id: PRO_MONTHLY }),
        sdkPrice({
          id: PRO_YEARLY,
          billingCycle: { interval: 'year', frequency: 1 },
          unitPrice: { amount: '25000', currencyCode: 'USD' },
        }),
      ]);

      const [pro] = (await service.getCatalog()).plans;
      expect(pro.prices.month?.amount).toBe('25.00');
      expect(pro.prices.year?.amount).toBe('250.00');
    });

    it('keeps the newer price when two are flagged for the same interval', async () => {
      const { service } = build([
        sdkPrice({ id: 'pri_old', createdAt: '2025-01-01T00:00:00Z' }),
        sdkPrice({ id: 'pri_new', createdAt: '2026-06-01T00:00:00Z' }),
      ]);

      const [pro] = (await service.getCatalog()).plans;
      expect(pro.prices.month?.id).toBe('pri_new');
    });

    it('carries the trial period through', async () => {
      const { service } = build([
        sdkPrice({ trialPeriod: { interval: 'day', frequency: 14 } }),
      ]);

      const [pro] = (await service.getCatalog()).plans;
      expect(pro.prices.month?.trial).toEqual({
        interval: 'day',
        frequency: 14,
      });
    });

    it('orders plans least to most generous, not however Paddle returned them', async () => {
      const { service } = build([
        sdkPrice({ id: PRO_MONTHLY }),
        sdkPrice({ id: BASIC_MONTHLY, productId: BASIC_PRODUCT }),
      ]);

      expect((await service.getCatalog()).plans.map((p) => p.name)).toEqual([
        'Basic',
        'Pro',
      ]);
    });
  });

  describe('storage and freshness', () => {
    const freshDoc = () => ({
      _id: CATALOG_DOC_ID,
      prices: [stored()],
      fetchedAt: new Date(),
    });

    const staleDoc = () => ({
      _id: CATALOG_DOC_ID,
      prices: [stored()],
      fetchedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    it('serves a fresh stored catalog without calling Paddle', async () => {
      const { service, paddle } = build([sdkPrice()], freshDoc());

      const catalog = await service.getCatalog();
      expect(catalog.source).toBe('cache');
      expect(paddle.prices.list).not.toHaveBeenCalled();
    });

    it('serves stale data immediately and refreshes behind it', async () => {
      const { service, paddle } = build([sdkPrice()], staleDoc());

      const catalog = await service.getCatalog();
      expect(catalog.source).toBe('cache');
      expect(catalog.plans).toHaveLength(1);
      await new Promise((r) => setImmediate(r));
      expect(paddle.prices.list).toHaveBeenCalled();
    });

    it('stores what it fetched on a cold start', async () => {
      const { service, model } = build([sdkPrice()]);

      await service.getCatalog();
      expect(model.state.doc.prices).toHaveLength(1);
      expect(model.state.doc.fetchedAt).toBeInstanceOf(Date);
    });

    it('reports unavailable when Paddle fails with nothing stored', async () => {
      const { service } = build(new Error('paddle down'));
      expect(await service.getCatalog()).toEqual({
        plans: [],
        source: 'unavailable',
      });
    });

    it('keeps serving the stored catalog when a refresh fails', async () => {
      const { service, model, paddle } = build([sdkPrice()], staleDoc());
      paddle.prices.list.mockImplementation(() => {
        throw new Error('paddle down');
      });

      const catalog = await service.getCatalog();
      expect(catalog.plans).toHaveLength(1);
      await new Promise((r) => setImmediate(r));
      // A failed read must never destroy a good catalog.
      expect(model.state.doc.prices).toHaveLength(1);
    });

    it('never overwrites a stored catalog with an empty read', async () => {
      const { service, model, paddle } = build([sdkPrice()], staleDoc());
      paddle.prices.list.mockImplementation(() => collectionOf([]));

      await service.getCatalog();
      await new Promise((r) => setImmediate(r));
      expect(model.state.doc.prices).toHaveLength(1);
    });

    it('skips the refresh when another instance holds the lease', async () => {
      const { service, model, paddle } = build([sdkPrice()], staleDoc());
      model.holdLeaseElsewhere();

      await service.invalidate();
      expect(paddle.prices.list).not.toHaveBeenCalled();
    });

    it('marks the catalog stale when it loses the lease, so the webhook still lands', async () => {
      const doc = { ...freshDoc() };
      const { service, model } = build([sdkPrice()], doc);
      model.holdLeaseElsewhere();

      await service.invalidate();

      // fetchedAt cleared => the next read refreshes, rather than the webhook
      // silently doing nothing for a full TTL.
      expect(model.state.doc.fetchedAt).toBeUndefined();
    });

    it('does not mark stale when Paddle itself failed', async () => {
      const { service, model, paddle } = build([sdkPrice()], freshDoc());
      paddle.prices.list.mockImplementation(() => {
        throw new Error('paddle down');
      });

      await service.invalidate();

      // Marking stale here would make every read retry a dead API.
      expect(model.state.doc.fetchedAt).toBeInstanceOf(Date);
    });

    it('refreshes on invalidate without waiting for the TTL', async () => {
      const { service, paddle } = build([sdkPrice()], freshDoc());

      await service.invalidate();
      expect(paddle.prices.list).toHaveBeenCalled();
    });
  });
});

describe('product id startup check', () => {
  const Sentry = require('@sentry/nestjs');
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => jest.clearAllMocks());

  it('passes silently when every configured product is active', async () => {
    const { service } = buildForEnv('sandbox', [
      { id: PRODUCT_IDS.sandbox.Basic },
      { id: PRODUCT_IDS.sandbox.Pro },
      { id: PRODUCT_IDS.sandbox.Enterprise },
    ]);

    service.onModuleInit();
    await settle();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('alerts when a configured product is not active in the account', async () => {
    // The "deployed to production with sandbox ids" shape: ids are set, but
    // the account we are pointed at has never heard of them.
    const { service } = buildForEnv('sandbox', []);

    service.onModuleInit();
    await settle();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('not active in the sandbox account'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('alerts when a tier has no product id configured at all', async () => {
    const { service } = buildForEnv('production');

    service.onModuleInit();
    await settle();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('No Paddle product id set'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('does not cry wolf when Paddle itself is unreachable', async () => {
    const { service, paddle } = buildForEnv('sandbox');
    paddle.products.list.mockImplementation(() => {
      throw new Error('paddle down');
    });

    service.onModuleInit();
    await settle();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
