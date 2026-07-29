import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { Model } from 'mongoose';
import { Paddle } from '@paddle/paddle-node-sdk';
import { PADDLE_CLIENT } from '../paddle/paddle.module';
import { PlanLimits } from './interfaces/plan.interface';
import { PLAN_TIERS, PlanTier } from './plan-catalog';
import { PADDLE_CATALOG_MODEL } from './plans.providers';
import {
  CATALOG_DOC_ID,
  PaddleCatalogDoc,
  StoredPrice,
} from './schemas/paddle-catalog.schema';

/** Billing intervals the pricing page renders. */
export type BillingInterval = 'month' | 'year';

export interface CatalogPrice {
  id: string;
  /** Major units, e.g. "25.00". */
  amount: string;
  currency: string;
  /** Null when the price has no trial. */
  trial: { interval: string; frequency: number } | null;
}

export interface CatalogPlan {
  name: string;
  description: string;
  features: string[];
  featured: boolean;
  cta: string;
  limits: PlanLimits;
  prices: Partial<Record<BillingInterval, CatalogPrice>>;
}

export interface Catalog {
  plans: CatalogPlan[];
  /**
   * live   — read from Paddle during this request
   * cache  — served from the stored catalog
   * unavailable — nothing stored and Paddle unreachable; the pricing page must
   *               say so rather than render an empty or stale set
   */
  source: 'live' | 'cache' | 'unavailable';
}

type RefreshResult =
  | { status: 'refreshed'; prices: StoredPrice[] }
  | { status: 'skipped' }
  | { status: 'failed' };

/** How old the stored catalog may get before a read triggers a refresh. */
const STALE_AFTER_MS = 15 * 60 * 1000;
/** How long one instance may hold the refresh lease. */
const LEASE_MS = 60 * 1000;
/** Guard against paginating forever if a filter is ever wrong. */
const MAX_PRICES = 500;

/**
 * The price catalog, mirrored from Paddle into Mongo.
 *
 * Mongo rather than Redis on purpose: the last-known-good copy exists to
 * survive a Paddle outage, and the deployed Redis runs with persistence
 * disabled — it would lose the catalog on any restart. Mongo is also shared
 * across replicas, so a webhook-driven refresh on one instance is seen by all
 * of them, which an in-process cache can't do.
 */
@Injectable()
export class PaddleCatalogService {
  private readonly logger = new Logger(PaddleCatalogService.name);

  constructor(
    @Inject(PADDLE_CLIENT) private readonly paddle: Paddle,
    @Inject(PADDLE_CATALOG_MODEL)
    private readonly catalogModel: Model<any>,
  ) {}

  async getCatalog(): Promise<Catalog> {
    const doc = await this.read();

    // Cold start: nothing stored yet, so this request has to wait for Paddle.
    if (!doc?.prices?.length) {
      const result = await this.refresh();
      if (result.status !== 'refreshed') {
        return { plans: [], source: 'unavailable' };
      }
      return { plans: this.buildPlans(result.prices), source: 'live' };
    }

    // Stale-while-revalidate: answer from what we have, refresh behind it. The
    // TTL is the backstop for a webhook that never arrived — a misconfigured
    // destination or an edit made while the endpoint was unreachable.
    if (this.isStale(doc)) {
      void this.refresh().catch(() => undefined);
    }

    return { plans: this.buildPlans(doc.prices), source: 'cache' };
  }

  /**
   * Called from the price.* / product.* webhooks so a dashboard edit shows up
   * without waiting out the TTL.
   */
  async invalidate(): Promise<void> {
    const result = await this.refresh();

    switch (result.status) {
      case 'refreshed':
        this.logger.log(`Price catalog refreshed (${result.prices.length} prices)`);
        break;
      case 'skipped':
        // Another instance is mid-refresh, so we can't read now. Clearing
        // fetchedAt makes the stored copy stale, so the next read refreshes
        // instead of the webhook silently having no effect for a full TTL.
        await this.markStale();
        this.logger.log('Price catalog marked stale — a refresh is already in flight');
        break;
      case 'failed':
        // Deliberately not marked stale: if Paddle is down, every read would
        // then retry it. The TTL already covers eventual recovery.
        this.logger.warn('Price catalog refresh failed — keeping stored catalog');
        break;
    }
  }

