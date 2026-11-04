// Resolves req.ip exactly as Express does (Express calls proxy-addr with the
// compiled `trust proxy` value), for the peers ez-api actually sees.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyaddr = require('proxy-addr');
import { TRUST_PROXY } from './trust-proxy';

const trust = proxyaddr.compile(TRUST_PROXY.split(',').map((s) => s.trim()));

function clientIp(peer: string, xff?: string): string {
  return proxyaddr(
    {
      socket: { remoteAddress: peer },
      headers: xff ? { 'x-forwarded-for': xff } : {},
    },
    trust,
  );
}

describe('TRUST_PROXY', () => {
  it('uses the client IP Caddy forwards over the docker network', () => {
    expect(clientIp('172.18.0.3', '203.0.113.9')).toBe('203.0.113.9');
    expect(clientIp('::ffff:172.18.0.3', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('gives two users behind Caddy different identities', () => {
    expect(clientIp('172.18.0.3', '198.51.100.1')).not.toBe(
      clientIp('172.18.0.3', '198.51.100.2'),
    );
  });

  it('ignores X-Forwarded-For from a public peer', () => {
    expect(clientIp('198.51.100.7', '1.2.3.4')).toBe('198.51.100.7');
  });

  it('takes the address Caddy appended, not one the client prepended', () => {
    // Caddy replaces client-sent XFF, but if one ever got through, the
    // right-most untrusted hop still wins.
    expect(clientIp('172.18.0.3', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
  });
});

import { isDirectInternalRequest } from './trust-proxy';

describe('isDirectInternalRequest', () => {
  const req = (peer: string, xff?: string) => ({
    socket: { remoteAddress: peer },
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });

  it('is true for a container calling ez-api directly', () => {
    expect(isDirectInternalRequest(req('172.18.0.5'))).toBe(true);
    expect(isDirectInternalRequest(req('::ffff:172.18.0.5'))).toBe(true);
  });

  it('is false for user traffic through Caddy', () => {
    expect(isDirectInternalRequest(req('172.18.0.3', '203.0.113.9'))).toBe(false);
  });

  it('is false for a public peer, with or without the header', () => {
    expect(isDirectInternalRequest(req('198.51.100.7'))).toBe(false);
    expect(isDirectInternalRequest(req('198.51.100.7', '10.0.0.1'))).toBe(false);
  });
});
