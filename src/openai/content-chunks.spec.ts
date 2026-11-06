import { buildChunks, dedupeSnippets, mapLimit, roleOf, shortAbout, MAX_CHUNK_SLOTS } from './content-chunks';

function snippet(id: string, n: number, len = 10) {
  return {
    snippetId: id,
    replacements: Array.from({ length: n }, (_, i) => ({ token: `P_${i + 1}`, original: 'x'.repeat(len) })),
  };
}

describe('content-chunks', () => {
  it('keys every slot once and keeps a snippet in one chunk when it fits', () => {
    const { chunks, slots } = buildChunks([snippet('a', 15), snippet('b', 15), snippet('c', 15)]);
    expect(slots.map((s) => s.key)).toEqual(Array.from({ length: 45 }, (_, i) => String(i + 1)));
    // 15 + 15 fit in 40; the third snippet starts a new chunk.
    expect(chunks.map((c) => c.sections.map((s) => s.slots.length))).toEqual([[15, 15], [15]]);
  });

  it('splits an oversized snippet across chunks of its own', () => {
    const { chunks } = buildChunks([snippet('a', 5), snippet('big', MAX_CHUNK_SLOTS + 10)]);
    expect(chunks.map((c) => c.sections.map((s) => s.slots.length))).toEqual([[5], [40], [10]]);
  });

  it('starts a new chunk when the text gets long', () => {
    const { chunks } = buildChunks([snippet('a', 5, 900), snippet('b', 5, 900)]);
    expect(chunks).toHaveLength(2);
  });

  it('dedupes repeated snippets', () => {
    expect(dedupeSnippets([snippet('a', 1), snippet('a', 1), snippet('b', 1)]).map((s) => s.snippetId)).toEqual(['a', 'b']);
  });

  it('reads roles from token names and trims descriptions', () => {
    expect([roleOf('H_1'), roleOf('P_2'), roleOf('A_3'), roleOf('SPAN_1')]).toEqual(['heading', 'paragraph', 'link/button', 'text']);
    expect(shortAbout('A FAQ section. With more detail.')).toBe('A FAQ section.');
    expect(shortAbout(undefined)).toBeUndefined();
  });

  it('mapLimit caps concurrency and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
