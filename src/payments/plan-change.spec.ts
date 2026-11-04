import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentsService } from './payments.service';
import { PlansService } from '../plans/plans.service';
import { PRODUCT_IDS } from '../plans/plan-catalog';
import { switchGraceProductId } from '../plans/subscription-status';

const STARTER = PRODUCT_IDS.sandbox.Starter;
const PRO = PRODUCT_IDS.sandbox.Pro;
const AGENCY = PRODUCT_IDS.sandbox.Agency;
const PERIOD_END_ISO = new Date(Date.now() + 20 * 864e5).toISOString();

// Catalog prices the tests can ask for, by id.
const PRICES: Record<string, { productId: string; interval: 'month' | 'year'; trial?: boolean }> = {
  pri_starter_month: { productId: STARTER, interval: 'month', trial: true },
  pri_starter_year: { productId: STARTER, interval: 'year', trial: true },
  pri_pro_month: { productId: PRO, interval: 'month', trial: true },
  pri_pro_year: { productId: PRO, interval: 'year', trial: true },
  pri_agency_month: { productId: AGENCY, interval: 'month', trial: true },
};

function catalogPrice(id: string) {
  const p = PRICES[id];
  if (!p) throw new Error('not found');
  return {
    id,
    productId: p.productId,
    status: 'active',
    description: id,
    name: id,
    billingCycle: { interval: p.interval, frequency: 1 },
    trialPeriod: p.trial ? { interval: 'day', frequency: 7 } : null,
    unitPrice: { amount: '2000', currencyCode: 'USD' },
    unitPriceOverrides: [],
    taxMode: 'account_setting',
    quantity: { minimum: 1, maximum: 1 },
  };
}

const userId = new Types.ObjectId().toString();
const personalId = new Types.ObjectId();

function paddleSub(priceId: string, status = 'active') {
  const p = PRICES[priceId] ?? { productId: STARTER, interval: 'month' };
  return {
    id: 'sub_1',
    customerId: 'ctm_1',
    status,
    scheduledChange: null,
    billingCycle: { interval: p.interval, frequency: 1 },
    currentBillingPeriod: { endsAt: PERIOD_END_ISO },
    items: [{ price: { id: priceId, productId: p.productId, billingCycle: { interval: p.interval } } }],
  };
}

