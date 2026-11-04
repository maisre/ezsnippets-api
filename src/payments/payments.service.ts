import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EventName,
  Paddle,
  type AdjustmentNotification,
  type EventEntity,
  type Price,
  type SubscriptionNotification,
  type TransactionNotification,
} from '@paddle/paddle-node-sdk';
import * as Sentry from '@sentry/nestjs';
import { Model, Types } from 'mongoose';
import { Org } from '../orgs/interfaces/org.interface';
import { OrgsService } from '../orgs/orgs.service';
import {
  PLAN_TIERS,
  pickPlanRef,
  PlanRef,
  PlanTier,
} from '../plans/plan-catalog';
import {
  downgradeGraceProductId,
  hasActiveSubscription,
  switchGraceProductId,
} from '../plans/subscription-status';
import {
  BillingInterval,
  PaddleCatalogService,
} from '../plans/paddle-catalog.service';
import { DomainsService } from '../domains/domains.service';
import { PlansService } from '../plans/plans.service';
import { PADDLE_CLIENT } from '../paddle/paddle.module';
import { SqsService } from '../sqs/sqs.service';

type SubscriptionUpdate = Parameters<OrgsService['updateSubscription']>[1];

// The events dispatch() acts on. Everything else Paddle sends is acked and
// ignored, so the notification destination can safely stay subscribed to more
// than this — but keep the two lists in step when adding a handler.
const HANDLED_EVENTS = new Set<EventName>([
  EventName.SubscriptionCreated,
  EventName.SubscriptionActivated,
  EventName.SubscriptionTrialing,
  EventName.SubscriptionPastDue,
  EventName.SubscriptionPaused,
  EventName.SubscriptionResumed,
  EventName.SubscriptionUpdated,
  EventName.SubscriptionCanceled,
  EventName.TransactionCompleted,
  EventName.TransactionPaymentFailed,
  EventName.PaymentMethodSaved,
  EventName.PaymentMethodDeleted,
  EventName.AdjustmentCreated,
  // Not billing — these invalidate the cached price catalog so a pricing edit
  // in the dashboard shows up without waiting for the TTL.
  EventName.PriceCreated,
  EventName.PriceUpdated,
  EventName.ProductUpdated,
]);

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PADDLE_CLIENT) private readonly paddle: Paddle,
    @Inject('PADDLE_WEBHOOK_SECRET') private readonly webhookSecret: string,
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
    @Inject('WEBHOOK_EVENT_MODEL')
    private readonly webhookEventModel: Model<any>,
    private readonly orgsService: OrgsService,
    private readonly plansService: PlansService,
    private readonly catalogService: PaddleCatalogService,
    private readonly sqsService: SqsService,
    private readonly domainsService: DomainsService,
  ) {}

  /**
   * Create a Paddle Transaction the frontend opens via
   * Paddle.Checkout.open({ transactionId }).
   *
   * Which org gets billed is decided here from what's being bought, not from
   * the caller's active org:
   *
   *  - a single-seat tier bills the caller's personal org;
   *  - a team tier (maxSeats > 1) bills a team org the caller owns, created
   *    now if they have no unsubscribed one to reuse. It has to exist before
   *    checkout so its id can ride in customData — creating it from the
   *    webhook would let transaction.completed, which Paddle may deliver
   *    first, land on the personal org.
   *
   * So a team member can never buy a plan *for the team*: whatever they buy
   * lands on an org they own. Returns the billed org's id so the client can
   * switch into it once the webhook has landed.
   */
  async createCheckoutSession(
    userId: string,
    email: string,
    priceId: string,
  ): Promise<{ transactionId: string; orgId: string; customerEmail?: string }> {
    const { tier, price } = await this.planPrice(priceId);
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (!personal) throw new NotFoundException('Personal workspace not found');

    let target: Org;
    let replacesSubscriptionId: string | undefined;
    if (tier.limits.maxSeats > 1) {
      // One subscription per person: a paying customer moves up via
      // upgradeToTeam, which carries their subscription across, rather than
      // opening a second one alongside it.
      //
      // A *trialing* one can't be carried: Paddle refuses item changes during
      // a trial. So a trial customer checks out for the team like anyone else,
      // and the trial is cancelled once the team subscription exists (see
      // onSubscriptionCreated) — abandoning checkout leaves the trial intact.
      if (hasActiveSubscription(personal) && personal.subscriptionStatus) {
        if (personal.subscriptionStatus !== 'trialing') {
          throw new ConflictException({
            message:
              'You already have a subscription. Upgrade it to include a team workspace.',
            code: 'UPGRADE_AVAILABLE',
          });
        }
        replacesSubscriptionId = personal.subscriptionId;
      }
      target = await this.findOrCreateTeamOrg(userId, email, personal);
    } else {
      target = personal;
      const entitlement = await this.plansService.entitlementFor(personal);
      if (entitlement?.source === 'team-owner') {
        throw new ConflictException(
          `Your personal workspace already includes ${entitlement.plan} with your team plan.`,
        );
      }
    }

    if (hasActiveSubscription(target)) {
      throw new ConflictException('This workspace already has an active plan.');
    }

    const customerId =
      target.paddleCustomerId ?? personal.paddleCustomerId ?? null;
    // The free trial is once per customer. Someone who has subscribed before
    // buys the same product at the same price through a one-off copy of it
    // with no trial — product-keyed entitlements don't notice the difference,
    // and no extra catalog prices have to be kept in step.
    const skipTrial =
      !!price.trialPeriod && (await this.hasHadSubscription(userId));
    const transaction = await this.paddle.transactions.create({
      items: [
        skipTrial
          ? { price: this.withoutTrial(price), quantity: 1 }
          : { priceId, quantity: 1 },
      ],
      customerId,
      customData: {
        orgId: String(target._id),
        ...(replacesSubscriptionId ? { replacesSubscriptionId } : {}),
      },
    });

    this.logger.log(
      `Transaction ${transaction.id} created for org ${target._id} (${tier.name}${skipTrial ? ', no trial' : ''})`,
    );
    // First purchase: no Paddle customer yet, so the overlay would ask for an
    // email from scratch and receipts could go to whatever gets typed. The
    // client prefills it with the account's email instead.
    return {
      transactionId: transaction.id,
      orgId: String(target._id),
      ...(customerId || !email ? {} : { customerEmail: email }),
    };
  }

  /**
   * What moving the caller's personal subscription onto a team tier would
   * charge today. Read-only — Paddle computes the proration.
   */
  async previewUpgrade(
    userId: string,
    priceId: string,
  ): Promise<{ amountDueToday: string; currency: string; plan: string }> {
    const { personal, tier } = await this.upgradeContext(userId, priceId);
    const preview = await this.paddle.subscriptions
      .previewUpdate(personal.subscriptionId!, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: 'prorated_immediately',
      })
      .catch(rethrowPaddleRefusal);
    this.assertCreditsPaidPeriod(preview, personal);
    const totals = preview.immediateTransaction?.details?.totals;
    return {
      amountDueToday: this.formatMinorUnits(totals?.grandTotal),
      currency: totals?.currencyCode ?? preview.currencyCode,
      plan: tier.name,
    };
  }

  /**
   * Move an existing single-seat subscription up to a team tier.
   *
   * The subscription itself moves to the team org: Paddle swaps the item
   * (prorated, charged now — and refused outright if that charge fails) and
   * its customData is repointed so every later event resolves to the team.
   * The personal org's billing fields are cleared, and it falls back to the
   * team tier's ownerPersonalTier — so an upgrading Pro customer keeps Pro on
   * their own projects with nothing to migrate.
   */
  async upgradeToTeam(
    userId: string,
    email: string,
    priceId: string,
  ): Promise<{ orgId: string }> {
    const { personal, tier } = await this.upgradeContext(userId, priceId);
    await this.paddle.subscriptions
      .previewUpdate(personal.subscriptionId!, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: 'prorated_immediately',
      })
      .catch(rethrowPaddleRefusal)
      .then((preview) => this.assertCreditsPaidPeriod(preview, personal));
    const team = await this.findOrCreateTeamOrg(userId, email, personal);
    const teamId = String(team._id);

    const sub = await this.paddle.subscriptions
      .update(personal.subscriptionId!, {
        items: [{ priceId, quantity: 1 }],
        prorationBillingMode: 'prorated_immediately',
        onPaymentFailure: 'prevent_change',
        customData: { orgId: teamId },
      })
      .catch(rethrowPaddleRefusal);

    // Team first, then clear personal: if we die in between, the customer is
    // left entitled twice (a support clean-up), never locked out.
    const ref = this.planRefFor(sub as unknown as SubscriptionNotification);
    await this.orgsService.updateSubscription(teamId, {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
      cardBrand: personal.cardBrand ?? null,
      cardLast4: personal.cardLast4 ?? null,
      cardExpMonth: personal.cardExpMonth ?? null,
      cardExpYear: personal.cardExpYear ?? null,
      subscriptionEventAt: personal.subscriptionEventAt,
    });
    await this.orgsService.clearSubscription(String(personal._id));
    await this.clearEndedDowngrade(team);

    this.logger.log(
      `Subscription ${sub.id} upgraded to ${tier.name} and moved ${personal._id} -> ${teamId}`,
    );
    return { orgId: teamId };
  }

  /**
   * What moving a team down to a single-seat tier would do — for the
   * confirmation screen, which has to spell out that the team closes.
   */
  async previewTeamDowngrade(userId: string, orgId: string) {
    const team = await this.assertOwner(orgId, userId);
    this.assertPayer(team, userId);
    const scheduled = downgradeGraceProductId(team) ? team.scheduledDowngrade! : null;

    const [teamDomains, personal] = await Promise.all([
      this.domainsService.findAllForOrg(orgId),
      this.orgsService.findPersonalOrg(userId),
    ]);
    const base = {
      memberCount: team.members.length,
      teamDomains: teamDomains.map((d) => ({
        id: String(d._id),
        hostname: d.hostname,
        status: d.status,
      })),
      personalDomainRoom: personal
        ? await this.domainsService.hasRoomFor(String(personal._id))
        : false,
    };

    if (scheduled) {
      const kept = scheduled.keepDomainId
        ? teamDomains.find((d) => String(d._id) === String(scheduled.keepDomainId))
        : undefined;
      return {
        ...base,
        scheduled: {
          effectiveAt: scheduled.until.toISOString(),
          plan: scheduled.toPlan,
          keepHostname: kept?.hostname ?? null,
        },
      };
    }

    const { tier, price, interval } = await this.downgradeTarget(team);
    return {
      ...base,
      scheduled: null,
      plan: tier,
      interval,
      amount: price.amount,
      currency: price.currency,
      effectiveAt: this.periodEndIso(team),
    };
  }

  /**
   * Move a team subscription down to the owner's single-seat tier (Agency ->
   * Pro), taking effect when the current period ends.
   *
   * Paddle can't schedule an item change — scheduled_change is cancel, pause
   * or resume only — so the change is made now with `do_not_bill`: no charge
   * today, no credit for the rest of the period, and the next renewal bills
   * the new tier at its normal price. (Not `full_next_billing_period`, which
   * sounds right but adds a full charge for the new items *on top of* the
   * renewal — it double-bills the first month.) The subscription moves to the owner's personal org the same way
   * upgradeToTeam moved it up, and the team keeps its tier until the period
   * ends via scheduledDowngrade. Nothing has to fire on time for the billing
   * to be right; only the optional domain carry-over waits for a sweep.
   */
  async scheduleTeamDowngrade(
    userId: string,
    orgId: string,
    keepDomainId?: unknown,
  ): Promise<{ effectiveAt: string }> {
    const team = await this.assertOwner(orgId, userId);
    this.assertPayer(team, userId);
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (!personal) throw new NotFoundException('Personal workspace not found');
    if (hasActiveSubscription(personal) && personal.subscriptionStatus) {
      throw new ConflictException(
        'Your personal workspace already has its own plan. Cancel the team plan instead.',
      );
    }

    const { tier, price } = await this.downgradeTarget(team);

    let keep: Types.ObjectId | undefined;
    if (keepDomainId !== undefined && keepDomainId !== null && keepDomainId !== '') {
      const domains = await this.domainsService.findAllForOrg(orgId);
      const domain = domains.find((d) => String(d._id) === String(keepDomainId));
      if (!domain) throw new BadRequestException('That domain isn’t on this team.');
      if (!(await this.domainsService.hasRoomFor(String(personal._id)))) {
        throw new ConflictException(
          'Your personal workspace already uses its custom domain. Remove it there first to bring a team domain across.',
        );
      }
      keep = domain._id as Types.ObjectId;
    }

    const until = new Date(this.periodEndIso(team));
    const sub = await this.paddle.subscriptions
      .update(team.subscriptionId!, {
        items: [{ priceId: price.id, quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
        customData: { orgId: String(personal._id) },
      })
      .catch(rethrowPaddleRefusal);

    // Personal first, then the team: dying in between leaves both entitled
    // (support clean-up), never the owner locked out — as in upgradeToTeam.
    const ref = this.planRefFor(sub as unknown as SubscriptionNotification);
    await this.orgsService.updateSubscription(String(personal._id), {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
      cardBrand: team.cardBrand ?? null,
      cardLast4: team.cardLast4 ?? null,
      cardExpMonth: team.cardExpMonth ?? null,
      cardExpYear: team.cardExpYear ?? null,
      subscriptionEventAt: team.subscriptionEventAt,
    });
    await this.orgsService.setScheduledDowngrade(orgId, {
      until,
      productId: team.productId!,
      fromPriceId: team.plan!,
      toPlan: tier,
      subscriptionId: sub.id,
      personalOrgId: personal._id as Types.ObjectId,
      keepDomainId: keep,
      scheduledBy: new Types.ObjectId(userId),
      scheduledAt: new Date(),
    });
    await this.orgsService.clearSubscription(orgId);

    this.logger.log(
      `Team ${orgId} downgraded to ${tier} from ${until.toISOString()}; subscription ${sub.id} moved to ${personal._id}`,
    );
    return { effectiveAt: until.toISOString() };
  }

  /**
   * Take back a scheduled downgrade before it lands: the subscription returns
   * to the team price and the team org. `do_not_bill` because this period is
   * already paid at the team rate; the next renewal bills it in full again.
   */
  async cancelTeamDowngrade(userId: string, orgId: string): Promise<{ orgId: string }> {
    const team = await this.assertOwner(orgId, userId);
    const scheduled = team.scheduledDowngrade;
    if (!scheduled || !downgradeGraceProductId(team)) {
      throw new BadRequestException('There’s no scheduled downgrade to cancel.');
    }
    const holder = await this.orgsService.findBySubscriptionId(scheduled.subscriptionId);
    if (!holder || String(holder._id) !== String(scheduled.personalOrgId)) {
      throw new ConflictException(
        'That subscription has changed since the downgrade was scheduled. Contact support to put the team plan back.',
      );
    }
    if (!hasActiveSubscription(holder)) {
      throw new ConflictException(
        'The subscription is no longer active, so the team plan can’t be restored. Buy the team plan again instead.',
      );
    }

    const sub = await this.paddle.subscriptions
      .update(scheduled.subscriptionId, {
        items: [{ priceId: scheduled.fromPriceId, quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
        customData: { orgId },
      })
      .catch(rethrowPaddleRefusal);

    const ref = this.planRefFor(sub as unknown as SubscriptionNotification);
    await this.orgsService.updateSubscription(orgId, {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
      cardBrand: holder.cardBrand ?? null,
      cardLast4: holder.cardLast4 ?? null,
      cardExpMonth: holder.cardExpMonth ?? null,
      cardExpYear: holder.cardExpYear ?? null,
      subscriptionEventAt: holder.subscriptionEventAt,
    });
    await this.orgsService.clearScheduledDowngrade(orgId);
    await this.orgsService.clearSubscription(String(holder._id));

    this.logger.log(`Downgrade of team ${orgId} cancelled; subscription ${sub.id} moved back`);
    return { orgId };
  }

  // --- single-seat plan changes ---------------------------------------------

  /**
   * What the pricing and account pages need to offer the right buttons: the
   * caller's own single-seat subscription (it always lives on their personal
   * org), any switch scheduled on it, and whether a checkout would include
   * the free trial.
   */
  async billingState(userId: string): Promise<{
    trialEligible: boolean;
    includedWithTeam: boolean;
    current: {
      plan: string;
      interval: BillingInterval | null;
      status: string;
      cancelAtPeriodEnd: boolean;
      scheduledSwitch: { toPlan: string; effectiveAt: string } | null;
    } | null;
  }> {
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (!personal) throw new NotFoundException('Personal workspace not found');

    const entitlement = await this.plansService.entitlementFor(personal);
    let current: Awaited<ReturnType<PaymentsService['billingState']>>['current'] = null;
    if (hasActiveSubscription(personal) && personal.subscriptionStatus && personal.subscriptionId) {
      const grace = switchGraceProductId(personal) ? personal.scheduledSwitch! : null;
      const sub = await this.paddle.subscriptions
        .get(personal.subscriptionId)
        .catch(() => null);
      const interval = sub?.billingCycle?.interval;
      current = {
        plan: this.plansService.planName(grace?.productId ?? personal.productId),
        interval: interval === 'month' || interval === 'year' ? interval : null,
        status: personal.subscriptionStatus,
        cancelAtPeriodEnd: !!personal.cancelAtPeriodEnd,
        scheduledSwitch: grace
          ? {
              toPlan: this.plansService.planName(grace.toProductId),
              effectiveAt: new Date(grace.until).toISOString(),
            }
          : null,
      };
    }

    return {
      trialEligible: !(await this.hasHadSubscription(userId)),
      includedWithTeam: entitlement?.source === 'team-owner',
      current,
    };
  }

  /** What changing the caller's single-seat plan to `priceId` would do. */
  async previewPlanChange(userId: string, priceId: unknown) {
    const ctx = await this.planChangeContext(userId, priceId);
    const preview = await this.paddle.subscriptions
      .previewUpdate(ctx.personal.subscriptionId!, ctx.request)
      .catch(rethrowPaddleRefusal);
    if (ctx.kind === 'upgrade') this.assertCreditsPaidPeriod(preview, ctx.personal);
    const now = preview.immediateTransaction?.details?.totals;
    const next = preview.nextTransaction?.details?.totals;
    return {
      kind: ctx.kind,
      plan: ctx.target.tier.name,
      interval: ctx.targetInterval,
      currentPlan: ctx.current.tier.name,
      amountDueToday: this.formatMinorUnits(now?.grandTotal),
      nextAmount: next ? this.formatMinorUnits(next.grandTotal) : null,
      nextBilledAt: preview.nextBilledAt,
      currency: now?.currencyCode ?? next?.currencyCode ?? preview.currencyCode,
      effectiveAt: ctx.kind === 'downgrade' ? ctx.periodEnd : null,
    };
  }

  /**
   * Change a single-seat subscription to another single-seat price, on the
   * same org and the same subscription.
   *
   *  - upgrade (higher tier, or monthly -> yearly): now, prorated, charged
   *    immediately — refused outright if that charge fails.
   *  - downgrade (lower tier, same interval): the price changes now with
   *    `do_not_bill`, and scheduledSwitch keeps the paid-up tier until the
   *    period ends — the same shape as a team downgrade.
   *  - during a trial: Paddle only accepts `do_not_bill`, which swaps the item
   *    and keeps the trial; the new price is what bills when it ends.
   *  - back to the plan a scheduled downgrade is leaving: undo, no charge.
   *
   * The kind is worked out again here from Paddle's state, never taken from
   * the preview the client saw.
   */
  async changePlan(userId: string, priceId: unknown) {
    const ctx = await this.planChangeContext(userId, priceId);
    const { personal } = ctx;
    const orgId = String(personal._id);
    if (ctx.kind === 'upgrade') {
      const preview = await this.paddle.subscriptions
        .previewUpdate(personal.subscriptionId!, ctx.request)
        .catch(rethrowPaddleRefusal);
      this.assertCreditsPaidPeriod(preview, personal);
    }

    const sub = await this.paddle.subscriptions
      .update(personal.subscriptionId!, ctx.request)
      .catch(rethrowPaddleRefusal);

    if (ctx.kind === 'downgrade') {
      await this.orgsService.setScheduledSwitch(orgId, {
        subscriptionId: sub.id,
        until: new Date(ctx.periodEnd!),
        productId: ctx.current.productId,
        priceId: ctx.current.priceId,
        toProductId: ctx.target.price.productId,
        toPriceId: ctx.target.price.id,
        scheduledAt: new Date(),
      });
    }
    const ref = this.planRefFor(sub as unknown as SubscriptionNotification);
    await this.orgsService.updateSubscription(orgId, {
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
    });
    if (ctx.kind === 'undo' || ctx.kind === 'upgrade' || ctx.kind === 'trial') {
      await this.orgsService.clearScheduledSwitch(orgId);
    }

    this.logger.log(
      `Plan change (${ctx.kind}) ${ctx.current.tier.name} -> ${ctx.target.tier.name} on ${sub.id} for org ${orgId}`,
    );
    return {
      kind: ctx.kind,
      plan: ctx.target.tier.name,
      effectiveAt: ctx.kind === 'downgrade' ? ctx.periodEnd : null,
    };
  }

  /** "Keep my plan": undo a scheduled switch to a cheaper plan before it lands. */
  async cancelPlanSwitch(userId: string): Promise<{ plan: string }> {
    const personal = await this.orgsService.findPersonalOrg(userId);
    const grace = personal && switchGraceProductId(personal) ? personal.scheduledSwitch : null;
    if (!personal || !grace || personal.subscriptionId === undefined) {
      throw new BadRequestException('There’s no scheduled plan switch to cancel.');
    }
    // This period is already paid at the old price, so no charge now; the
    // next renewal bills it again. The stored price may be a no-trial copy —
    // Paddle accepts those back by id.
    const sub = await this.paddle.subscriptions
      .update(personal.subscriptionId, {
        items: [{ priceId: grace.priceId, quantity: 1 }],
        prorationBillingMode: 'do_not_bill',
      })
      .catch(rethrowPaddleRefusal);
    const ref = this.planRefFor(sub as unknown as SubscriptionNotification);
    await this.orgsService.updateSubscription(String(personal._id), {
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
    });
    await this.orgsService.clearScheduledSwitch(String(personal._id));
    this.logger.log(`Plan switch on ${sub.id} cancelled for org ${personal._id}`);
    return { plan: this.plansService.planName(ref.productId) };
  }

  private async planChangeContext(userId: string, priceId: unknown) {
    const target = await this.planPrice(priceId);
    if (target.tier.limits.maxSeats > 1) {
      throw new BadRequestException('Team plans are bought from the pricing page.');
    }
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (
      !personal?.subscriptionId ||
      !personal.subscriptionStatus ||
      !hasActiveSubscription(personal)
    ) {
      throw new BadRequestException('No active subscription to change.');
    }
    const owned = await this.orgsService.findTeamOrgsOwnedBy(userId);
    if (owned.some((o) => downgradeGraceProductId(o))) {
      throw new ConflictException({
        message:
          'Your team is scheduled to move to a single-seat plan. Cancel that from the account page before changing plans.',
        code: 'DOWNGRADE_SCHEDULED',
      });
    }
    const trialing = personal.subscriptionStatus === 'trialing';
    if (!trialing && personal.subscriptionStatus !== 'active') {
      throw new ConflictException(
        'Sort out the payment on this plan before changing it — Manage Billing has the details.',
      );
    }
    if (personal.cancelAtPeriodEnd) {
      throw new ConflictException(
        'This plan is set to end. Resume it from Manage Billing before changing plans.',
      );
    }

    const sub = await this.paddle.subscriptions.get(personal.subscriptionId);
    const item =
      sub.items.find((i) => this.plansService.findTier(i.price?.productId)) ?? sub.items[0];
    const currentTier = this.plansService.findTier(item?.price?.productId);
    const currentInterval = item?.price?.billingCycle?.interval;
    if (!item?.price || !currentTier || currentTier.limits.maxSeats > 1) {
      throw new ConflictException('This plan can’t be changed here. Contact support.');
    }
    const current = {
      tier: currentTier,
      productId: item.price.productId,
      priceId: item.price.id,
      interval: currentInterval,
    };
    const targetInterval = target.price.billingCycle!.interval;
    if (current.priceId === target.price.id) {
      throw new BadRequestException('You’re already on this plan.');
    }

    const rank = (t: PlanTier) => PLAN_TIERS.findIndex((x) => x.name === t.name);
    const up = rank(target.tier) - rank(currentTier);
    const sameInterval = targetInterval === currentInterval;
    const toYearly = currentInterval === 'month' && targetInterval === 'year';
    const periodEnd = sub.currentBillingPeriod?.endsAt ?? null;
    const grace = switchGraceProductId(personal) ? personal.scheduledSwitch! : null;

    let kind: 'upgrade' | 'downgrade' | 'trial' | 'undo';
    if (trialing) {
      kind = 'trial';
    } else if (grace) {
      if (target.price.productId !== grace.productId || !sameInterval) {
        throw new ConflictException({
          message: `You’re already switching to ${this.plansService.planName(grace.toProductId)} at renewal. Keep your current plan first, then choose another.`,
          code: 'SWITCH_SCHEDULED',
        });
      }
      kind = 'undo';
    } else if ((up > 0 && (sameInterval || toYearly)) || (up === 0 && toYearly)) {
      kind = 'upgrade';
    } else if (up < 0 && sameInterval) {
      kind = 'downgrade';
    } else {
      // Yearly -> monthly, or a cheaper tier on a different interval: the
      // prepaid year would have to be credited back, which do_not_bill can't
      // express and proration would turn into an account credit.
      throw new ConflictException({
        message:
          'That change has to happen at renewal on your current billing period. Pick the same billing period, or contact support.',
        code: 'INTERVAL_CHANGE',
      });
    }
    if (kind === 'downgrade' && !periodEnd) {
      throw new ConflictException('This plan has no billing period on record yet. Try again shortly.');
    }

    const request =
      kind === 'upgrade'
        ? {
            items: [{ priceId: target.price.id, quantity: 1 }],
            prorationBillingMode: 'prorated_immediately' as const,
            onPaymentFailure: 'prevent_change' as const,
          }
        : {
            items: [{ priceId: target.price.id, quantity: 1 }],
            prorationBillingMode: 'do_not_bill' as const,
          };

    return { personal, target, current, targetInterval, kind, periodEnd, request };
  }

  /**
   * A prorated upgrade of a paid-up subscription must credit what's already
   * been paid for the rest of the period — the immediate charge carries a
   * negative proration line for the outgoing item.
   *
   * Paddle drops that credit once the item has been changed with `do_not_bill`
   * in the same period (a scheduled downgrade, its undo, a team downgrade or
   * its undo): verified in sandbox, the upgrade then charges the new price in
   * full on top of what was paid. Rather than overcharge, refuse until the
   * renewal resets the period.
   */
  private assertCreditsPaidPeriod(
    preview: { immediateTransaction?: { details?: { lineItems?: { totals?: { total?: string } }[] } | null } | null },
    org: Org,
  ): void {
    if (org.subscriptionStatus !== 'active') return;
    const lines = preview.immediateTransaction?.details?.lineItems ?? [];
    if (lines.some((l) => Number(l.totals?.total) < 0)) return;
    const renews = org.currentPeriodEnd
      ? new Date(org.currentPeriodEnd * 1000).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : 'your next renewal';
    this.logger.warn(
      `Refusing prorated upgrade on ${org.subscriptionId} (org ${org._id}): no credit for the current period`,
    );
    throw new ConflictException({
      message: `You changed plans earlier in this billing period, so an upgrade right now would charge you again for time you've already paid for. You can upgrade from ${renews}, or contact support and we'll do it for you.`,
      code: 'UPGRADE_AFTER_CHANGE',
    });
  }

  // --- free trial: once per customer ------------------------------------------

  /**
   * Has this person ever had a subscription? If so, checkout carries no trial.
   *
   * Durable evidence first: trialUsedAt (stamped on subscription.created on
   * the billed org and the owner's personal org) or any subscription field on
   * an org they own — which also covers everyone who subscribed before
   * trialUsedAt existed, since canceled orgs keep their plan and status. Only
   * when the database has nothing does it ask Paddle whether a customer id we
   * hold has ever had a subscription. If Paddle can't be reached the answer is
   * "no": wrongly granting one trial is better than wrongly charging a new
   * customer on day one.
   */
  async hasHadSubscription(userId: string): Promise<boolean> {
    const [personal, teams] = await Promise.all([
      this.orgsService.findPersonalOrg(userId),
      this.orgsService.findTeamOrgsOwnedBy(userId),
    ]);
    const orgs = [personal, ...teams].filter((o): o is Org => !!o);
    if (
      orgs.some(
        (o) => o.trialUsedAt || o.subscriptionId || o.subscriptionStatus || o.productId || o.plan,
      )
    ) {
      return true;
    }
    const customers = [
      ...new Set(orgs.map((o) => o.paddleCustomerId).filter((c): c is string => !!c)),
    ];
    for (const customerId of customers) {
      try {
        const found = await this.paddle.subscriptions
          .list({ customerId: [customerId], perPage: 1 })
          .next();
        if (found.length > 0) return true;
      } catch (err) {
        this.logger.warn(`Could not check subscription history for ${customerId}: ${err}`);
      }
    }
    return false;
  }

  /** A one-off copy of a catalog price with the trial taken off. */
  private withoutTrial(price: Price) {
    return {
      description: price.description,
      name: price.name,
      productId: price.productId,
      unitPrice: price.unitPrice,
      unitPriceOverrides: price.unitPriceOverrides,
      billingCycle: price.billingCycle,
      taxMode: price.taxMode,
      quantity: price.quantity,
      trialPeriod: null,
    };
  }

  /** The billed org and its owner's personal org — see Org.trialUsedAt. */
  private async stampTrialUsed(org: Org): Promise<void> {
    const owner = org.members.find((m) => m.role === 'owner');
    const personal =
      owner && !org.personal
        ? await this.orgsService.findPersonalOrg(String(owner.user))
        : null;
    const ids = [String(org._id), ...(personal ? [String(personal._id)] : [])];
    await this.orgsService.markTrialUsed(ids);
  }

  /**
   * A downgrade moves the subscription onto the caller's personal workspace.
   * After an ownership transfer the subscription is still the previous
   * owner's, so it can't become the new owner's personal plan: they cancel
   * the team plan instead and buy their own.
   */
  private assertPayer(team: Org, userId: string): void {
    if (team.billingPayerId && String(team.billingPayerId) !== userId) {
      throw new ConflictException({
        message:
          'This team’s plan is still billed to the previous owner, so it can’t become your personal plan. Cancel the team plan from Manage Billing, then choose Pro for your personal workspace.',
        code: 'BILLED_TO_PREVIOUS_OWNER',
      });
    }
  }

  /**
   * The single-seat tier and price a team moves down to: the tier its owners
   * already get on their personal org (ownerPersonalTier), on the same billing
   * interval they pay the team on now.
   */
  private async downgradeTarget(team: Org): Promise<{
    tier: string;
    price: { id: string; amount: string; currency: string };
    interval: BillingInterval;
  }> {
    const current = this.plansService.findTier(team.productId);
    if (
      team.personal ||
      !team.subscriptionId ||
      !hasActiveSubscription(team) ||
      !current ||
      current.limits.maxSeats <= 1 ||
      !current.ownerPersonalTier
    ) {
      throw new BadRequestException('This workspace isn’t on a team plan.');
    }
    if (team.subscriptionStatus === 'trialing') {
      throw new ConflictException({
        message:
          'A trial can’t change plans. Cancel the team trial from Manage Billing, then choose Pro for your personal workspace.',
        code: 'TRIAL_CANCEL_INSTEAD',
      });
    }
    if (team.subscriptionStatus !== 'active') {
      throw new ConflictException(
        'Sort out the payment on this plan before changing it — Manage Billing has the details.',
      );
    }
    if (team.cancelAtPeriodEnd) {
      throw new ConflictException(
        'This plan is already set to end. Resume it from Manage Billing first if you’d rather move to Pro.',
      );
    }

    const sub = await this.paddle.subscriptions.get(team.subscriptionId);
    const item = sub.items.find((i) => i.price?.productId === team.productId) ?? sub.items[0];
    const interval = item?.price?.billingCycle?.interval;
    if (interval !== 'month' && interval !== 'year') {
      throw new ConflictException('This plan’s billing interval can’t be changed here. Contact support.');
    }
    const catalog = await this.catalogService.getCatalog();
    const price = catalog.plans.find((p) => p.name === current.ownerPersonalTier)
      ?.prices[interval];
    if (!price) {
      throw new ConflictException(
        `There’s no ${interval}ly ${current.ownerPersonalTier} price available right now. Try again shortly.`,
      );
    }
    return { tier: current.ownerPersonalTier, price, interval };
  }

  private periodEndIso(org: Org): string {
    if (!org.currentPeriodEnd) {
      throw new ConflictException('This plan has no billing period on record yet. Try again shortly.');
    }
    return new Date(org.currentPeriodEnd * 1000).toISOString();
  }

  /**
   * A team with a new subscription no longer owes anything to a downgrade
   * that ended — and must not have its kept domain moved away by the sweep.
   */
  private async clearEndedDowngrade(org: Org | null): Promise<void> {
    if (org?.scheduledDowngrade) {
      await this.orgsService.clearScheduledDowngrade(String(org._id));
    }
    // A new subscription is paid by whoever bought it — the owner — so the
    // previous payer recorded at a transfer no longer applies.
    if (org?.billingPayerId) {
      await this.orgsService.clearBillingPayer(String(org._id));
    }
  }

  private async upgradeContext(
    userId: string,
    priceId: string,
  ): Promise<{ personal: Org; tier: PlanTier }> {
    const tier = await this.tierForPrice(priceId);
    if (tier.limits.maxSeats <= 1) {
      throw new BadRequestException('Upgrades here are to a team plan only.');
    }
    const personal = await this.orgsService.findPersonalOrg(userId);
    if (
      !personal?.subscriptionId ||
      !personal.subscriptionStatus ||
      !hasActiveSubscription(personal)
    ) {
      throw new BadRequestException('No active subscription to upgrade.');
    }
    // Their subscription only sits here because they downgraded a team that
    // is still paid up. Going back up is undoing that, not a new prorated
    // charge for a period the team has already paid for.
    const owned = await this.orgsService.findTeamOrgsOwnedBy(userId);
    if (owned.some((o) => downgradeGraceProductId(o))) {
      throw new ConflictException({
        message:
          'Your team is scheduled to move to a single-seat plan. Cancel that from the account page to keep the team plan.',
        code: 'DOWNGRADE_SCHEDULED',
      });
    }
    if (switchGraceProductId(personal)) {
      throw new ConflictException({
        message:
          'Your plan is scheduled to switch at renewal. Keep your current plan from the account page first, then upgrade.',
        code: 'SWITCH_SCHEDULED',
      });
    }
    if (personal.subscriptionStatus === 'trialing') {
      throw new ConflictException({
        message:
          'Trials can’t be upgraded in place. Check out for the team plan instead — your trial ends when it starts.',
        code: 'TRIAL_USE_CHECKOUT',
      });
    }
    return { personal, tier };
  }

  /** Reuse a team org the user owns that isn't paying yet, else make one. */
  private async findOrCreateTeamOrg(
    userId: string,
    email: string,
    personal: Org,
  ): Promise<Org> {
    const owned = await this.orgsService.findTeamOrgsOwnedBy(userId);
    const idle = owned.find((o) => !hasActiveSubscription(o));
    if (idle) return idle;
    return this.orgsService.createTeamOrg(
      userId,
      `${email}'s Team`,
      personal.paddleCustomerId,
    );
  }

  private async tierForPrice(priceId: string): Promise<PlanTier> {
    return (await this.planPrice(priceId)).tier;
  }

  /**
   * A catalog price the client asked for, and the tier its product grants.
   * Only recurring catalog prices for products we map are accepted — the
   * client names a price, never a plan or an amount.
   */
  private async planPrice(priceId: unknown): Promise<{ tier: PlanTier; price: Price }> {
    if (typeof priceId !== 'string' || !priceId) {
      throw new BadRequestException('priceId is required');
    }
    const price = await this.paddle.prices.get(priceId).catch(() => null);
    const tier = this.plansService.findTier(price?.productId);
    if (!price || !tier || price.status !== 'active' || !price.billingCycle) {
      throw new BadRequestException('Unknown plan');
    }
    return { tier, price };
  }

  // Billing is owner-only: cancelling or opening the portal affects everyone
  // in the org, so ordinary members can't do either.
  private async assertOwner(orgId: string, userId: string): Promise<Org> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new NotFoundException('Organization not found');

    const role = await this.orgsService.getMemberRole(orgId, userId);
    if (role !== 'owner') {
      throw new ForbiddenException(
        'Only the organization owner can manage billing',
      );
    }
    return org;
  }

  // Authenticated links into Paddle's hosted customer portal: invoices,
  // payment history, card management, cancellation.
  //
  // Owner-only. These URLs are bearer credentials for the whole billing record
  // — anyone holding one is in, without logging in — so they're never logged,
  // never stored, and minted fresh per request.
  async createPortalSession(
    orgId: string,
    userId: string,
  ): Promise<{
    overviewUrl: string;
    updatePaymentMethodUrl?: string;
    cancelUrl?: string;
  }> {
    const org = await this.assertOwner(orgId, userId);

    if (!org.paddleCustomerId) {
      throw new BadRequestException(
        'No billing account yet — subscribe to a plan first',
      );
    }

    const subscriptionIds = org.subscriptionId ? [org.subscriptionId] : [];
    const session = await this.paddle.customerPortalSessions.create(
      org.paddleCustomerId,
      subscriptionIds,
    );

    // Deep links come back per subscription; match ours rather than assuming
    // the customer has exactly one.
    const forSubscription = session.urls.subscriptions.find(
      (s) => s.id === org.subscriptionId,
    );

    this.logger.log(`Portal session created for org ${orgId}`);
    return {
      overviewUrl: session.urls.general.overview,
      updatePaymentMethodUrl: forSubscription?.updateSubscriptionPaymentMethod,
      cancelUrl: forSubscription?.cancelSubscription,
    };
  }

  // Kept for support/admin use — the customer-facing path is the portal's
  // cancel deep link, which runs Paddle's retention flow first.
  async cancelSubscription(
    orgId: string,
    userId: string,
  ): Promise<{ status: string }> {
    const org = await this.assertOwner(orgId, userId);
    if (!org.subscriptionId) {
      throw new BadRequestException('No active subscription');
    }

    const subscription = await this.paddle.subscriptions.cancel(
      org.subscriptionId,
      { effectiveFrom: 'next_billing_period' },
    );

    await this.orgsService.updateSubscription(orgId, {
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: true,
    });

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_canceled',
      orgId,
      orgName: org.name,
      plan: this.plansService.planName(org.productId),
    });

    this.logger.log(`Subscription cancellation scheduled for org ${orgId}`);
    return { status: subscription.status };
  }

  async handleWebhook(signature: string, payload: Buffer): Promise<void> {
    if (!this.webhookSecret) {
      this.logger.warn(
        'No PADDLE_WEBHOOK_SECRET set — skipping signature verification',
      );
      return;
    }

    // The endpoint is publicly reachable, so unsigned junk arrives on its own.
    // Reject it as a 400 rather than letting unmarshal throw a TypeError that
    // surfaces as a 500 and clutters the logs.
    if (!signature) {
      throw new BadRequestException('Missing paddle-signature header');
    }

    // unmarshal throws on a bad or expired (>5s old) signature. That's the
    // sender's problem, so answer 400 instead of letting it surface as a 500.
    let event: EventEntity;
    try {
      event = await this.paddle.webhooks.unmarshal(
        payload.toString(),
        this.webhookSecret,
        signature,
      );
    } catch (err) {
      this.logger.warn(`Rejected webhook: ${err}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    // Anything we don't act on is acked and dropped without touching the
    // database — the destination can stay subscribed to everything without
    // filling the dedup collection with price/payout/report noise.
    if (!HANDLED_EVENTS.has(event.eventType as EventName)) {
      this.logger.debug(`Ignoring unhandled ${event.eventType}`);
      return;
    }

    // One line per accepted event. Without it, "is the webhook even arriving?"
    // can only be answered by grepping for the absence of downstream effects.
    this.logger.log(`Webhook ${event.eventType} ${event.eventId}`);

    // Claim the event before doing any work. A redelivery of something we've
    // already handled loses the race here and returns without re-sending
    // emails or re-applying state.
    if (!(await this.claimEvent(event))) {
      this.logger.log(`Ignoring duplicate ${event.eventType} ${event.eventId}`);
      return;
    }

    try {
      await this.dispatch(event);
    } catch (err) {
      // Release the claim so Paddle's retry gets a real second attempt rather
      // than being deduped away.
      await this.webhookEventModel
        .deleteOne({ eventId: event.eventId })
        .exec()
        .catch(() => undefined);
      throw err;
    }
  }

  private async dispatch(event: EventEntity): Promise<void> {
    const occurredAt = this.toDate(event.occurredAt);

    switch (event.eventType) {
      case EventName.SubscriptionCreated:
        await this.onSubscriptionCreated(event.data, occurredAt);
        break;
      // activated/trialing fire around trial starts and conversions, past_due
      // and paused/resumed around dunning. They all carry the full subscription
      // entity, so the same handler keeps status and period end in step.
      case EventName.SubscriptionActivated:
      case EventName.SubscriptionTrialing:
      case EventName.SubscriptionPastDue:
      case EventName.SubscriptionPaused:
      case EventName.SubscriptionResumed:
      case EventName.SubscriptionUpdated:
        await this.onSubscriptionUpdated(event.data, occurredAt);
        break;
      case EventName.SubscriptionCanceled:
        await this.onSubscriptionCanceled(event.data, occurredAt);
        break;
      case EventName.TransactionCompleted:
        await this.onTransactionCompleted(event.data);
        break;
      case EventName.TransactionPaymentFailed:
        await this.onTransactionPaymentFailed(event.data);
        break;
      // Fires when the customer adds or removes a card in the Paddle portal,
      // which is the only way the card on file changes between payments.
      case EventName.PaymentMethodSaved:
      case EventName.PaymentMethodDeleted:
        await this.onPaymentMethodChanged(event.data.customerId);
        break;
      case EventName.AdjustmentCreated:
        await this.onAdjustmentCreated(event.data);
        break;
      case EventName.PriceCreated:
      case EventName.PriceUpdated:
      case EventName.ProductUpdated:
        await this.catalogService.invalidate();
        break;
    }
  }

  // Returns false when this event id has already been recorded.
  private async claimEvent(event: EventEntity): Promise<boolean> {
    try {
      await this.webhookEventModel.create({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: this.toDate(event.occurredAt),
      });
      return true;
    } catch (err: any) {
      if (err?.code === 11000) return false; // duplicate key = already seen
      throw err;
    }
  }

  private async onSubscriptionCreated(
    sub: SubscriptionNotification,
    occurredAt?: Date,
  ): Promise<void> {
    const orgId = this.extractOrgId(sub.customData);
    if (!orgId) {
      this.logger.warn(`subscription.created ${sub.id} missing customData.orgId`);
      return;
    }

    const org = await this.orgsService.findOne(orgId);
    if (!org) return;
    if (this.isStale(org, occurredAt)) {
      // A newer event (activated/updated) already recorded the subscription,
      // but only this one is guaranteed to arrive for every new subscription —
      // so the one-off work still happens here: the ended downgrade and stale
      // payer are cleared, the confirmation goes out, the replaced trial is
      // retired.
      if (org.subscriptionId === sub.id) {
        await this.clearEndedDowngrade(org);
        await this.sqsService.sendMessage(this.emailQueueUrl, {
          type: 'subscription_confirmed',
          orgId,
          orgName: org.name,
          plan: this.plansService.planName(this.planRefFor(sub).productId),
        });
      }
      await this.stampTrialUsed(org);
      await this.retireReplacedTrial(sub);
      return;
    }

    // A second live subscription landing on an org that already pays (two
    // checkouts completed, or a re-purchase while a webhook was delayed) would
    // overwrite the first one's id — leaving it billing with nothing tracking
    // it. The new one is still recorded; this makes sure someone refunds the
    // other. A trial this purchase replaces is expected and excluded.
    const replaces = (sub.customData as Record<string, unknown> | null)
      ?.replacesSubscriptionId;
    if (
      org.subscriptionId &&
      org.subscriptionId !== sub.id &&
      org.subscriptionId !== replaces &&
      hasActiveSubscription(org)
    ) {
      this.logger.error(
        `Org ${orgId} already has active subscription ${org.subscriptionId}; ${sub.id} replaces it — the old one is still billing`,
      );
      Sentry.captureMessage('Org received a second active Paddle subscription', {
        level: 'error',
        extra: { orgId, existing: org.subscriptionId, incoming: sub.id },
      });
    }

    const ref = this.planRefFor(sub);
    await this.orgsService.updateSubscription(orgId, {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
      subscriptionEventAt: occurredAt,
    });
    await this.clearEndedDowngrade(org);
    await this.stampTrialUsed(org);

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_confirmed',
      orgId,
      orgName: org.name,
      plan: this.plansService.planName(ref.productId),
    });

    this.logger.log(`Subscription activated for org ${orgId}`);

    await this.retireReplacedTrial(sub);
  }

  /**
   * A trial customer who bought a team plan (see createCheckoutSession) still
   * has their old trial running on the personal org. End it now that the
   * team subscription exists — their personal org falls back to the team
   * tier's included plan, so nothing lapses.
   *
   * The old subscription is tagged `replacedBy` first so its
   * subscription.canceled doesn't send a "your plan expired" email. Failures
   * are logged, not thrown: the team subscription is already recorded, and a
   * Paddle retry of this event would be deduped away anyway.
   */
  private async retireReplacedTrial(sub: SubscriptionNotification): Promise<void> {
    const data = sub.customData as Record<string, unknown> | null;
    const oldId = data?.replacesSubscriptionId;
    if (typeof oldId !== 'string' || oldId === sub.id) return;

    try {
      const old = await this.paddle.subscriptions.get(oldId);
      if (old.status === 'canceled') return;
      await this.paddle.subscriptions.update(oldId, {
        customData: { ...(old.customData ?? {}), replacedBy: sub.id },
      });
      await this.paddle.subscriptions.cancel(oldId, {
        effectiveFrom: 'immediately',
      });
      const holder = await this.orgsService.findBySubscriptionId(oldId);
      if (holder) await this.orgsService.clearSubscription(String(holder._id));
      this.logger.log(`Trial ${oldId} replaced by team subscription ${sub.id}`);
    } catch (err) {
      this.logger.error(
        `Could not cancel replaced trial ${oldId} for ${sub.id}: ${err}`,
      );
    }
  }

  private async onSubscriptionUpdated(
    sub: SubscriptionNotification,
    occurredAt?: Date,
  ): Promise<void> {
    if (this.replacedBy(sub)) return; // see retireReplacedTrial
    const org = await this.resolveOrg(sub.customData, sub.customerId, sub.id);
    if (!org || this.isStale(org, occurredAt)) return;

    const ref = this.planRefFor(sub);
    await this.orgsService.updateSubscription(org.id, {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: ref.priceId,
      productId: ref.productId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
      subscriptionEventAt: occurredAt,
    });
    // Normally done on subscription.created; this covers one that never
    // resolved to an org (missing customData) but whose later events did.
    if (!org.trialUsedAt) await this.stampTrialUsed(org);

    this.logger.log(`Subscription ${sub.status} for org ${org.id}`);
  }

  private async onSubscriptionCanceled(
    sub: SubscriptionNotification,
    occurredAt?: Date,
  ): Promise<void> {
    const org = await this.resolveOrg(sub.customData, sub.customerId, sub.id);
    if (!org || this.isStale(org, occurredAt)) return;

    // A trial retired by a team purchase: the org was already cleared, and
    // the customer is not losing anything, so no status write and no email.
    const replacedBy = this.replacedBy(sub);
    if (replacedBy) {
      this.logger.log(`Subscription ${sub.id} canceled (replaced by ${replacedBy})`);
      return;
    }

    const ref = this.planRefFor(sub);
    // `plan` is left in place so the account page can still name what they had
    // (and offer the same plan back). Access is gated on subscriptionStatus,
    // not on plan being set — see hasActiveSubscription.
    await this.orgsService.updateSubscription(org.id, {
      subscriptionStatus: sub.status,
      cancelAtPeriodEnd: false,
      subscriptionEventAt: occurredAt,
    });

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_expired',
      orgId: org.id,
      orgName: org.name,
      plan: this.plansService.planName(ref.productId),
    });

    this.logger.log(`Subscription deleted for org ${org.id}`);
  }

  private async onTransactionCompleted(
    tx: TransactionNotification,
  ): Promise<void> {
    const org = await this.resolveOrg(
      tx.customData,
      tx.customerId,
      tx.subscriptionId,
    );
    if (!org) return;

    const card = tx.payments.find((p) => p.methodDetails?.card)?.methodDetails
      ?.card;

    const update: SubscriptionUpdate = {};
    // First transaction of a new subscription can land before
    // subscription.created, in which case this is what records the customer id.
    if (tx.customerId && !org.paddleCustomerId) {
      update.paddleCustomerId = tx.customerId;
    }
    if (card) {
      update.cardBrand = card.type;
      update.cardLast4 = card.last4;
      update.cardExpMonth = card.expiryMonth;
      update.cardExpYear = card.expiryYear;
    }

    if (tx.origin === 'subscription_recurring' && tx.subscriptionId) {
      const subscription = await this.paddle.subscriptions.get(
        tx.subscriptionId,
      );
      update.currentPeriodEnd = this.toUnixSeconds(
        subscription.currentBillingPeriod?.endsAt,
      );
      update.subscriptionStatus = subscription.status;
      update.cancelAtPeriodEnd =
        subscription.scheduledChange?.action === 'cancel';
    }

    if (Object.keys(update).length > 0) {
      await this.orgsService.updateSubscription(org.id, update);
    }

    if (tx.origin === 'subscription_recurring') {
      const total = tx.details?.totals;
      await this.sqsService.sendMessage(this.emailQueueUrl, {
        type: 'payment_succeeded',
        orgId: org.id,
        orgName: org.name,
        plan: this.plansService.planName(org.productId),
        amountPaid: this.formatMinorUnits(total?.grandTotal),
        currency: total?.currencyCode?.toLowerCase() ?? '',
      });
      this.logger.log(`Payment succeeded for org ${org.id}`);
    } else {
      this.logger.log(`Transaction completed for org ${org.id}`);
    }
  }

  private async onTransactionPaymentFailed(
    tx: TransactionNotification,
  ): Promise<void> {
    const org = await this.resolveOrg(
      tx.customData,
      tx.customerId,
      tx.subscriptionId,
    );
    if (!org) return;

    const total = tx.details?.totals;
    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'payment_failed',
      orgId: org.id,
      orgName: org.name,
      plan: this.plansService.planName(org.productId),
      amountDue: this.formatMinorUnits(total?.grandTotal),
      currency: total?.currencyCode?.toLowerCase() ?? '',
    });

    this.logger.log(`Payment failed for org ${org.id}`);
  }

  // The payment_method.* payloads carry no card details, so re-read the
  // customer's saved methods and mirror whichever card is on file. Re-reading
  // rather than patching from the event also means an out-of-order
  // saved/deleted pair still settles on the truth.
  //
  // The card belongs to the Paddle customer, and one customer can pay for a
  // personal org and a team org, so every org carrying the id is updated.
  private async onPaymentMethodChanged(customerId: string): Promise<void> {
    const org = await this.orgsService.findByPaddleCustomerId(customerId);
    if (!org) return;

    const methods = await this.paddle.paymentMethods.list(customerId).next();
    const card = methods.find((method) => method.card)?.card;

    const updated = await this.orgsService.updateCardForCustomer(customerId, {
      cardBrand: card?.type ?? null,
      cardLast4: card?.last4 ?? null,
      cardExpMonth: card?.expiryMonth ?? null,
      cardExpYear: card?.expiryYear ?? null,
    });

    this.logger.log(
      card
        ? `Card on file updated for customer ${customerId} (${updated} org(s))`
        : `Card on file removed for customer ${customerId} (${updated} org(s))`,
    );
  }

  private async onAdjustmentCreated(
    adj: AdjustmentNotification,
  ): Promise<void> {
    const org = await this.resolveOrg(
      undefined,
      adj.customerId,
      adj.subscriptionId,
    );
    if (!org) return;

    const amount = `${this.formatMinorUnits(adj.totals?.total)} ${adj.currencyCode}`;

    // Every adjustment is mirrored onto the org, whether or not it changes
    // access, so support questions can be answered without the dashboard.
    await this.orgsService.recordBillingEvent(org.id, {
      action: adj.action,
      amount: this.formatMinorUnits(adj.totals?.total),
      currency: adj.currencyCode,
      status: adj.status,
      reason: adj.reason,
      adjustmentId: adj.id,
      transactionId: adj.transactionId,
      occurredAt: this.toDate(adj.createdAt),
    });

    switch (adj.action) {
      // Only a settled chargeback blocks access. `chargeback_warning` is an
      // early notice from the card network that often reverses, and taking
      // access away from someone who turns out to be fine is worse than
      // carrying a possible loss for a few days.
      case 'chargeback':
        await this.orgsService.updateSubscription(org.id, {
          billingBlocked: true,
        });
        this.logger.warn(
          `Chargeback of ${amount} on org ${org.id} — access blocked`,
        );
        break;
      case 'chargeback_reverse':
        await this.orgsService.updateSubscription(org.id, {
          billingBlocked: false,
        });
        this.logger.log(
          `Chargeback reversed (${amount}) on org ${org.id} — access restored`,
        );
        break;
      default:
        // Refunds, credits, and chargeback warnings: Paddle emails the
        // customer as merchant of record, and cancels the subscription
        // separately if that was the deal, so there's nothing to change.
        this.logger.log(
          `Adjustment ${adj.action} of ${amount} on org ${org.id}`,
        );
    }
  }

  /** Set on a trial retired by a team purchase — its later events are noise. */
  private replacedBy(sub: SubscriptionNotification): string | undefined {
    const value = (sub.customData as Record<string, unknown> | null)?.replacedBy;
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Which of a subscription's items is the plan.
   *
   * A subscription can carry several items — a base plan plus add-ons — and
   * nothing guarantees the plan is first, so prefer the first item whose
   * product we actually recognise instead of trusting position zero. If none
   * match, fall back to the first item so the org still records what it bought
   * and getLimits can report the unmapped product.
   */
  private planRefFor(sub: SubscriptionNotification): PlanRef {
    return pickPlanRef(sub.items, (ref) => !!this.plansService.findTier(ref.productId));
  }

  // Paddle copies a transaction's custom_data onto the subscription it creates,
  // and a subscription's custom_data onto its later transactions — so orgId is
  // on every event in the lifecycle. paddleCustomerId is only the fallback:
  // webhooks aren't delivered in order, so transaction.completed can arrive
  // before subscription.created has stored the customer id.
  //
  // subscriptionId comes first when the event has one: the org currently
  // holding a subscription is authoritative. After an upgrade moves a
  // subscription to a team org, a delayed event still carrying the old
  // customData would otherwise write it straight back onto the personal org.
  private async resolveOrg(
    customData: unknown,
    customerId?: string | null,
    subscriptionId?: string | null,
  ): Promise<Org | null> {
    if (subscriptionId) {
      const holder = await this.orgsService.findBySubscriptionId(subscriptionId);
      if (holder) return holder;
    }
    const orgId = this.extractOrgId(customData);
    if (orgId) {
      const org = await this.orgsService.findOne(orgId);
      if (org) return org;
    }
    if (customerId) {
      return this.orgsService.findByPaddleCustomerId(customerId);
    }
    return null;
  }

  // Paddle makes no ordering guarantee, so a delayed event must not overwrite
  // state a newer one already applied.
  private isStale(org: Org, occurredAt?: Date): boolean {
    if (!occurredAt || !org.subscriptionEventAt) return false;
    if (occurredAt >= org.subscriptionEventAt) return false;
    this.logger.log(
      `Skipping out-of-order subscription event for org ${org.id}`,
    );
    return true;
  }

  private toDate(iso: string | null | undefined): Date | undefined {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : new Date(ms);
  }

  private extractOrgId(customData: unknown): string | undefined {
    if (customData && typeof customData === 'object' && 'orgId' in customData) {
      const orgId = (customData as { orgId: unknown }).orgId;
      return typeof orgId === 'string' ? orgId : undefined;
    }
    return undefined;
  }

  private toUnixSeconds(iso: string | null | undefined): number | undefined {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }

  private formatMinorUnits(minor: string | null | undefined): string {
    if (!minor) return '0.00';
    const n = Number(minor);
    return Number.isFinite(n) ? (n / 100).toFixed(2) : '0.00';
  }

}

/**
 * Paddle rejects some changes outright (a trialing subscription, a charge that
 * fails under `prevent_change`). Those are the customer's answer, not our
 * outage — surface Paddle's explanation as a 400 rather than a bare 500.
 */
function rethrowPaddleRefusal(err: any): never {
  if (err?.type === 'request_error' && typeof err.detail === 'string') {
    throw new BadRequestException({ message: err.detail, code: err.code });
  }
  throw err;
}
