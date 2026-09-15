import { RESERVED_SLUGS, validateSlug } from './slug-rules';

describe('validateSlug', () => {
  it('normalises to a URL-safe slug', () => {
    expect(validateSlug('Stans HVAC')).toEqual({ ok: true, value: 'stans-hvac' });
    expect(validateSlug("O'Brien & Sons")).toEqual({
      ok: true,
      value: 'o-brien-sons',
    });
    expect(validateSlug('  --Trimmed--  ')).toEqual({
      ok: true,
      value: 'trimmed',
    });
  });

  it('treats empty input as clearing the slug', () => {
    // This is how a customer removes a custom link and goes back to the
    // id-based URL, so it must succeed rather than fail validation.
    expect(validateSlug('')).toEqual({ ok: true, value: null });
    expect(validateSlug('   ')).toEqual({ ok: true, value: null });
    expect(validateSlug(null)).toEqual({ ok: true, value: null });
    expect(validateSlug(undefined)).toEqual({ ok: true, value: null });
  });

  it('rejects reserved words that would shadow real ez-view routes', () => {
    // Slugs are served from the root of a custom domain, so `/view` as a slug
    // would sit exactly where ez-view's own routes live.
    for (const reserved of ['view', 'edit', 'chat', 'public']) {
      expect(RESERVED_SLUGS.has(reserved)).toBe(true);
      const result = validateSlug(reserved);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('reserved');
    }
  });

  it('rejects a reserved word arrived at by normalisation', () => {
    // "View!" slugifies to "view" — checking the raw input would miss this.
    expect(validateSlug('View!').ok).toBe(false);
    expect(validateSlug('  VIEW  ').ok).toBe(false);
  });

  it('rejects input with nothing slug-worthy in it', () => {
    const result = validateSlug('!!!');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('letters and numbers');
  });

  it('rejects something that looks like a page id', () => {
    expect(validateSlug('6aa8c334695de8319d141585').ok).toBe(false);
  });

  it('rejects an over-long slug', () => {
    expect(validateSlug('a'.repeat(61)).ok).toBe(false);
    expect(validateSlug('a'.repeat(60)).ok).toBe(true);
  });
});
