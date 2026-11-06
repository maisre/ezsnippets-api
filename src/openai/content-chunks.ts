/**
 * Splitting AI text customization into small requests.
 *
 * Sending a whole page in one request made the model quietly skip slots on
 * anything big (a 12-snippet layout came back with under half its text
 * rewritten) and took minutes, because output is generated serially. Small
 * chunks run in parallel, each short enough that the model answers every slot.
 *
 * Each slot gets a short numeric key ("1", "2", ...) so the model echoes a
 * couple of tokens per slot instead of a 24-char snippet id and token name.
 */

export interface ContentSnippetInput {
  snippetId: string;
  /** Where the block sits, e.g. "About page" or "Footer". */
  section?: string;
  /** What the block is, e.g. "A FAQ section with a centered heading...". */
  about?: string;
  replacements: Array<{ token: string; original: string }>;
}

export interface KeyedSlot {
  key: string;
  snippetId: string;
  token: string;
  original: string;
}

export interface ContentChunk {
  sections: Array<{
    section?: string;
    about?: string;
    slots: KeyedSlot[];
  }>;
}

export const MAX_CHUNK_SLOTS = 40;
export const MAX_CHUNK_CHARS = 5000;

/** First sentence of a snippet description, trimmed for the prompt. */
export function shortAbout(description?: string | null): string | undefined {
  if (!description) return undefined;
  const first = String(description).split(/(?<=\.)\s/)[0].replace(/\s+/g, ' ').trim();
  return first ? first.slice(0, 140) : undefined;
}

/**
 * Element role from the token name: H_1 is a heading, P_2 a paragraph, A_3 a
 * link or button. Helps the model keep headings short and buttons to a few words.
 */
export function roleOf(token: string): string {
  const tag = token.split('_')[0].toUpperCase();
  switch (tag) {
    case 'H':
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
      return 'heading';
    case 'P':
      return 'paragraph';
    case 'A':
    case 'BTN':
    case 'BUTTON':
      return 'link/button';
    case 'LI':
      return 'list item';
    default:
      return 'text';
  }
}

/** One entry per snippet id: a snippet used twice is rewritten once. */
export function dedupeSnippets(snippets: ContentSnippetInput[]): ContentSnippetInput[] {
  const seen = new Set<string>();
  return snippets.filter((s) => {
    if (seen.has(s.snippetId)) return false;
    seen.add(s.snippetId);
    return true;
  });
}

/**
 * Packs snippets into chunks of roughly MAX_CHUNK_SLOTS slots, keeping each
 * snippet's slots together so the model sees a block's heading and body side
 * by side. A snippet bigger than a whole chunk is split on its own.
 */
export function buildChunks(snippets: ContentSnippetInput[]): {
  chunks: ContentChunk[];
  slots: KeyedSlot[];
} {
  const slots: KeyedSlot[] = [];
  const chunks: ContentChunk[] = [];
  let current: ContentChunk = { sections: [] };
  let count = 0;
  let chars = 0;

  const flush = () => {
    if (current.sections.length) chunks.push(current);
    current = { sections: [] };
    count = 0;
    chars = 0;
  };

  for (const snippet of snippets) {
    const keyed = snippet.replacements.map((r) => {
      const slot: KeyedSlot = {
        key: String(slots.length + 1),
        snippetId: snippet.snippetId,
        token: r.token,
        original: r.original,
      };
      slots.push(slot);
      return slot;
    });
    if (!keyed.length) continue;

    const size = keyed.reduce((n, s) => n + s.original.length, 0);
    if (count && (count + keyed.length > MAX_CHUNK_SLOTS || chars + size > MAX_CHUNK_CHARS)) {
      flush();
    }

    // Oversized snippet: give it chunks of its own.
    for (let i = 0; i < keyed.length; i += MAX_CHUNK_SLOTS) {
      const part = keyed.slice(i, i + MAX_CHUNK_SLOTS);
      if (i > 0) flush();
      current.sections.push({ section: snippet.section, about: snippet.about, slots: part });
      count += part.length;
      chars += part.reduce((n, s) => n + s.original.length, 0);
    }
  }
  flush();
  return { chunks, slots };
}

/** Runs async jobs with at most `limit` in flight, keeping result order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
