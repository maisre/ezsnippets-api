/**
 * What a tier entitles. `-1` means unlimited everywhere it's allowed.
 *
 * `maxPages` and `maxLayouts` are **concurrency** limits, not lifetime caps:
 * archived pages and layouts are excluded from the counts (see
 * PagesService.countForOrg), so finishing a client site and archiving it frees
 * the slot. That's deliberate — the limit should be felt by someone juggling
 * several live projects, not by someone doing one site at a time.
 */
export interface PlanLimits {
  /** Concurrent (non-archived) pages. */
  maxPages: number;
  /** Concurrent (non-archived) layouts — effectively "client sites in flight". */
  maxLayouts: number;
  /** Members allowed on the org. Declared but not yet enforced — no invite flow. */
  maxSeats: number;
  /**
   * Custom preview domains (e.g. view.theirstudio.com instead of
   * view.ez-snippets.com). Declared but not yet enforced — ez-view has no
   * host-header routing yet.
   */
  maxCustomDomains: number;
  /** AI requests per UTC day, enforced by AiUsageService. */
  aiDailyLimit: number;
}
