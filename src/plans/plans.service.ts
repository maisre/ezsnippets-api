import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PADDLE_ENV } from '../paddle/paddle.module';
import type { PaddleEnv } from './plan-catalog';
import { PlanLimits } from './interfaces/plan.interface';
import {
  FALLBACK_TIER,
  PLAN_TIERS,
  PlanTier,
  tierForProduct,
} from './plan-catalog';

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @Inject('PLAN_LIMITS_OVERRIDE')
    private readonly limitsOverride: string | undefined,
    @Inject(PADDLE_ENV) private readonly paddleEnv: PaddleEnv,
  ) {}

  findAll(): PlanTier[] {
    return PLAN_TIERS;
  }

  /**
   * The tier a Paddle product entitles, or null if we don't recognise it.
   *
   * Keyed on the product rather than the price so that new prices under an
   * existing product — a price change, a different trial, a promo — are
   * entitled correctly with no code change.
   */
  findTier(productId: string | undefined | null): PlanTier | null {
    return tierForProduct(this.paddleEnv, productId);
  }

  /**
   * Limits for a subscription. Never null: an unrecognised product falls back
   * to the least generous tier, so a paying customer keeps working rather than
   * being locked out — or, as this used to do, silently granted everything.
   *
   * Reaching the fallback means someone can buy something this code doesn't
   * know how to entitle, which is why it goes to Sentry rather than just a log.
   */
  getLimits(productId: string | undefined | null): PlanLimits {
    const override = this.parseOverride();
    if (override) return override;

    const tier = this.findTier(productId);
    if (tier) return tier.limits;

    this.logger.error(
      `No plan tier for product ${productId ?? 'none'} in ${this.paddleEnv} — falling back to ${FALLBACK_TIER.name} limits`,
    );
    Sentry.captureMessage(
      `Unmapped Paddle product on subscription: ${productId ?? 'none'}`,
      { level: 'error', extra: { productId, paddleEnv: this.paddleEnv } },
    );
    return FALLBACK_TIER.limits;
  }

  planName(productId: string | undefined | null): string {
    return this.findTier(productId)?.name ?? 'Unknown';
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