describe('PaymentsService single-seat plan changes and trial eligibility', () => {
  let personal: any;
  let teams: any[];
  let onPaddle: string; // the price the Paddle subscription is on
  let paddle: any;
  let orgs: any;
  let service: PaymentsService;

  beforeEach(() => {
    onPaddle = 'pri_starter_month';
    personal = {
      _id: personalId,
      id: String(personalId),
      personal: true,
      members: [{ user: new Types.ObjectId(userId), role: 'owner' }],
      subscriptionId: 'sub_1',
      plan: 'pri_starter_month',
      productId: STARTER,
      subscriptionStatus: 'active',
    };
    teams = [];
    paddle = {
      prices: { get: jest.fn(async (id: string) => catalogPrice(id)) },
      subscriptions: {
        get: jest.fn(async () => paddleSub(onPaddle, personal.subscriptionStatus)),
        update: jest.fn(async (_id: string, body: any) => {
          onPaddle = body.items[0].priceId;
          return paddleSub(onPaddle, personal.subscriptionStatus);
        }),
        previewUpdate: jest.fn(async () => ({
          immediateTransaction: {
            details: {
              totals: { grandTotal: '1089', currencyCode: 'USD' },
              // The outgoing item's credit — see assertCreditsPaidPeriod.
              lineItems: [{ totals: { total: '3266' } }, { totals: { total: '-2177' } }],
            },
          },
          nextTransaction: { details: { totals: { grandTotal: '3266', currencyCode: 'USD' } } },
          nextBilledAt: PERIOD_END_ISO,
          currencyCode: 'USD',
        })),
        list: jest.fn(() => ({ next: async () => [] })),
      },
      transactions: { create: jest.fn(async () => ({ id: 'txn_1' })) },
    };
    orgs = {
      findPersonalOrg: jest.fn(async () => personal),
      findTeamOrgsOwnedBy: jest.fn(async () => teams),
      updateSubscription: jest.fn(async (_id: string, data: any) => Object.assign(personal, data)),
      setScheduledSwitch: jest.fn(async (_id: string, s: any) => (personal.scheduledSwitch = s)),
      clearScheduledSwitch: jest.fn(async () => delete personal.scheduledSwitch),
      createTeamOrg: jest.fn(),
    };
    const plans = new PlansService(undefined, 'sandbox', orgs);
    service = new PaymentsService(
      paddle,
      'secret',
      'queue',
      {} as any,
      orgs,
      plans,
      {} as any,
      { sendMessage: jest.fn() } as any,
      {} as any,
    );
  });

  describe('changePlan', () => {
    it('upgrades Starter -> Pro now, prorated, refusing on a failed charge', async () => {
      const res = await service.changePlan(userId, 'pri_pro_month');
      expect(res.kind).toBe('upgrade');
      expect(paddle.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ priceId: 'pri_pro_month', quantity: 1 }],
        prorationBillingMode: 'prorated_immediately',
        onPaymentFailure: 'prevent_change',
      });
      expect(personal.productId).toBe(PRO);
    });

    it('refuses an upgrade Paddle would not credit (after a do_not_bill change this period)', async () => {
      paddle.subscriptions.previewUpdate = jest.fn(async () => ({
        immediateTransaction: {
          details: {
            totals: { grandTotal: '3266', currencyCode: 'USD' },
            lineItems: [{ totals: { total: '3266' } }],
          },
        },
      }));
      await expect(service.changePlan(userId, 'pri_pro_month')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'UPGRADE_AFTER_CHANGE' }),
      });
      expect(paddle.subscriptions.update).not.toHaveBeenCalled();
    });

    it('treats monthly -> yearly on the same tier as an upgrade', async () => {
      const res = await service.changePlan(userId, 'pri_starter_year');
      expect(res.kind).toBe('upgrade');
    });

    it('moves Pro -> Starter without billing and keeps Pro until the period ends', async () => {
      onPaddle = 'pri_pro_month';
      Object.assign(personal, { plan: 'pri_pro_month', productId: PRO });

      const res = await service.changePlan(userId, 'pri_starter_month');

      expect(res.kind).toBe('downgrade');
      expect(res.effectiveAt).toBe(PERIOD_END_ISO);
      expect(paddle.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ priceId: 'pri_starter_month', quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
      });
      expect(personal.productId).toBe(STARTER);
      expect(personal.scheduledSwitch).toMatchObject({
        subscriptionId: 'sub_1',
        productId: PRO,
        priceId: 'pri_pro_month',
        toProductId: STARTER,
      });
      const entitlement = await new PlansService(undefined, 'sandbox', orgs).entitlementFor(personal);
      expect(entitlement?.plan).toBe('Pro');
    });

    it('choosing the old plan again during the grace is an unbilled undo', async () => {
      onPaddle = 'pri_pro_month';
      Object.assign(personal, { plan: 'pri_pro_month', productId: PRO });
      await service.changePlan(userId, 'pri_starter_month');

      const res = await service.changePlan(userId, 'pri_pro_month');

      expect(res.kind).toBe('undo');
      expect(paddle.subscriptions.update).toHaveBeenLastCalledWith('sub_1', {
        items: [{ priceId: 'pri_pro_month', quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
      });
      expect(personal.scheduledSwitch).toBeUndefined();
    });

    it('cancelPlanSwitch puts the exact old price back without billing', async () => {
      onPaddle = 'pri_pro_month';
      Object.assign(personal, { plan: 'pri_pro_month', productId: PRO });
      await service.changePlan(userId, 'pri_starter_month');

      await expect(service.cancelPlanSwitch(userId)).resolves.toEqual({ plan: 'Pro' });
      expect(paddle.subscriptions.update).toHaveBeenLastCalledWith('sub_1', {
        items: [{ priceId: 'pri_pro_month', quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
      });
      expect(personal.scheduledSwitch).toBeUndefined();
    });

    it('during a trial swaps the item with do_not_bill so the trial carries on', async () => {
      personal.subscriptionStatus = 'trialing';
      const res = await service.changePlan(userId, 'pri_pro_month');
      expect(res.kind).toBe('trial');
      expect(paddle.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ priceId: 'pri_pro_month', quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
      });
      expect(personal.scheduledSwitch).toBeUndefined();
    });

    it('refuses yearly -> monthly', async () => {
      onPaddle = 'pri_starter_year';
      await expect(service.changePlan(userId, 'pri_starter_month')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(paddle.subscriptions.update).not.toHaveBeenCalled();
    });

    it('refuses a team price, the same price, and past_due / cancelling plans', async () => {
      await expect(service.changePlan(userId, 'pri_agency_month')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.changePlan(userId, 'pri_starter_month')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      personal.subscriptionStatus = 'past_due';
      await expect(service.changePlan(userId, 'pri_pro_month')).rejects.toBeInstanceOf(
        ConflictException,
      );
      personal.subscriptionStatus = 'active';
      personal.cancelAtPeriodEnd = true;
      await expect(service.changePlan(userId, 'pri_pro_month')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(paddle.subscriptions.update).not.toHaveBeenCalled();
    });

    it('refuses anything but undo while a switch is scheduled', async () => {
      onPaddle = 'pri_pro_month';
      Object.assign(personal, { plan: 'pri_pro_month', productId: PRO });
      await service.changePlan(userId, 'pri_starter_month');
      await expect(service.changePlan(userId, 'pri_starter_year')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SWITCH_SCHEDULED' }),
      });
    });
  });

  describe('switchGraceProductId', () => {
    const base = {
      plan: 'x',
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      productId: STARTER,
    };
    const grace = {
      subscriptionId: 'sub_1',
      until: new Date(Date.now() + 864e5),
      productId: PRO,
      toProductId: STARTER,
    };
    it('applies while the same subscription sits on the target product', () => {
      expect(switchGraceProductId({ ...base, scheduledSwitch: grace })).toBe(PRO);
    });
    it('lapses at `until`, on another subscription, product, or a dead plan', () => {
      expect(
        switchGraceProductId({ ...base, scheduledSwitch: { ...grace, until: new Date(Date.now() - 1) } }),
      ).toBeUndefined();
      expect(switchGraceProductId({ ...base, subscriptionId: 'sub_2', scheduledSwitch: grace })).toBeUndefined();
      expect(switchGraceProductId({ ...base, productId: AGENCY, scheduledSwitch: grace })).toBeUndefined();
      expect(
        switchGraceProductId({ ...base, subscriptionStatus: 'canceled', scheduledSwitch: grace }),
      ).toBeUndefined();
    });
  });

  describe('free trial once per customer', () => {
    beforeEach(() => {
      for (const f of ['subscriptionId', 'plan', 'productId', 'subscriptionStatus']) delete personal[f];
    });

    it('a brand-new customer checks out on the catalog price, trial included', async () => {
      await service.createCheckoutSession(userId, 'a@b.c', 'pri_pro_month');
      expect(paddle.transactions.create.mock.calls[0][0].items).toEqual([
        { priceId: 'pri_pro_month', quantity: 1 },
      ]);
      await expect(service.hasHadSubscription(userId)).resolves.toBe(false);
    });

    it.each([
      ['trialUsedAt', { trialUsedAt: new Date() }],
      ['a lapsed plan (legacy, no trialUsedAt)', { plan: 'pri_x', productId: PRO, subscriptionStatus: 'canceled' }],
    ])('someone with %s gets a no-trial copy of the same price', async (_label, fields) => {
      Object.assign(personal, fields);
      if (personal.subscriptionStatus === 'canceled') personal.subscriptionId = 'sub_old';
      await service.createCheckoutSession(userId, 'a@b.c', 'pri_pro_month');
      const [item] = paddle.transactions.create.mock.calls[0][0].items;
      expect(item.priceId).toBeUndefined();
      expect(item.price).toMatchObject({
        productId: PRO,
        unitPrice: { amount: '2000', currencyCode: 'USD' },
        billingCycle: { interval: 'month', frequency: 1 },
        trialPeriod: null,
      });
    });

    it('counts a team org they own', async () => {
      teams = [{ _id: new Types.ObjectId(), trialUsedAt: new Date(), members: [] }];
      await expect(service.hasHadSubscription(userId)).resolves.toBe(true);
    });

    it('asks Paddle about a known customer with nothing on record, and fails open', async () => {
      personal.paddleCustomerId = 'ctm_1';
      paddle.subscriptions.list = jest.fn(() => ({ next: async () => [{ id: 'sub_old' }] }));
      await expect(service.hasHadSubscription(userId)).resolves.toBe(true);
      expect(paddle.subscriptions.list).toHaveBeenCalledWith({ customerId: ['ctm_1'], perPage: 1 });

      paddle.subscriptions.list = jest.fn(() => ({
        next: async () => {
          throw new Error('paddle down');
        },
      }));
      await expect(service.hasHadSubscription(userId)).resolves.toBe(false);
    });
  });
});
