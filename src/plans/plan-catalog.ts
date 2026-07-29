import { PlanLimits } from './interfaces/plan.interface';

export interface PlanTier {
  name: string;
  /**
   * Paddle product id. Entitlements key on this rather than on price ids so
   * that new prices under the same product — a price change, a different trial
   * length, a promo — are entitled correctly with no code change. A product
   * gains prices over its life; it doesn't change identity.
   *
   * Optional only because these haven't been filled in yet. Until each is set,
   * resolution falls back to priceIds below, which is how things worked before.
   * Filling them in is what makes new prices work automatically.
   */
  productId?: string;
  /**
   * Known price ids, monthly first. Two jobs, both temporary: a resolution
   * fallback while productId is unset, and the source for the pricing page
   * until the catalog is read from Paddle directly.
   */
  priceIds: string[];
  limits: PlanLimits;
}

/**
 * Ordered least to most generous. Order is load-bearing: the first entry is the
 * tier a subscription falls back to when it names a product we don't recognise
 * — see PlansService.getLimits.
 */
export const PLAN_TIERS: PlanTier[] = [
  {
    name: 'Basic',
    priceIds: [
      'pri_01kr05y9cq25yt75ey1ddkpger',
      'pri_01kr07scygf6jf4a2xbvra76y6',
    ],
    limits: { maxPages: 3, maxLayouts: 1, maxSnippets: 50 },
  },
  {
    name: 'Pro',
    priceIds: [
      'pri_01kr07vbve5a770reznmza9hdq',
      'pri_01kr07vyv692rrj6gn8m57e683',
    ],
    limits: { maxPages: 25, maxLayouts: 10, maxSnippets: 500 },
  },
  {
    name: 'Enterprise',
    priceIds: [
      'pri_01kr07xbjrdw0jztyfta1xfqre',
      'pri_01kr07xy7sty2xhwcqjgzny8x4',
    ],
    limits: { maxPages: -1, maxLayouts: -1, maxSnippets: -1 },
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
