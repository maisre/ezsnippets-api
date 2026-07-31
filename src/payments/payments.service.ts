import {
  BadRequestException,
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
  type SubscriptionNotification,
  type TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { Model } from 'mongoose';
import { Org } from '../orgs/interfaces/org.interface';
import { OrgsService } from '../orgs/orgs.service';
import { pickPlanRef, PlanRef } from '../plans/plan-catalog';
import { PaddleCatalogService } from '../plans/paddle-catalog.service';
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
  ) {}

  // Create a Paddle Transaction the frontend will open via Paddle.Checkout.open({ transactionId })
  async createCheckoutSession(
    orgId: string,
    priceId: string,
  ): Promise<{ transactionId: string }> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new Error('Organization not found');

    const transaction = await this.paddle.transactions.create({
      items: [{ priceId, quantity: 1 }],
      customerId: org.paddleCustomerId ?? null,
      customData: { orgId },
    });

    this.logger.log(`Transaction ${transaction.id} created for org ${orgId}`);
    return { transactionId: transaction.id };
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

    const event = await this.paddle.webhooks.unmarshal(
      payload.toString(),
      this.webhookSecret,
      signature,
    );

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
    if (!org || this.isStale(org, occurredAt)) return;

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

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_confirmed',
      orgId,
      orgName: org.name,
      plan: this.plansService.planName(ref.productId),
    });

    this.logger.log(`Subscription activated for org ${orgId}`);
  }

  private async onSubscriptionUpdated(
    sub: SubscriptionNotification,
    occurredAt?: Date,
  ): Promise<void> {
    const org = await this.resolveOrg(sub.customData, sub.customerId);
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

    this.logger.log(`Subscription ${sub.status} for org ${org.id}`);
  }

  private async onSubscriptionCanceled(
    sub: SubscriptionNotification,
    occurredAt?: Date,
  ): Promise<void> {
    const org = await this.resolveOrg(sub.customData, sub.customerId);
    if (!org || this.isStale(org, occurredAt)) return;

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
    const org = await this.resolveOrg(tx.customData, tx.customerId);
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
    const org = await this.resolveOrg(tx.customData, tx.customerId);
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
  private async onPaymentMethodChanged(customerId: string): Promise<void> {
    const org = await this.orgsService.findByPaddleCustomerId(customerId);
    if (!org) return;

    const methods = await this.paddle.paymentMethods.list(customerId).next();
    const card = methods.find((method) => method.card)?.card;

    await this.orgsService.updateSubscription(org.id, {
      cardBrand: card?.type ?? null,
      cardLast4: card?.last4 ?? null,
      cardExpMonth: card?.expiryMonth ?? null,
      cardExpYear: card?.expiryYear ?? null,
    });

    this.logger.log(
      card
        ? `Card on file updated for org ${org.id}`
        : `Card on file removed for org ${org.id}`,
    );
  }

  private async onAdjustmentCreated(
    adj: AdjustmentNotification,
  ): Promise<void> {
    const org = await this.resolveOrg(undefined, adj.customerId);
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
  private async resolveOrg(
    customData: unknown,
    customerId?: string | null,
  ): Promise<Org | null> {
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