  /**
   * Re-read from Paddle and store.
   *
   * `skipped` means another instance holds the lease and is doing it right now;
   * `failed` means Paddle errored or returned nothing. The two are distinct
   * because callers respond differently — see invalidate. In neither case is
   * the stored catalog touched: a bad read must never destroy a good catalog.
   */
  private async refresh(): Promise<RefreshResult> {
    if (!(await this.acquireLease())) return { status: 'skipped' };

    try {
      const prices = await this.fetchPrices();

      if (!prices.length) {
        this.logger.warn(
          'Paddle returned no prices — keeping the stored catalog. If the ' +
            'pricing page is empty, check that prices have custom_data ' +
            '{"display": true} and a product mapped in plan-catalog.ts',
        );
        return { status: 'failed' };
      }

      await this.catalogModel
        .updateOne(
          { _id: CATALOG_DOC_ID },
          { $set: { prices, fetchedAt: new Date() } },
          { upsert: true },
        )
        .exec();

      return { status: 'refreshed', prices };
    } catch (err) {
      this.logger.error(`Failed to read price catalog from Paddle: ${err}`);
      Sentry.captureException(err);
      return { status: 'failed' };
    } finally {
      await this.releaseLease();
    }
  }

  /** Forces the next read to refresh, without touching the stored prices. */
  private async markStale(): Promise<void> {
    await this.catalogModel
      .updateOne({ _id: CATALOG_DOC_ID }, { $unset: { fetchedAt: '' } })
      .exec()
      .catch(() => undefined);
  }

  private async read(): Promise<PaddleCatalogDoc | null> {
    return this.catalogModel
      .findById(CATALOG_DOC_ID)
      .lean<PaddleCatalogDoc>()
      .exec()
      .catch(() => null);
  }

  private isStale(doc: PaddleCatalogDoc): boolean {
    if (!doc.fetchedAt) return true;
    return Date.now() - new Date(doc.fetchedAt).getTime() > STALE_AFTER_MS;
  }

