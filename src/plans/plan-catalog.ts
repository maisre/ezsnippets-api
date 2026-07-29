import { PlanLimits } from './interfaces/plan.interface';

export interface PlanTier {
  name: string;
  /**
   * Paddle product id. Entitlements key on this rather than on price ids so
   * that new prices under the same product — a price change, a different trial
   * length, a promo — are entitled correctly with no code change. A product
   * gains prices over its life; it doesn't change identity.
   *
   * These are SANDBOX ids. Live products are separate entities with different
   * ids, so going live means swapping all three — the same class of change as
   * the price ids used to be, but three values instead of six, and a mismatch
   * degrades to the fallback tier with a Sentry alert rather than failing
   * silently.
   *
   * Optional in the type because a tier can exist before its product does.
   */
  productId?: string;
  /**
   * Known price ids, monthly first. Now only a fallback: resolution prefers
   * productId, and these cover prices that predate a tier's product mapping.
   */
  priceIds: string[];
  limits: PlanLimits;
  /**
   * Marketing copy. It lives here rather than in the frontend because the
   * frontend used to key it by price id, which is exactly the coupling this
   * whole design removes. Amounts and trial lengths are NOT here — those come
   * from Paddle, which is the catalog's system of record.
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
    productId: 'pro_01kr05ng3syvh8a3w09cby3brs',
    priceIds: [
      'pri_01kr05y9cq25yt75ey1ddkpger',
      'pri_01kr07scygf6jf4a2xbvra76y6',
    ],
    limits: { maxPages: 3, maxLayouts: 1, maxSnippets: 50 },
    description: 'Perfect for trying things out.',
    features: ['Community snippets', 'Basic AI customization'],
    featured: false,
    cta: 'Get Started',
  },
  {
    name: 'Pro',
    productId: 'pro_01kr07sxjck6atwb035k666mye',
    priceIds: [
      'pri_01kr07vbve5a770reznmza9hdq',
      'pri_01kr07vyv692rrj6gn8m57e683',
    ],
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
    productId: 'pro_01kr07tcnrjj8ec15gmzescmdw',
    priceIds: [
      'pri_01kr07xbjrdw0jztyfta1xfqre',
      'pri_01kr07xy7sty2xhwcqjgzny8x4',
    ],
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

/** How a subscription names what it bought. */
export interface PlanRef {
  productId?: string;
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
