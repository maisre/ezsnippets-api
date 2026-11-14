/**
 * A page or layout can hold the same library snippet more than once, and each
 * copy carries its own text and images. The AI layer identifies work by
 * `snippetId`, so two copies sharing an id were written once and both given the
 * same result.
 *
 * These keys give every copy its own identity for one AI call: the first use
 * keeps the bare id (so nothing changes for the ordinary case) and later uses
 * become `id#1`, `id#2`, … The AI layer only echoes the value back, so it needs
 * no knowledge of the scheme. Keys are positional — build them from the same
 * list, in the same order, that the results are applied to.
 */
export function instanceKeys(snippetIds: string[]): string[] {
  const seen = new Map<string, number>();
  return snippetIds.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return n === 0 ? id : `${id}#${n}`;
  });
}

/** True for the second and later copies of a snippet. */
export function isRepeat(key: string): boolean {
  return key.includes('#');
}

/** Added to a repeated section's brief so the model doesn't write it twice. */
export const REPEAT_NOTE =
  'This section design is used more than once on the site. Write copy for this use that is clearly different from the others: a different angle, not a rewording.';

export function aboutForInstance(about: string | undefined, key: string): string | undefined {
  if (!isRepeat(key)) return about;
  return about ? `${about} ${REPEAT_NOTE}` : REPEAT_NOTE;
}