  /**
   * Only one instance refreshes at a time. Without this, four replicas coming
   * up cold would each hammer Paddle for the same data. The lease expires on
   * its own so a crash mid-refresh can't wedge the catalog permanently.
   */
  private async acquireLease(): Promise<boolean> {
    const now = new Date();

    // Make sure the doc exists so the conditional update below has something
    // to match; upsert-with-condition would race into a duplicate key.
    await this.catalogModel
      .updateOne(
        { _id: CATALOG_DOC_ID },
        { $setOnInsert: { prices: [] } },
        { upsert: true },
      )
      .exec()
      .catch((err: any) => {
        if (err?.code !== 11000) throw err; // lost the create race, fine
      });

    const res = await this.catalogModel
      .updateOne(
        {
          _id: CATALOG_DOC_ID,
          $or: [
            { refreshLeaseUntil: { $exists: false } },
            { refreshLeaseUntil: null },
            { refreshLeaseUntil: { $lte: now } },
          ],
        },
        { $set: { refreshLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
      )
      .exec();

    return (res?.modifiedCount ?? 0) > 0;
  }

  private async releaseLease(): Promise<void> {
    await this.catalogModel
      .updateOne({ _id: CATALOG_DOC_ID }, { $set: { refreshLeaseUntil: null } })
      .exec()
      .catch(() => undefined);
  }

  private async fetchPrices(): Promise<StoredPrice[]> {
    const collection = this.paddle.prices.list({
      status: ['active'],
      recurring: true,
      perPage: 100,
    });

    const prices: StoredPrice[] = [];
    for await (const price of collection) {
      prices.push({
        id: price.id,
        productId: price.productId,
        status: price.status,
        createdAt: price.createdAt,
        billingCycle: price.billingCycle
          ? {
              interval: price.billingCycle.interval,
              frequency: price.billingCycle.frequency,
            }
          : null,
        trialPeriod: price.trialPeriod
          ? {
              interval: price.trialPeriod.interval,
              frequency: price.trialPeriod.frequency,
            }
          : null,
        unitPrice: price.unitPrice
          ? {
              amount: price.unitPrice.amount,
              currencyCode: price.unitPrice.currencyCode,
            }
          : null,
        customData: (price.customData as Record<string, unknown>) ?? null,
      });

      if (prices.length >= MAX_PRICES) {
        this.logger.warn(
          `Stopped reading prices at ${MAX_PRICES} — check the list filters`,
        );
        break;
      }
    }
    return prices;
  }

  private buildPlans(prices: StoredPrice[]): CatalogPlan[] {
    // tier name -> interval -> price, so a superseded price that's still active
    // for existing subscribers can't outrank its replacement.
    const chosen = new Map<
      string,
      Partial<Record<BillingInterval, StoredPrice>>
    >();

    for (const price of prices) {
      if (!this.isDisplayed(price)) continue;

      const interval = this.intervalOf(price);
      if (!interval) continue;

      // The AND rule: Paddle says show it, and our code knows how to entitle
      // it. A price flagged for a product we can't entitle is refused loudly
      // rather than sold — hiding a plan is recoverable, selling one we can't
      // grant is not.
      const tier = this.tierFor(price);
      if (!tier) {
        this.logger.error(
          `Price ${price.id} is flagged for display but product ${price.productId} has no entitlement mapping — refusing to sell it`,
        );
        Sentry.captureMessage(
          `Displayed Paddle price has no entitlement mapping: ${price.id}`,
          {
            level: 'error',
            extra: { priceId: price.id, productId: price.productId },
          },
        );
        continue;
      }

      const forTier = chosen.get(tier.name) ?? {};
      const existing = forTier[interval];
      if (existing) {
        this.logger.warn(
          `Two ${interval}ly prices flagged for ${tier.name} (${existing.id}, ${price.id}) — using the newer`,
        );
        if (existing.createdAt >= price.createdAt) continue;
      }

      forTier[interval] = price;
      chosen.set(tier.name, forTier);
    }

    // Preserve catalog order (least to most generous) rather than Paddle's.
    return PLAN_TIERS.filter((tier) => chosen.has(tier.name)).map((tier) => {
      const picked = chosen.get(tier.name)!;
      const prices: CatalogPlan['prices'] = {};
      for (const interval of ['month', 'year'] as BillingInterval[]) {
        const entry = picked[interval];
        if (entry) prices[interval] = this.toCatalogPrice(entry);
      }
      return {
        name: tier.name,
        description: tier.description,
        features: tier.features,
        featured: tier.featured,
        cta: tier.cta,
        limits: tier.limits,
        prices,
      };
    });
  }

  /**
   * Only prices explicitly flagged in Paddle are sellable.
   *
   * Accepts the string "true" as well as the boolean: the dashboard's
   * custom-data editor stores values as text, and a price that looks flagged in
   * the UI but reads as unflagged here is a miserable thing to debug.
   * Everything else — "yes", 1, a typo'd key — is still false, so a mistake
   * hides a plan (obvious) rather than exposing one (not).
   */
  private isDisplayed(price: StoredPrice): boolean {
    const flag = price.customData?.display;
    return (
      flag === true ||
      (typeof flag === 'string' && flag.toLowerCase() === 'true')
    );
  }

  private intervalOf(price: StoredPrice): BillingInterval | null {
    const interval = price.billingCycle?.interval;
    return interval === 'month' || interval === 'year' ? interval : null;
  }

  private tierFor(price: StoredPrice): PlanTier | null {
    return (
      PLAN_TIERS.find((t) => t.productId && t.productId === price.productId) ??
      PLAN_TIERS.find((t) => t.priceIds.includes(price.id)) ??
      null
    );
  }

  private toCatalogPrice(price: StoredPrice): CatalogPrice {
    return {
      id: price.id,
      amount: this.toMajorUnits(price.unitPrice?.amount),
      currency: price.unitPrice?.currencyCode ?? 'USD',
      trial: price.trialPeriod,
    };
  }

  private toMajorUnits(minor: string | undefined): string {
    const n = Number(minor);
    return Number.isFinite(n) ? (n / 100).toFixed(2) : '0.00';
  }
}
