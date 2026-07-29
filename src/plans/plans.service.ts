import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PlanLimits } from './interfaces/plan.interface';
import { FALLBACK_TIER, PLAN_TIERS, PlanRef, PlanTier } from './plan-catalog';

export type { PlanRef };

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @Inject('PLAN_LIMITS_OVERRIDE')
    private readonly limitsOverride: string | undefined,
  ) {}

  findAll(): PlanTier[] {
    return PLAN_TIERS;
  }

  /**
   * The tier a subscription entitles, or null if we don't recognise it.
   * productId wins; priceId is the fallback for tiers whose product id isn't
   * filled in yet, and for prices that predate a tier's mapping.
   */
  findTier(ref: PlanRef): PlanTier | null {
    if (ref.productId) {
      const byProduct = PLAN_TIERS.find((t) => t.productId === ref.productId);
      if (byProduct) return byProduct;
    }
    if (ref.priceId) {
      const byPrice = PLAN_TIERS.find((t) => t.priceIds.includes(ref.priceId!));
      if (byPrice) return byPrice;
    }
    return null;
  }

  /**
   * Limits for a subscription. Never null: an unrecognised product falls back
   * to the least generous tier, so a paying customer keeps working rather than
   * being locked out — or, as this used to do, silently granted everything.
   *
   * Reaching the fallback means someone can buy something this code doesn't
   * know how to entitle, which is why it goes to Sentry rather than just a log.
   */
  getLimits(ref: PlanRef): PlanLimits {
    const override = this.parseOverride();
    if (override) return override;

    const tier = this.findTier(ref);
    if (tier) return tier.limits;

    const detail = `product=${ref.productId ?? 'none'} price=${ref.priceId ?? 'none'}`;
    this.logger.error(
      `No plan tier for ${detail} — falling back to ${FALLBACK_TIER.name} limits`,
    );
    Sentry.captureMessage(`Unmapped Paddle product on subscription: ${detail}`, {
      level: 'error',
      extra: { ...ref },
    });
    return FALLBACK_TIER.limits;
  }

  planName(ref: PlanRef): string {
    return this.findTier(ref)?.name ?? 'Unknown';
  }

  // Local testing hatch: "maxPages,maxLayouts,maxSnippets".
  private parseOverride(): PlanLimits | null {
    if (!this.limitsOverride) return null;
    const parts = this.limitsOverride.split(',').map(Number);
    if (parts.length !== 3 || parts.some((n) => isNaN(n))) return null;
    return {
      maxPages: parts[0],
      maxLayouts: parts[1],
      maxSnippets: parts[2],
    };
  }
}
