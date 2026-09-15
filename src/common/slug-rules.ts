import { slugify } from './slugify';

/**
 * Slugs are served from the ROOT of a custom domain (view.theirs.com/stans-hvac),
 * so a slug that collides with a real ez-view path would shadow it. These are
 * ez-view's own first path segments plus the obvious infrastructure names.
 *
 * Keep in sync with ez-view's controllers: `view/*`, `edit/*`, `chat/*` and the
 * `/public` static mount. Express only matches a single segment against
 * `/:slug`, so multi-segment routes like `/view/page/:id` are already safe —
 * this list covers the bare single-segment case (`/view`) and leaves room for
 * routes we might add later without breaking a customer's live link.
 */
export const RESERVED_SLUGS = new Set([
  'view',
  'edit',
  'chat',
  'public',
  'health',
  'api',
  'assets',
  'static',
  'admin',
  'login',
  'logout',
  'signup',
  'auth',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'well-known',
]);

const MAX_LENGTH = 60;

export interface SlugCheck {
  ok: boolean;
  /** Normalised value when ok; null clears the slug. */
  value?: string | null;
  /** Customer-facing rejection message. */
  reason?: string;
}

/**
 * Normalise and validate a user-supplied page slug.
 *
 * An explicit empty string or null clears it — that is how a customer removes a
 * slug and goes back to the id-based URL.
 */
export function validateSlug(input: string | null | undefined): SlugCheck {
  if (input === null || input === undefined || input.trim() === '') {
    return { ok: true, value: null };
  }

  const value = slugify(input);

  if (!value) {
    return {
      ok: false,
      reason: 'Use letters and numbers — for example stans-hvac.',
    };
  }
  if (value.length > MAX_LENGTH) {
    return { ok: false, reason: `Keep it under ${MAX_LENGTH} characters.` };
  }
  if (RESERVED_SLUGS.has(value)) {
    return { ok: false, reason: `"${value}" is reserved. Pick another name.` };
  }
  // A slug that is only digits would be ambiguous next to id-based URLs, and a
  // 24-character hex string is indistinguishable from a Mongo id.
  if (/^[0-9a-f]{24}$/.test(value)) {
    return { ok: false, reason: 'That looks like a page id. Pick a name.' };
  }

  return { ok: true, value };
}
