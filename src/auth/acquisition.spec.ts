import { sanitizeAcquisition } from './acquisition';

describe('sanitizeAcquisition', () => {
  it('maps client keys to stored keys and normalises source case', () => {
    expect(
      sanitizeAcquisition({
        utm_source: ' TLDR ',
        utm_medium: 'Newsletter',
        utm_campaign: 'launch-week',
        ref: 'Reddit',
        referrer: 'https://www.reddit.com/r/webdev/',
        landingPath: '/',
        heardAbout: 'newsletter',
        heardAboutDetail: 'TLDR Web Dev',
        firstSeenAt: '2026-10-01T12:00:00.000Z',
      }),
    ).toEqual({
      utmSource: 'tldr',
      utmMedium: 'newsletter',
      utmCampaign: 'launch-week',
      ref: 'reddit',
      referrer: 'https://www.reddit.com/r/webdev/',
      landingPath: '/',
      heardAbout: 'newsletter',
      heardAboutDetail: 'TLDR Web Dev',
      firstSeenAt: new Date('2026-10-01T12:00:00.000Z'),
    });
  });

  it('drops unknown keys, non-strings, unknown heardAbout values and bad dates', () => {
    expect(
      sanitizeAcquisition({
        utm_source: { $ne: null },
        heardAbout: 'tv',
        firstSeenAt: 'not a date',
        isAdmin: true,
      }),
    ).toBeUndefined();
  });

  it('rejects a firstSeenAt in the future', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(sanitizeAcquisition({ firstSeenAt: future, ref: 'x' })).toEqual({ ref: 'x' });
  });

  it('caps lengths', () => {
    const out = sanitizeAcquisition({ utm_source: 'a'.repeat(500) });
    expect(out?.utmSource).toHaveLength(100);
  });

  it('returns undefined for non-objects', () => {
    expect(sanitizeAcquisition(undefined)).toBeUndefined();
    expect(sanitizeAcquisition('utm_source=x')).toBeUndefined();
    expect(sanitizeAcquisition(['x'])).toBeUndefined();
  });
});
