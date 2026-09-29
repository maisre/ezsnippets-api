import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentsService } from './payments.service';
import { PlansService } from '../plans/plans.service';
import { PRODUCT_IDS } from '../plans/plan-catalog';

const AGENCY = PRODUCT_IDS.sandbox.Agency;
const PRO = PRODUCT_IDS.sandbox.Pro;
const PERIOD_END = Math.floor(Date.parse('2026-10-29T00:00:00Z') / 1000);

const userId = new Types.ObjectId().toString();
const teamId = new Types.ObjectId();
const personalId = new Types.ObjectId();
const domainId = new Types.ObjectId();

function makeTeam(overrides: Record<string, unknown> = {}): any {
  return {
    _id: teamId,
    id: String(teamId),
    personal: false,
    members: [{ user: new Types.ObjectId(userId), role: 'owner' }],
    subscriptionId: 'sub_1',
    plan: 'pri_agency_month',
    productId: AGENCY,
    subscriptionStatus: 'active',
    currentPeriodEnd: PERIOD_END,
    cardLast4: '4242',
    ...overrides,
  };
}

function makePersonal(overrides: Record<string, unknown> = {}): any {
  return {
    _id: personalId,
    id: String(personalId),
    personal: true,
    members: [{ user: new Types.ObjectId(userId), role: 'owner' }],
    ...overrides,
  };
}

function paddleSub(priceId: string, productId: string) {
  return {
    id: 'sub_1',
    customerId: 'ctm_1',
    status: 'active',
    scheduledChange: null,
    currentBillingPeriod: { endsAt: new Date(PERIOD_END * 1000).toISOString() },
    items: [{ price: { id: priceId, productId, billingCycle: { interval: 'month' } } }],
  };
}

