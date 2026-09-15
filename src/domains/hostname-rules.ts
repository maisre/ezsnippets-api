/**
 * Validation for customer-supplied custom domains.
 *
 * Kept as pure functions so the rules can be unit tested without a database or
 * a DNS resolver, and so ez-view can reuse the normaliser.
 */

/** Our own zone. Customers cannot claim anything inside it. */
const OWN_SUFFIX = 'ez-snippets.com';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface HostnameCheck {
  ok: boolean;
  /** Why it was rejected — written to be shown to the customer as-is. */
  reason?: string;
}

/**
 * Lowercase, strip a trailing dot, strip a scheme/path if someone pasted a URL,
 * and drop a port. Customers paste all of these.
 */
export function normalizeHostname(input: string): string {
  let host = (input || '').trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split('/')[0];
  host = host.split('?')[0];
  host = host.split(':')[0];
  host = host.replace(/\.$/, '');
  return host;
}

/**
 * Subdomains only, by product decision. An apex domain cannot carry a CNAME,
 * so it would need an A record pointing at our Elastic IP — which breaks every
 * customer's DNS the day that IP changes, and blocks ever moving the edge
 * behind CloudFront or an ALB. Requiring 3+ labels enforces that at the door
 * rather than letting someone add `theirdomain.com` and discover it silently
 * never issues a certificate.
 */
export function validateHostname(input: string): HostnameCheck {
  const host = normalizeHostname(input);

  if (!host) {
    return { ok: false, reason: 'Enter a domain.' };
  }
  if (host.length > 253) {
    return { ok: false, reason: 'That domain is too long.' };
  }
  // Bare IPv4, and anything with a colon (IPv6) — already stripped as a port
  // above, so a remaining colon means something malformed.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return { ok: false, reason: 'Enter a domain name, not an IP address.' };
  }

  const labels = host.split('.');
  if (labels.some((l) => !LABEL.test(l))) {
    return { ok: false, reason: `"${host}" is not a valid domain name.` };
  }
  if (labels.length < 3) {
    return {
      ok: false,
      reason:
        'Use a subdomain such as view.yourdomain.com — a root domain cannot ' +
        'point at us with a CNAME record.',
    };
  }
  if (host === OWN_SUFFIX || host.endsWith(`.${OWN_SUFFIX}`)) {
    return { ok: false, reason: 'That domain is already ours.' };
  }

  return { ok: true };
}
