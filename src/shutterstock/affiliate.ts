// Affiliate attribution for the finalize licensing hand-off.
//
// Shutterstock's affiliate program runs on Impact (impact.com). Attribution is
// cookie-based: when a visitor clicks an Impact tracking link, a 30-day cookie
// with our publisher id is set, and a later purchase on *their own* account is
// credited to us. Commission applies to NEW Shutterstock customers only.
//
// Impact supports deep linking to any brand-permitted destination via the `u=`
// query param (the real destination, percent-encoded) plus `force_deeplink=1`
// so the destination is honored rather than the ad's default landing page. That
// lets us wrap either a single curated Collection URL ("license everything in
// one place") or an individual asset page, and still get attributed.
//
// SHUTTERSTOCK_AFFILIATE_BASE is the Impact tracking link *without* a
// destination, e.g. https://<vanity>.pxf.io/c/<campaignId>/<pubId>/<adId>
// It is intentionally optional: in dev, or before the affiliate account is
// approved / deep-linking is confirmed enabled in the Impact dashboard, it is
// left unset and links fall back to the plain Shutterstock URL — everything
// still works, attribution is simply skipped.

export function affiliateConfigured(): boolean {
  return !!process.env.SHUTTERSTOCK_AFFILIATE_BASE?.trim();
}

/**
 * Wrap a shutterstock.com destination in our Impact tracking link so a
 * downstream purchase is attributed to us. Returns the destination unchanged
 * when no affiliate base is configured.
 */
export function wrapAffiliate(destUrl: string): string {
  const base = process.env.SHUTTERSTOCK_AFFILIATE_BASE?.trim();
  if (!base) return destUrl;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}u=${encodeURIComponent(destUrl)}&force_deeplink=1`;
}

/** Canonical Shutterstock asset page for a single licensed image. */
export function imagePageUrl(shutterstockId: string): string {
  return `https://www.shutterstock.com/image-photo/${shutterstockId}`;
}