describe('PaymentsService team downgrade', () => {
  let team: any;
  let personal: any;
  let paddle: any;
  let orgs: any;
  let domains: any;
  let service: PaymentsService;

  beforeEach(() => {
    team = makeTeam();
    personal = makePersonal();
    paddle = {
      subscriptions: {
        get: jest.fn(async () => paddleSub('pri_agency_month', AGENCY)),
        update: jest.fn(async (_id: string, body: any) =>
          paddleSub(body.items[0].priceId, body.items[0].priceId === 'pri_pro_month' ? PRO : AGENCY),
        ),
      },
    };
    orgs = {
      findOne: jest.fn(async (id: string) =>
        id === String(teamId) ? team : id === String(personalId) ? personal : null,
      ),
      getMemberRole: jest.fn(async () => 'owner'),
      findPersonalOrg: jest.fn(async () => personal),
      findBySubscriptionId: jest.fn(async () => personal),
      findTeamOrgsOwnedBy: jest.fn(async () => [team]),
      updateSubscription: jest.fn(async () => null),
      clearSubscription: jest.fn(async () => null),
      setScheduledDowngrade: jest.fn(async () => null),
      clearScheduledDowngrade: jest.fn(async () => null),
    };
    domains = {
      findAllForOrg: jest.fn(async () => [
        { _id: domainId, hostname: 'preview.client.com', status: 'active' },
      ]),
      hasRoomFor: jest.fn(async () => true),
    };
    const catalog = {
      getCatalog: jest.fn(async () => ({
        plans: [
          { name: 'Pro', prices: { month: { id: 'pri_pro_month', amount: '29.00', currency: 'USD' } } },
        ],
      })),
    };
    const plans = new PlansService(undefined, 'sandbox');
    service = new PaymentsService(
      paddle,
      'secret',
      'queue',
      {} as any,
      orgs,
      plans,
      catalog as any,
      { sendMessage: jest.fn() } as any,
      domains,
    );
  });

  describe('scheduleTeamDowngrade', () => {
    it('moves the subscription to Pro on the personal org, billed only from the next renewal', async () => {
      const result = await service.scheduleTeamDowngrade(userId, String(teamId));

      expect(result.effectiveAt).toBe(new Date(PERIOD_END * 1000).toISOString());
      expect(paddle.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ priceId: 'pri_pro_month', quantity: 1 }],
        // Not full_next_billing_period — that adds a full Pro charge on top of
        // the renewal (seen against the sandbox).
        prorationBillingMode: 'do_not_bill',
        customData: { orgId: String(personalId) },
      });
      expect(orgs.updateSubscription).toHaveBeenCalledWith(
        String(personalId),
        expect.objectContaining({ subscriptionId: 'sub_1', productId: PRO, cardLast4: '4242' }),
      );
      expect(orgs.setScheduledDowngrade).toHaveBeenCalledWith(
        String(teamId),
        expect.objectContaining({
          until: new Date(PERIOD_END * 1000),
          productId: AGENCY,
          fromPriceId: 'pri_agency_month',
          toPlan: 'Pro',
          personalOrgId: personalId,
          keepDomainId: undefined,
        }),
      );
      expect(orgs.clearSubscription).toHaveBeenCalledWith(String(teamId));
    });

    it('records the team domain the owner chose to keep', async () => {
      await service.scheduleTeamDowngrade(userId, String(teamId), String(domainId));
      expect(orgs.setScheduledDowngrade).toHaveBeenCalledWith(
        String(teamId),
        expect.objectContaining({ keepDomainId: domainId }),
      );
    });

    it('refuses to keep a domain when the personal slot is taken', async () => {
      domains.hasRoomFor.mockResolvedValue(false);
      await expect(
        service.scheduleTeamDowngrade(userId, String(teamId), String(domainId)),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(paddle.subscriptions.update).not.toHaveBeenCalled();
    });

    it('refuses a domain that is not on the team', async () => {
      await expect(
        service.scheduleTeamDowngrade(userId, String(teamId), new Types.ObjectId().toString()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('is owner-only', async () => {
      orgs.getMemberRole.mockResolvedValue('admin');
      await expect(service.scheduleTeamDowngrade(userId, String(teamId))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('sends a trialing team to cancel instead — Paddle refuses item changes in a trial', async () => {
      team.subscriptionStatus = 'trialing';
      await expect(service.scheduleTeamDowngrade(userId, String(teamId))).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'TRIAL_CANCEL_INSTEAD' }),
      });
    });

    it('refuses a plan that is already set to cancel', async () => {
      team.cancelAtPeriodEnd = true;
      await expect(service.scheduleTeamDowngrade(userId, String(teamId))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses a single-seat workspace', async () => {
      team.productId = PRO;
      await expect(service.scheduleTeamDowngrade(userId, String(teamId))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('cancelTeamDowngrade', () => {
    beforeEach(() => {
      team = makeTeam({
        subscriptionId: undefined,
        plan: undefined,
        productId: undefined,
        subscriptionStatus: undefined,
        scheduledDowngrade: {
          until: new Date(Date.now() + 86_400_000),
          productId: AGENCY,
          fromPriceId: 'pri_agency_month',
          toPlan: 'Pro',
          subscriptionId: 'sub_1',
          personalOrgId: personalId,
        },
      });
      personal = makePersonal({
        subscriptionId: 'sub_1',
        plan: 'pri_pro_month',
        productId: PRO,
        subscriptionStatus: 'active',
      });
    });

    it('puts the team price back without billing, and the subscription back on the team', async () => {
      await service.cancelTeamDowngrade(userId, String(teamId));

      expect(paddle.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ priceId: 'pri_agency_month', quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
        customData: { orgId: String(teamId) },
      });
      expect(orgs.updateSubscription).toHaveBeenCalledWith(
        String(teamId),
        expect.objectContaining({ subscriptionId: 'sub_1', productId: AGENCY }),
      );
      expect(orgs.clearScheduledDowngrade).toHaveBeenCalledWith(String(teamId));
      expect(orgs.clearSubscription).toHaveBeenCalledWith(String(personalId));
    });

    it('cannot undo once the downgrade has taken effect', async () => {
      team.scheduledDowngrade.until = new Date(Date.now() - 1000);
      await expect(service.cancelTeamDowngrade(userId, String(teamId))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses when the subscription has moved on since', async () => {
      orgs.findBySubscriptionId.mockResolvedValue(null);
      await expect(service.cancelTeamDowngrade(userId, String(teamId))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  it('blocks upgrading back up while a downgrade is pending — that is an undo, not a new charge', async () => {
    team = makeTeam({
      subscriptionId: undefined,
      productId: undefined,
      subscriptionStatus: undefined,
      scheduledDowngrade: { until: new Date(Date.now() + 86_400_000), productId: AGENCY },
    });
    personal = makePersonal({
      subscriptionId: 'sub_1',
      plan: 'pri_pro_month',
      productId: PRO,
      subscriptionStatus: 'active',
    });
    (paddle as any).prices = { get: jest.fn(async () => ({ productId: AGENCY })) };

    await expect(service.previewUpgrade(userId, 'pri_agency_month')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DOWNGRADE_SCHEDULED' }),
    });
  });
});
