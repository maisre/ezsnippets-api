import { PlanLimits } from './interfaces/plan.interface';

/** Which Paddle account the app is pointed at. */
export type PaddleEnv = 'sandbox' | 'production';

export type TierName = 'Basic' | 'Pro' | 'Enterprise';

export interface PlanTier {
  name: TierName;
  limits: PlanLimits;
  /**
   * Marketing copy. It lives here rather than in the frontend because the
   * frontend used to key it by price id, which is exactly the coupling this
   * design removes. Amounts and trial lengths are NOT here — those come from
   * Paddle, which is the catalog's system of record.
   */
  description: string;
  /** Selling points beyond the limits, which are rendered from `limits`. */
  features: string[];
  featured: boolean;
  cta: string;
}

/**
 * Ordered least to most generous. Order is load-bearing: the first entry is the
 * tier a subscription falls back to when it names a product we don't recognise
 * — see PlansService.getLimits.
 */
export const PLAN_TIERS: PlanTier[] = [
  {
    name: 'Basic',
    limits: { maxPages: 3, maxLayouts: 1, maxSnippets: 50 },
    description: 'Perfect for trying things out.',
    features: ['Community snippets', 'Basic AI customization'],
    featured: false,
    cta: 'Get Started',
  },
  {
    name: 'Pro',
    limits: { maxPages: 25, maxLayouts: 10, maxSnippets: 500 },
    description: 'For freelancers and small teams.',
    features: [
      'AI customization',
      'Custom CSS/JS overrides',
      'Priority support',
    ],
    featured: true,
    cta: 'Get Started',
  },
  {
    name: 'Enterprise',
    limits: { maxPages: -1, maxLayouts: -1, maxSnippets: -1 },
    description: 'For agencies and larger teams.',
    features: [
      'Everything in Pro',
      'Team workspaces',
      'Custom snippet uploads',
      'White-label publishing',
      'API access',
      'Dedicated support',
    ],
    featured: false,
    cta: 'Contact Sales',
  },
];

export const FALLBACK_TIER = PLAN_TIERS[0];

/**
 * Which Paddle product backs each tier, per environment.
 *
 * Sandbox and live products are separate entities with different ids, so both
 * sets live here and the environment picks between them. Deliberately in code
 * rather than env vars: entitlements must be answerable from the deployed
 * artifact alone, with no chance of an instance coming up half-configured and
 * quietly granting fallback limits to someone who paid. Product ids aren't
 * secrets — they appear in checkout URLs.
 *
 * The environment comes from the same PADDLE_ENVIRONMENT that builds the Paddle
 * client (see PaddleModule), so the client and these ids cannot disagree.
 *
 * An empty string means "not created yet". It resolves to no tier, which lands
 * on FALLBACK_TIER with a Sentry alert, and the startup check in
 * PaddleCatalogService reports it explicitly.
 */
export const PRODUCT_IDS: Record<PaddleEnv, Record<TierName, string>> = {
  sandbox: {
    Basic: 'pro_01kr05ng3syvh8a3w09cby3brs',
    Pro: 'pro_01kr07sxjck6atwb035k666mye',
    Enterprise: 'pro_01kr07tcnrjj8ec15gmzescmdw',
  },
  production: {
    // TODO: fill in once the live products exist. Until then every live
    // subscription resolves to the fallback tier and alerts.
    Basic: '',
    Pro: '',
    Enterprise: '',
  },
};

/** The tier a Paddle product maps to in the given environment. */
export function tierForProduct(
  env: PaddleEnv,
  productId: string | undefined | null,
): PlanTier | null {
  if (!productId) return null;
  const ids = PRODUCT_IDS[env];
  const name = (Object.keys(ids) as TierName[]).find(
    (tier) => ids[tier] === productId,
  );
  return name ? (PLAN_TIERS.find((t) => t.name === name) ?? null) : null;
}

/** How a subscription names what it bought. */
export interface PlanRef {
  productId?: string;
  /** Kept for display and history on the org; not used for resolution. */
  priceId?: string;
}

interface PlanItemLike {
  price?: { id?: string; productId?: string } | null;
}

/**
 * Pick the item on a subscription that represents the plan.
 *
 * A subscription can carry several items — a base plan plus add-ons — and
 * nothing guarantees the plan comes first, so take the first item whose product
 * we recognise rather than trusting position zero. When nothing matches, fall
 * back to the first item so the org still records what it bought and the
 * unmapped product gets reported.
 */
export function pickPlanRef(
  items: PlanItemLike[] | undefined,
  isKnown: (ref: PlanRef) => boolean,
): PlanRef {
  for (const item of items ?? []) {
    const ref = { productId: item.price?.productId, priceId: item.price?.id };
    if (isKnown(ref)) return ref;
  }

  const first = items?.[0]?.price;
  return { productId: first?.productId, priceId: first?.id };
}
