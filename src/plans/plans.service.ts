import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { hasActiveSubscription } from './subscription-status';
import { OrgsService } from '../orgs/orgs.service';
import type { Org } from '../orgs/interfaces/org.interface';

/** What an org may do right now, and why. */
export interface Entitlement {
  /** Tier name, for display. */
  plan: string;
  limits: PlanLimits;
  /**
   * `subscription` — the org pays for itself (or was comped).
   * `team-owner` — a personal org riding on its owner's team subscription
   * (PlanTier.ownerPersonalTier); `viaOrgId` names the team org.
   */
  source: 'subscription' | 'team-owner';
  viaOrgId?: string;
}

@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @Inject('PLAN_LIMITS_OVERRIDE')
    private readonly limitsOverride: string | undefined,
    @Inject(PADDLE_ENV) private readonly paddleEnv: PaddleEnv,
    // Optional so the pure limit/tier logic can be unit-tested without a
    // database; only entitlementFor needs it.
    @Optional() private readonly orgsService?: OrgsService,
  ) {}

  /**
   * The single answer to "may this org create things, and within what?".
   * Null means no active plan.
   *
   * An org's own subscription always wins. Failing that, a personal org whose
   * owner owns an active team org inherits that team tier's ownerPersonalTier
   * — the Agency owner's included Pro workspace. Nothing is written for that
   * case, so it can't drift: cancel the Agency and the personal org lapses on
   * the very next request.
   */
  async entitlementFor(org: Org | null | undefined): Promise<Entitlement | null> {
    if (!org) return null;

    if (hasActiveSubscription(org)) {
      return {
        plan: this.planName(org.productId),
        limits: this.getLimits(org.productId),
        source: 'subscription',
      };
    }

    if (!org.personal || !this.orgsService) return null;
    const owner = org.members.find((m) => m.role === 'owner');
    if (!owner) return null;

    const teams = await this.orgsService.findTeamOrgsOwnedBy(String(owner.user));
    for (const team of teams) {
      if (!hasActiveSubscription(team)) continue;
      const personalTier = this.findTier(team.productId)?.ownerPersonalTier;
      const tier = personalTier && PLAN_TIERS.find((t) => t.name === personalTier);
      if (!tier) continue;
      return {
        plan: tier.name,
        limits: this.parseOverride() ?? tier.limits,
        source: 'team-owner',
        viaOrgId: String(team._id),
      };
    }
    return null;
  }

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

  /**
   * Local testing hatch:
   * "maxPages,maxLayouts,maxSeats,maxCustomDomains,maxSavedTemplates,aiDailyLimit".
   *
   * All six are required — a partial override would silently grant whatever
   * the missing fields defaulted to, which is the failure this whole module
   * exists to prevent.
   */
  private parseOverride(): PlanLimits | null {
    if (!this.limitsOverride) return null;
    const parts = this.limitsOverride.split(',').map(Number);
    if (parts.length !== 6 || parts.some((n) => isNaN(n))) return null;
    return {
      maxPages: parts[0],
      maxLayouts: parts[1],
      maxSeats: parts[2],
      maxCustomDomains: parts[3],
      maxSavedTemplates: parts[4],
      aiDailyLimit: parts[5],
    };
  }
}
