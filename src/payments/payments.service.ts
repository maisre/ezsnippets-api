import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrgsService } from '../orgs/orgs.service';
import { SqsService } from '../sqs/sqs.service';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private stripe: Stripe;
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject('STRIPE_API_KEY') private readonly apiKey: string,
    @Inject('STRIPE_WEBHOOK_SECRET') private readonly webhookSecret: string,
    @Inject('EMAIL_QUEUE_URL') private readonly emailQueueUrl: string,
    private readonly orgsService: OrgsService,
    private readonly sqsService: SqsService,
  ) {
    this.stripe = new Stripe(this.apiKey, {
      apiVersion: '2025-09-30.clover',
    });
  }

  // Get Products
  async getProducts(): Promise<Stripe.Product[]> {
    try {
      const products = await this.stripe.products.list();
      this.logger.log('Products fetched successfully');
      return products.data;
    } catch (error) {
      this.logger.error('Failed to fetch products', error.stack);
      throw error;
    }
  }

  // Get Customers
  async getCustomers() {
    try {
      const customers = await this.stripe.customers.list({});
      this.logger.log('Customers fetched successfully');
      return customers.data;
    } catch (error) {
      this.logger.error('Failed to fetch products', error.stack);
      throw error;
    }
  }

  // Accept Payments (Create Payment Intent)
  async createPaymentIntent(
    amount: number,
    currency: string,
  ): Promise<Stripe.PaymentIntent> {
    try {
      const paymentIntent = await this.stripe.paymentIntents.create({
        payment_method_types: ['card'],
        amount,
        currency,
      });
      this.logger.log(
        `PaymentIntent created successfully with amount: ${amount} ${currency}`,
      );
      return paymentIntent;
    } catch (error) {
      this.logger.error('Failed to create PaymentIntent', error.stack);
      throw error;
    }
  }

  // Subscriptions (Create Subscription)
  async createSubscription(
    customerId: string,
    priceId: string,
  ): Promise<Stripe.Subscription> {
    try {
      const subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
      });
      this.logger.log(
        `Subscription created successfully for customer ${customerId}`,
      );
      return subscription;
    } catch (error) {
      this.logger.error('Failed to create subscription', error.stack);
      throw error;
    }
  }

  // Customer Management (Create Customer)
  async createCustomer(email: string, name: string): Promise<Stripe.Customer> {
    try {
      const customer = await this.stripe.customers.create({ email, name });
      this.logger.log(`Customer created successfully with email: ${email}`);
      return customer;
    } catch (error) {
      this.logger.error('Failed to create customer', error.stack);
      throw error;
    }
  }

  // Product & Pricing Management (Create Product with Price)
  async createProduct(
    name: string,
    description: string,
    price: number,
  ): Promise<Stripe.Product> {
    try {
      const product = await this.stripe.products.create({ name, description });
      await this.stripe.prices.create({
        product: product.id,
        unit_amount: price * 100, // amount in cents
        currency: 'usd',
      });
      this.logger.log(`Product created successfully: ${name}`);
      return product;
    } catch (error) {
      this.logger.error('Failed to create product', error.stack);
      throw error;
    }
  }

  // Refunds (Process Refund)
  async refundPayment(paymentIntentId: string): Promise<Stripe.Refund> {
    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: paymentIntentId,
      });
      this.logger.log(
        `Refund processed successfully for PaymentIntent: ${paymentIntentId}`,
      );
      return refund;
    } catch (error) {
      this.logger.error('Failed to process refund', error.stack);
      throw error;
    }
  }

  // Payment Method Integration (Attach Payment Method)
  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    try {
      await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
      this.logger.log(
        `Payment method ${paymentMethodId} attached to customer ${customerId}`,
      );
    } catch (error) {
      this.logger.error('Failed to attach payment method', error.stack);
      throw error;
    }
  }

  // Reports and Analytics (Retrieve Balance)
  async getBalance(): Promise<Stripe.Balance> {
    try {
      const balance = await this.stripe.balance.retrieve();
      this.logger.log('Balance retrieved successfully');
      return balance;
    } catch (error) {
      this.logger.error('Failed to retrieve balance', error.stack);
      throw error;
    }
  }

  // Checkout Session
  async createCheckoutSession(
    orgId: string,
    priceId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<{ url: string | null }> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new Error('Organization not found');

    let customerId = org.stripeCustomerId;

    if (!customerId) {
      const customer = await this.stripe.customers.create({
        metadata: { orgId },
      });
      customerId = customer.id;
      await this.orgsService.updateSubscription(orgId, {
        stripeCustomerId: customerId,
      });
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    this.logger.log(`Checkout session created for org ${orgId}`);
    return { url: session.url };
  }

  // Webhook
  async handleWebhook(signature: string, payload: Buffer): Promise<void> {
    let event: Stripe.Event;

    if (this.webhookSecret) {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret,
      );
    } else {
      event = JSON.parse(payload.toString()) as Stripe.Event;
      this.logger.warn(
        'No STRIPE_WEBHOOK_SECRET set — skipping signature verification',
      );
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.customer) {
          const customerId =
            typeof session.customer === 'string'
              ? session.customer
              : session.customer.id;
          const subscriptionId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id;

          const org =
            await this.orgsService.findByStripeCustomerId(customerId);
          if (org && subscriptionId) {
            const subscription =
              await this.stripe.subscriptions.retrieve(subscriptionId, {
                expand: ['default_payment_method'],
              });
            const priceId = subscription.items.data[0]?.price?.id;

            const updateData: Parameters<typeof this.orgsService.updateSubscription>[1] = {
              subscriptionId,
              plan: priceId,
              subscriptionStatus: subscription.status,
              currentPeriodEnd: subscription.items.data[0]?.current_period_end,
            };

            const pm = subscription.default_payment_method;
            if (pm && typeof pm !== 'string' && pm.card) {
              updateData.cardBrand = pm.card.brand;
              updateData.cardLast4 = pm.card.last4;
              updateData.cardExpMonth = pm.card.exp_month;
              updateData.cardExpYear = pm.card.exp_year;
            }

            await this.orgsService.updateSubscription(org.id, updateData);

            await this.sqsService.sendMessage(this.emailQueueUrl, {
              type: 'subscription_confirmed',
              orgId: org.id,
              orgName: org.name,
              plan: this.getPlanName(priceId),
            });

            this.logger.log(`Subscription activated for org ${org.id}`);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id;

        const org = await this.orgsService.findByStripeCustomerId(customerId);
        if (org) {
          const priceId = subscription.items.data[0]?.price?.id;
          const updateData: Parameters<typeof this.orgsService.updateSubscription>[1] = {
            plan: priceId,
            subscriptionStatus: subscription.status,
            currentPeriodEnd: subscription.items.data[0]?.current_period_end,
          };

          const pm = subscription.default_payment_method;
          if (pm && typeof pm !== 'string' && pm.card) {
            updateData.cardBrand = pm.card.brand;
            updateData.cardLast4 = pm.card.last4;
            updateData.cardExpMonth = pm.card.exp_month;
            updateData.cardExpYear = pm.card.exp_year;
          }

          await this.orgsService.updateSubscription(org.id, updateData);
          this.logger.log(
            `Subscription ${subscription.status} for org ${org.id}`,
          );
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId =
          typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id;

        const org = await this.orgsService.findByStripeCustomerId(customerId);
        if (org) {
          const priceId = subscription.items.data[0]?.price?.id;
          await this.orgsService.updateSubscription(org.id, {
            subscriptionStatus: subscription.status,
          });

          await this.sqsService.sendMessage(this.emailQueueUrl, {
            type: 'subscription_expired',
            orgId: org.id,
            orgName: org.name,
            plan: this.getPlanName(priceId),
          });

          this.logger.log(`Subscription deleted for org ${org.id}`);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason === 'subscription_cycle') {
          const customerId =
            typeof invoice.customer === 'string'
              ? invoice.customer
              : invoice.customer?.id;

          if (customerId) {
            const org =
              await this.orgsService.findByStripeCustomerId(customerId);
            if (org) {
              await this.sqsService.sendMessage(this.emailQueueUrl, {
                type: 'payment_succeeded',
                orgId: org.id,
                orgName: org.name,
                plan: this.getPlanName(org.plan),
                amountPaid: (invoice.amount_paid / 100).toFixed(2),
                currency: invoice.currency,
              });

              this.logger.log(`Payment succeeded for org ${org.id}`);
            }
          }
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === 'string'
            ? invoice.customer
            : invoice.customer?.id;

        if (customerId) {
          const org =
            await this.orgsService.findByStripeCustomerId(customerId);
          if (org) {
            await this.sqsService.sendMessage(this.emailQueueUrl, {
              type: 'payment_failed',
              orgId: org.id,
              orgName: org.name,
              plan: this.getPlanName(org.plan),
              amountDue: (invoice.amount_due / 100).toFixed(2),
              currency: invoice.currency,
            });

            this.logger.log(`Payment failed for org ${org.id}`);
          }
        }
        break;
      }
    }
  }

  // Cancel Subscription
  async cancelSubscription(orgId: string): Promise<{ status: string }> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) throw new Error('Organization not found');
    if (!org.subscriptionId) throw new Error('No active subscription');

    const subscription = await this.stripe.subscriptions.update(
      org.subscriptionId,
      { cancel_at_period_end: true },
    );

    await this.orgsService.updateSubscription(orgId, {
      subscriptionStatus: subscription.status,
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

  private getPlanName(priceId?: string): string {
    const plans: Record<string, string> = {
      price_1T7oWwBCIaRH2MSXeaIC22S7: 'Basic Monthly',
      price_1T7oWyBCIaRH2MSXa7dFawYC: 'Basic Yearly',
      price_1T7oX0BCIaRH2MSX8fA87eOt: 'Pro Monthly',
      price_1T7oX1BCIaRH2MSX9EqkbIi9: 'Pro Yearly',
      price_1T7oX3BCIaRH2MSXeILwubbY: 'Enterprise Monthly',
      price_1T7oX5BCIaRH2MSX4MpR0WmU: 'Enterprise Yearly',
    };
    return priceId ? plans[priceId] || priceId : 'Unknown';
  }

  // Payment Links
  async createPaymentLink(priceId: string): Promise<Stripe.PaymentLink> {
    try {
      const paymentLink = await this.stripe.paymentLinks.create({
        line_items: [{ price: priceId, quantity: 1 }],
      });
      this.logger.log('Payment link created successfully');
      return paymentLink;
    } catch (error) {
      this.logger.error('Failed to create payment link', error.stack);
      throw error;
    }
  }
}
