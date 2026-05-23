import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Environment,
  EventName,
  Paddle,
  type SubscriptionNotification,
  type TransactionNotification,
} from '@paddle/paddle-node-sdk';
import { OrgsService } from '../orgs/orgs.service';
import { SqsService } from '../sqs/sqs.service';

type SubscriptionUpdate = Parameters<OrgsService['updateSubscription']>[1];

@Injectable()
export class PaymentsService {
  private paddle: Paddle;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject('PADDLE_API_KEY') private readonly apiKey: string,
    @Inject('PADDLE_WEBHOOK_SECRET') private readonly webhookSecret: string,
    @Inject('PADDLE_ENVIRONMENT') private readonly paddleEnvironment: string,
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
    private readonly orgsService: OrgsService,
    private readonly sqsService: SqsService,
  ) {
    this.paddle = new Paddle(this.apiKey, {
      environment:
        this.paddleEnvironment === 'production'
          ? Environment.production
          : Environment.sandbox,
    });
  }

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

  async cancelSubscription(orgId: string): Promise<{ status: string }> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new Error('Organization not found');
    if (!org.subscriptionId) throw new Error('No active subscription');

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
      plan: this.getPlanName(org.plan),
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

    const event = await this.paddle.webhooks.unmarshal(
      payload.toString(),
      this.webhookSecret,
      signature,
    );

    switch (event.eventType) {
      case EventName.SubscriptionCreated:
        await this.onSubscriptionCreated(event.data);
        break;
      case EventName.SubscriptionUpdated:
        await this.onSubscriptionUpdated(event.data);
        break;
      case EventName.SubscriptionCanceled:
        await this.onSubscriptionCanceled(event.data);
        break;
      case EventName.TransactionCompleted:
        await this.onTransactionCompleted(event.data);
        break;
      case EventName.TransactionPaymentFailed:
        await this.onTransactionPaymentFailed(event.data);
        break;
    }
  }

  private async onSubscriptionCreated(
    sub: SubscriptionNotification,
  ): Promise<void> {
    const orgId = this.extractOrgId(sub.customData);
    if (!orgId) {
      this.logger.warn(`subscription.created ${sub.id} missing customData.orgId`);
      return;
    }

    const org = await this.orgsService.findOne(orgId);
    if (!org) return;

    const priceId = sub.items[0]?.price?.id;
    await this.orgsService.updateSubscription(orgId, {
      paddleCustomerId: sub.customerId,
      subscriptionId: sub.id,
      plan: priceId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
    });

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_confirmed',
      orgId,
      orgName: org.name,
      plan: this.getPlanName(priceId),
    });

    this.logger.log(`Subscription activated for org ${orgId}`);
  }

  private async onSubscriptionUpdated(
    sub: SubscriptionNotification,
  ): Promise<void> {
    const org = await this.orgsService.findByPaddleCustomerId(sub.customerId);
    if (!org) return;

    const priceId = sub.items[0]?.price?.id;
    await this.orgsService.updateSubscription(org.id, {
      plan: priceId,
      subscriptionStatus: sub.status,
      currentPeriodEnd: this.toUnixSeconds(sub.currentBillingPeriod?.endsAt),
      cancelAtPeriodEnd: sub.scheduledChange?.action === 'cancel',
    });

    this.logger.log(`Subscription ${sub.status} for org ${org.id}`);
  }

  private async onSubscriptionCanceled(
    sub: SubscriptionNotification,
  ): Promise<void> {
    const org = await this.orgsService.findByPaddleCustomerId(sub.customerId);
    if (!org) return;

    const priceId = sub.items[0]?.price?.id;
    await this.orgsService.updateSubscription(org.id, {
      subscriptionStatus: sub.status,
      cancelAtPeriodEnd: false,
    });

    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'subscription_expired',
      orgId: org.id,
      orgName: org.name,
      plan: this.getPlanName(priceId),
    });

    this.logger.log(`Subscription deleted for org ${org.id}`);
  }

  private async onTransactionCompleted(
    tx: TransactionNotification,
  ): Promise<void> {
    if (!tx.customerId) return;
    const org = await this.orgsService.findByPaddleCustomerId(tx.customerId);
    if (!org) return;

    const card = tx.payments.find((p) => p.methodDetails?.card)?.methodDetails
      ?.card;

    const update: SubscriptionUpdate = {};
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
        plan: this.getPlanName(org.plan),
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
    if (!tx.customerId) return;
    const org = await this.orgsService.findByPaddleCustomerId(tx.customerId);
    if (!org) return;

    const total = tx.details?.totals;
    await this.sqsService.sendMessage(this.emailQueueUrl, {
      type: 'payment_failed',
      orgId: org.id,
      orgName: org.name,
      plan: this.getPlanName(org.plan),
      amountDue: this.formatMinorUnits(total?.grandTotal),
      currency: total?.currencyCode?.toLowerCase() ?? '',
    });

    this.logger.log(`Payment failed for org ${org.id}`);
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

  private getPlanName(priceId?: string): string {
    const plans: Record<string, string> = {
      pri_01kr05y9cq25yt75ey1ddkpger: 'Basic Monthly',
      pri_01kr07scygf6jf4a2xbvra76y6: 'Basic Yearly',
      pri_01kr07vbve5a770reznmza9hdq: 'Pro Monthly',
      pri_01kr07vyv692rrj6gn8m57e683: 'Pro Yearly',
      pri_01kr07xbjrdw0jztyfta1xfqre: 'Enterprise Monthly',
      pri_01kr07xy7sty2xhwcqjgzny8x4: 'Enterprise Yearly',
    };
    return priceId ? plans[priceId] || priceId : 'Unknown';
  }
}
