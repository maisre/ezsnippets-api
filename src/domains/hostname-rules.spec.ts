import { normalizeHostname, validateHostname } from './hostname-rules';

describe('normalizeHostname', () => {
  it('lowercases and trims', () => {
    expect(normalizeHostname('  VIEW.StansHVAC.com  ')).toBe(
      'view.stanshvac.com',
    );
  });

  it('strips what customers actually paste', () => {
    // A URL copied from the address bar, a port, and the trailing dot of a
    // fully-qualified name all have to resolve to the same hostname — otherwise
    // the same domain can be added twice and the unique index is meaningless.
    expect(normalizeHostname('https://view.stanshvac.com/some/path')).toBe(
      'view.stanshvac.com',
    );
    expect(normalizeHostname('view.stanshvac.com:8443')).toBe(
      'view.stanshvac.com',
    );
    expect(normalizeHostname('view.stanshvac.com.')).toBe(
      'view.stanshvac.com',
    );
    expect(normalizeHostname('view.stanshvac.com?x=1')).toBe(
      'view.stanshvac.com',
    );
  });
});

describe('validateHostname', () => {
  it('accepts a subdomain', () => {
    expect(validateHostname('view.stanshvac.com').ok).toBe(true);
    expect(validateHostname('preview.clients.agency.co.uk').ok).toBe(true);
  });

  it('rejects an apex domain', () => {
    // Deliberate product constraint: an apex cannot carry a CNAME, so it would
    // need an A record to our Elastic IP and would break if that IP changed.
    const result = validateHostname('stanshvac.com');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('subdomain');
  });

  it('rejects our own zone', () => {
    expect(validateHostname('view.ez-snippets.com').ok).toBe(false);
    expect(validateHostname('anything.ez-snippets.com').ok).toBe(false);
  });

  it('rejects IPs', () => {
    expect(validateHostname('203.0.113.10').ok).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(validateHostname('not a domain!!').ok).toBe(false);
    expect(validateHostname('').ok).toBe(false);
    expect(validateHostname('a..b.com').ok).toBe(false);
    expect(validateHostname(`${'a'.repeat(250)}.b.com`).ok).toBe(false);
  });

  it('validates what it will store, not the raw input', () => {
    // A pasted URL is normalised before the rules run, so this is a valid
    // subdomain rather than a malformed name.
    expect(validateHostname('HTTPS://View.StansHVAC.com/path').ok).toBe(true);
  });
});
