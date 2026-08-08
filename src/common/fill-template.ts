/**
 * Substitute a `{{ TOKEN }}` placeholder in a template with rendered content.
 *
 * Always go through this instead of calling `.replace()` with the content as
 * the second argument. In a replacement *string* `$` is special: `$'` inserts
 * everything after the match, `` $` `` everything before it, `$&` the match
 * itself. Snippet JS is full of currency formatting — `'$' + price` — so
 * passing snippet content as a replacement string splices the entire rest of
 * the template into the middle of a string literal, breaking every handler on
 * the page. See the matching helper in ez-view, which renders the same
 * templates and hit this in production.
 *
 * A replacement *function* has no such semantics — its return value is
 * inserted verbatim.
 */
export function fill(template: string, token: string, content: string): string {
  return template.replace(token, () => content);
}
