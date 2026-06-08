import type { CookieOptions } from 'express';

// Name of the cross-subdomain editor/session cookie. Holds the JWT so ez-view
// (a sibling subdomain of .ez-snippets.com) can authenticate the editor.
export const SESSION_COOKIE = 'ez_session';

// Short-lived on purpose: ez-view verifies only the JWT signature + expiry (it
// has no users model to check tokenVersion), so we keep the cookie life to a
// day rather than the JWT's 14. COOKIE_DOMAIN is set to .ez-snippets.com in
// deployed envs and left unset for local dev (host-only on localhost).
export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: 24 * 60 * 60 * 1000, // 1 day
  };
}

// clearCookie must match domain/path/sameSite/secure to actually remove it.
export function clearSessionCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions();
  return rest;
}
