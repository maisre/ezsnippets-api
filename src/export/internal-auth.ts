/**
 * Signs ez-api's calls to ez-view routes that sit on the public view host but
 * must not be public — today the layout export, which returns the whole
 * downloadable site.
 *
 * The signature uses the JWT secret both services already hold, covers the
 * scope (a token for one layout opens only that layout) and expires in a
 * minute. Mirrored by ez-view's src/common/internal-auth.ts — change both
 * together.
 */
import { createHmac } from 'crypto';

export const INTERNAL_AUTH_HEADER = 'x-ez-internal';

const LIFETIME_SECONDS = 60;

export function signInternal(
  scope: string,
  secret = process.env.JWT_SECRET,
  now = Date.now(),
): string | null {
  if (!secret) return null;
  const exp = Math.floor(now / 1000) + LIFETIME_SECONDS;
  const signature = createHmac('sha256', secret)
    .update(`${scope}.${exp}`)
    .digest('hex');
  return `${exp}.${signature}`;
}

/** Headers for a fetch to ez-view. Empty without a secret; ez-view then refuses. */
export function internalAuthHeaders(scope: string): Record<string, string> {
  const token = signInternal(scope);
  return token ? { [INTERNAL_AUTH_HEADER]: token } : {};
}

/** Scope for ez-view's GET /view/layout/:id/static. */
export function layoutStaticScope(layoutId: string): string {
  return `layout-static:${layoutId}`;
}
