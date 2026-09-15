/**
 * Shared slug normalisation.
 *
 * Extracted so the zip-export filename and the page URL slug cannot drift
 * apart. Returns an empty string for input with nothing slug-worthy in it —
 * callers decide what that means, because they disagree: the exporter falls
 * back to "site", while a page slug must reject it rather than silently
 * inventing a URL the customer did not ask for.
 */
export function slugify(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
