/**
 * Express `trust proxy` setting for ez-api.
 *
 * Prod path (ez-infra/compose): browser → Elastic IP → Caddy (the only
 * container publishing ports) → ez-api over the `ez` docker bridge network, so
 * the peer ez-api sees is Caddy's 172.x address. Caddy's reverse_proxy sets
 * X-Forwarded-For to the real client IP, and — with no `trusted_proxies`
 * configured — discards any X-Forwarded-For the client sent, so it can't be
 * spoofed through Caddy.
 *
 * Trusting only private/loopback peers means req.ip is the client behind
 * Caddy, while a request that somehow reached ez-api from a public address
 * would be keyed by that address rather than by a header it chose. Without
 * this, every prod user shares Caddy's IP and one rate-limit bucket.
 */
export const TRUST_PROXY = 'loopback, linklocal, uniquelocal';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr');
const isTrustedPeer: (addr: string, i: number) => boolean = proxyaddr.compile(
  TRUST_PROXY.split(',').map((s) => s.trim()),
);

/**
 * A call from another container on the compose network, not a user via Caddy:
 * a private/loopback peer that sent no X-Forwarded-For (Caddy always adds
 * one). Such callers share one internal IP, so a per-IP limit would throttle
 * all of them together; they're exempt from rate limiting. Today the only one
 * is ez-background's /domains/reverify cron (also exempt by path), but this
 * keeps a future server-to-server call from 429-ing under load.
 */
export function isDirectInternalRequest(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): boolean {
  const peer = req.socket?.remoteAddress;
  return !!peer && !req.headers['x-forwarded-for'] && isTrustedPeer(peer, 0);
}
