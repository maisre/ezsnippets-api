import { PlanLimits } from './interfaces/plan.interface';

/** Which Paddle account the app is pointed at. */
export type PaddleEnv = 'sandbox' | 'production';

export type TierName = 'Starter' | 'Pro' | 'Agency';

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
 *
 * The shape of the ladder: Starter fits one client site comfortably, so a solo
 * dev working sequentially never hits a wall; the layout limit bites as soon as
 * several projects are live at once, which is the upgrade trigger. Pro adds the
 * custom preview domain — the "don't show my client your brand" purchase, priced
 * at the step most customers actually take rather than reserved for the top
 * tier. Agency sells seats.
 *
 * `features` deliberately lists only what is built and shipped. Copy for
 * templates, saved themes, shared team libraries, and the static-site export
 * belongs here once those exist — selling them earlier is how the previous
 * Enterprise tier ended up advertising custom snippet uploads that had no API.
 */
export const PLAN_TIERS: PlanTier[] = [
  {
    name: 'Starter',
    limits: {
      maxPages: 25,
      maxLayouts: 2,
      maxSeats: 1,
      maxCustomDomains: 0,
      maxSavedTemplates: 0,
      aiDailyLimit: 50,
    },
    description: 'For one client site at a time.',
    features: [
      'Full snippet library',
      'Built-in page & site templates',
      'AI customization',
      'Unlimited archived projects',
    ],
    featured: false,
    cta: 'Get Started',
  },
  {
    name: 'Pro',
    limits: {
      maxPages: 150,
      maxLayouts: 10,
      maxSeats: 2,
      maxCustomDomains: 1,
      maxSavedTemplates: -1,
      aiDailyLimit: 300,
    },
    description: 'For freelancers juggling several clients.',
    features: [
      'Everything in Starter',
      'Save your own templates',
      'Custom preview domain',
      'Higher AI limits',
      'Priority support',
    ],
    featured: true,
    cta: 'Get Started',
  },
  {
    name: 'Agency',
    limits: {
      maxPages: -1,
      maxLayouts: -1,
      maxSeats: 5,
      maxCustomDomains: 5,
      maxSavedTemplates: -1,
      aiDailyLimit: 1000,
    },
    description: 'For studios with a team.',
    features: [
      'Everything in Pro',
      'Team workspace, 5 seats',
      'Up to 5 custom domains',
      'Unlimited active projects',
    ],
    featured: false,
    cta: 'Get Started',
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
 *
 * The sandbox products were renamed to match (Starter / Pro / Agency) when the
 * tiers were restructured; the ids are unchanged from when they were created.
 */
export const PRODUCT_IDS: Record<PaddleEnv, Record<TierName, string>> = {
  sandbox: {
    Starter: 'pro_01kr05ng3syvh8a3w09cby3brs',
    Pro: 'pro_01kr07sxjck6atwb035k666mye',
    Agency: 'pro_01kr07tcnrjj8ec15gmzescmdw',
  },
  production: {
    // TODO: fill in once the live products exist. Until then every live
    // subscription resolves to the fallback tier and alerts.
    Starter: '',
    Pro: '',
    Agency: '',
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
