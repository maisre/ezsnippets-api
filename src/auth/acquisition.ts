/**
 * Where a user came from, saved on the user at signup.
 *
 * The browser records the first visit's UTM tags / ref / referrer (see
 * ez-frontend analytics.ts) and the signup form adds "How did you hear about
 * us?". This is the durable copy of attribution: Plausible counts visits in
 * aggregate and loses some to blockers, while this joins a specific user — and
 * so their later pages and payments — to the campaign that brought them.
 * scripts/attribution-report.js reads it.
 *
 * It's client-supplied and ez-api has no ValidationPipe, so everything is
 * whitelisted, string-typed and length-capped here. A bad value is dropped,
 * never an error: attribution must not be able to fail a signup.
 */
export interface Acquisition {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  ref?: string;
  referrer?: string;
  landingPath?: string;
  firstSeenAt?: Date;
  heardAbout?: string;
  heardAboutDetail?: string;
}

const HEARD_ABOUT = new Set([
  'newsletter',
  'reddit',
  'search',
  'social',
  'youtube',
  'friend',
  'other',
  'invite',
]);

// Client key -> stored key, with a length cap.
const STRING_FIELDS: [string, keyof Acquisition, number][] = [
  ['utm_source', 'utmSource', 100],
  ['utm_medium', 'utmMedium', 100],
  ['utm_campaign', 'utmCampaign', 200],
  ['utm_content', 'utmContent', 200],
  ['utm_term', 'utmTerm', 200],
  ['ref', 'ref', 100],
  ['referrer', 'referrer', 300],
  ['landingPath', 'landingPath', 300],
  ['heardAboutDetail', 'heardAboutDetail', 100],
];

export function sanitizeAcquisition(input: unknown): Acquisition | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const out: Acquisition = {};

  for (const [from, to, max] of STRING_FIELDS) {
    const value = raw[from];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, max);
    if (trimmed) (out as Record<string, unknown>)[to] = trimmed;
  }

  // Lower-case source/medium so "Reddit" and "reddit" group together.
  if (out.utmSource) out.utmSource = out.utmSource.toLowerCase();
  if (out.utmMedium) out.utmMedium = out.utmMedium.toLowerCase();
  if (out.ref) out.ref = out.ref.toLowerCase();

  if (typeof raw.heardAbout === 'string' && HEARD_ABOUT.has(raw.heardAbout)) {
    out.heardAbout = raw.heardAbout;
  }

  if (typeof raw.firstSeenAt === 'string') {
    const seen = new Date(raw.firstSeenAt);
    // Reject garbage and clock-skewed futures; keep anything plausible.
    if (!isNaN(seen.getTime()) && seen.getTime() <= Date.now() + 60_000) {
      out.firstSeenAt = seen;
    }
  }

  return Object.keys(out).length ? out : undefined;
}
