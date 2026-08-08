/**
 * Resolve a snippet's scope tokens for ez-api's preview endpoints.
 *
 * ez-view owns real page rendering; these previews exist to look at a snippet
 * or a page's raw composition. They previously inserted snippet content
 * verbatim, so `{{SNIPPET_SCOPE}}` reached the browser as literal text and
 * every scoped CSS rule matched nothing — the preview showed unstyled markup
 * and there was no sign of why.
 *
 * `{{SNIPPET_SCOPE_JS}}` is the identifier-safe form (`snippet_scope_0`, since
 * a hyphen is illegal in a JS identifier); leaving it unresolved is a syntax
 * error rather than a cosmetic leak, which takes the whole script down.
 *
 * Kept deliberately simple and separate from ez-view's renderer — these two
 * only have to agree on the token names and the shape of a scope.
 */
// `source` is deliberately loose: the Snippet interface declares html/css/js as
// the `String` wrapper object rather than the `string` primitive, so callers
// would otherwise have to wrap every argument.
export function applyScope(source: unknown, index: number): string {
  const scope = `snippet-scope-${index}`;
  return String(source ?? '')
    .replaceAll('{{SNIPPET_SCOPE_JS}}', scope.replace(/-/g, '_'))
    .replaceAll('{{SNIPPET_SCOPE}}', scope);
}
