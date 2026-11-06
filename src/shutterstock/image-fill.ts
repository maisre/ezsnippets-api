import { Logger, UnprocessableEntityException } from '@nestjs/common';
import type { ShutterstockImage } from './interfaces';
import type { ShutterstockService } from './shutterstock.service';
import type { OpenaiService } from '../openai/openai.service';

/**
 * Shared image-fill logic for pages and layouts.
 *
 * Two modes:
 * - quick: the user's keywords go to ONE Shutterstock search, and the results
 *   are handed out across every slot by shape. No AI call, no AI quota.
 * - smart: OpenAI writes a query per slot, one search per slot. Better fits,
 *   but needs OpenAI. If OpenAI fails (or the AI quota is spent), it falls back
 *   to quick so the user still gets a rough draft instead of an error.
 *
 * Both modes avoid putting the same photo in two slots.
 */

export type FillMode = 'quick' | 'smart';

export interface FillSlot {
  snippetId: string;
  token: string;
  shape?: string;
  context?: string;
  targetAspect: number | null;
  /** Small square slot (headshot/avatar). Quick fill searches portraits for these. */
  avatar: boolean;
}

export interface FillPick {
  snippetId: string;
  token: string;
  image: ShutterstockImage;
}

/** Reported back to the editor so it can say what happened. */
export interface ImageFillSummary {
  mode: FillMode;
  /** True when smart fill failed and quick fill ran instead. */
  fellBack: boolean;
  /** The keywords quick fill searched for. */
  keywords?: string;
  requested: number;
  filled: number;
}

export interface FillInput {
  mode: FillMode;
  keywords?: string;
  direction?: string;
  name: string;
  siteName?: string;
  description?: string;
  slots: FillSlot[];
}

export interface FillDeps {
  shutterstock: ShutterstockService;
  openai: OpenaiService;
  /** Meters one AI request; throws when the org is over its daily limit. */
  consumeAi: () => Promise<void>;
  logger: Logger;
}

export const MAX_KEYWORDS_LENGTH = 100;
const AVATAR_QUERY = 'smiling person portrait headshot';
// Shutterstock allows larger pages, but 100 previews is plenty of choice and
// keeps the response small.
const MAX_PER_PAGE = 100;
const MIN_PER_PAGE = 20;

/** Roughly 3 candidates per slot, so every shape has something close. */
export function perPageFor(slotCount: number): number {
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, slotCount * 3));
}

function aspectOf(image: ShutterstockImage): number {
  return image.aspect || (image.height ? image.width / image.height : 0);
}

/**
 * The unused image whose aspect is closest to the target, in log space so
 * "twice as wide" and "twice as tall" count as equally bad. With no target,
 * the first unused image (Shutterstock's own relevance order) wins.
 */
export function pickBest(
  images: ShutterstockImage[],
  targetAspect: number | null,
  used: Set<string> = new Set(),
): ShutterstockImage | null {
  const candidates = images.filter((img) => !used.has(img.id));
  if (!candidates.length) return null;
  if (targetAspect === null) return candidates[0];

  let best = candidates[0];
  let bestDistance = Infinity;
  for (const image of candidates) {
    const aspect = aspectOf(image);
    if (!aspect) continue;
    const distance = Math.abs(Math.log(aspect / targetAspect));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = image;
    }
  }
  return best;
}

/**
 * Slots with the most extreme shapes go first: a 3:1 banner has far fewer good
 * matches in a pool than a 4:3 card, so it gets first pick. Slots with no
 * known shape go last because anything fits them.
 */
export function hardestFirst(slots: FillSlot[]): FillSlot[] {
  const score = (s: FillSlot) =>
    s.targetAspect === null ? -1 : Math.abs(Math.log(s.targetAspect));
  return [...slots].sort((a, b) => score(b) - score(a));
}

/** Hands out a pool of images across slots, never reusing one. */
export function assignByShape(
  slots: FillSlot[],
  pool: ShutterstockImage[],
  used: Set<string>,
): FillPick[] {
  const picks: FillPick[] = [];
  for (const slot of hardestFirst(slots)) {
    const image = pickBest(pool, slot.targetAspect, used);
    if (!image) continue;
    used.add(image.id);
    picks.push({ snippetId: slot.snippetId, token: slot.token, image });
  }
  return picks;
}

export function cleanKeywords(raw: string | undefined | null): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_KEYWORDS_LENGTH);
}

/**
 * Keywords for quick fill: what the user typed, else the site name, else the
 * page/layout name. The fallback lets the "missing" and "Fix" buttons run
 * without the user typing anything.
 */
export function keywordsFor(input: Pick<FillInput, 'keywords' | 'siteName' | 'name'>): string {
  return (
    cleanKeywords(input.keywords) ||
    cleanKeywords(input.siteName) ||
    cleanKeywords(input.name)
  );
}

/**
 * Shutterstock requires every word in a query to match, so a specific phrase
 * like "craft brewery taproom" can return nothing while "craft brewery" has
 * hundreds. Search the full phrase, then drop trailing words until the pool
 * has at least one photo per slot. More specific results come first.
 */
export function broaderQueries(keywords: string): string[] {
  const words = keywords.split(' ').filter(Boolean);
  const queries: string[] = [];
  for (let n = words.length; n >= 1; n--) {
    queries.push(words.slice(0, n).join(' '));
  }
  return queries.slice(0, 4);
}

async function broadSearch(
  deps: FillDeps,
  keywords: string,
  needed: number,
): Promise<ShutterstockImage[]> {
  const pool: ShutterstockImage[] = [];
  const seen = new Set<string>();
  for (const query of broaderQueries(keywords)) {
    const { images } = await deps.shutterstock.searchImages(
      query,
      perPageFor(needed),
    );
    for (const image of images) {
      if (seen.has(image.id)) continue;
      seen.add(image.id);
      pool.push(image);
    }
    if (pool.length >= needed) break;
  }
  return pool;
}

/**
 * Drop AI keyword suggestions that would find too few photos, so a chip never
 * leads to a mostly empty page. If every suggestion is thin, keep the best
 * ones rather than showing nothing.
 */
export async function keepSearchableKeywords(
  shutterstock: ShutterstockService,
  keywords: string[],
  minResults = 20,
): Promise<string[]> {
  const counted = await Promise.all(
    keywords.map(async (k) => {
      try {
        const { totalCount } = await shutterstock.searchImages(k, 1);
        return { k, count: totalCount };
      } catch {
        // Can't check it; let the user try it.
        return { k, count: minResults };
      }
    }),
  );
  const good = counted.filter((c) => c.count >= minResults).map((c) => c.k);
  if (good.length) return good;
  return counted
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((c) => c.k);
}

export async function quickFill(
  deps: FillDeps,
  slots: FillSlot[],
  keywords: string,
): Promise<FillPick[]> {
  if (!slots.length) return [];

  const main = slots.filter((s) => !s.avatar);
  const avatars = slots.filter((s) => s.avatar);

  // The keyword search must succeed; the portrait search is a nice-to-have, so
  // if it fails the avatar slots just draw from the keyword results.
  const [mainPool, avatarPool] = await Promise.all([
    broadSearch(deps, keywords, main.length || slots.length),
    avatars.length
      ? deps.shutterstock
          .searchImages(AVATAR_QUERY, perPageFor(avatars.length))
          .then((r) => r.images)
          .catch((error) => {
            deps.logger.warn(`Portrait search failed: ${String(error)}`);
            return [] as ShutterstockImage[];
          })
      : Promise.resolve([] as ShutterstockImage[]),
  ]);

  if (!mainPool.length && !avatarPool.length) {
    throw new UnprocessableEntityException(
      `No stock photos matched "${keywords}". Try different keywords.`,
    );
  }

  const used = new Set<string>();
  const picks = assignByShape(main, mainPool, used);

  const avatarPicks = assignByShape(avatars, avatarPool, used);
  picks.push(...avatarPicks);

  // Avatar slots the portrait search couldn't cover fall back to the keyword pool.
  const covered = new Set(avatarPicks.map((p) => `${p.snippetId}::${p.token}`));
  const leftover = avatars.filter((s) => !covered.has(`${s.snippetId}::${s.token}`));
  picks.push(...assignByShape(leftover, mainPool, used));

  return picks;
}

export async function smartFill(
  deps: FillDeps,
  input: FillInput,
): Promise<FillPick[]> {
  if (!input.slots.length) return [];

  await deps.consumeAi();

  const { slots: queries } = await deps.openai.deriveImageQueries({
    name: input.name,
    siteName: input.siteName,
    description: input.description,
    direction: input.direction,
    slots: input.slots.map(({ targetAspect, avatar, ...slot }) => slot),
  });

  // Searches run in parallel: a page can hold 5-20 slots and the searches are
  // unmetered, so sequential would be unusably slow. One slot failing must not
  // sink the rest; it just stays on its placeholder.
  const resultsByKey = new Map<string, ShutterstockImage[]>();
  await Promise.all(
    queries.map(async (q) => {
      const key = `${q.snippetId}::${q.token}`;
      try {
        const { images } = await deps.shutterstock.searchImages(q.query, 9);
        resultsByKey.set(key, images);
      } catch (error) {
        deps.logger.warn(
          `Stock search failed for ${key} ("${q.query}"): ${String(error)}`,
        );
      }
    }),
  );

  // Assign after all searches return, so two slots whose queries share a top
  // result don't both get it. If every result for a slot is already taken,
  // reusing one beats leaving the slot empty.
  const used = new Set<string>();
  const picks: FillPick[] = [];
  for (const slot of hardestFirst(input.slots)) {
    const images = resultsByKey.get(`${slot.snippetId}::${slot.token}`);
    if (!images?.length) continue;
    const image =
      pickBest(images, slot.targetAspect, used) ??
      pickBest(images, slot.targetAspect);
    if (!image) continue;
    used.add(image.id);
    picks.push({ snippetId: slot.snippetId, token: slot.token, image });
  }
  return picks;
}

export async function fillImages(
  deps: FillDeps,
  input: FillInput,
): Promise<{ picks: FillPick[]; summary: ImageFillSummary }> {
  const requested = input.slots.length;

  if (input.mode === 'quick') {
    const keywords = keywordsFor(input);
    const picks = await quickFill(deps, input.slots, keywords);
    return {
      picks,
      summary: { mode: 'quick', fellBack: false, keywords, requested, filled: picks.length },
    };
  }

  try {
    const picks = await smartFill(deps, input);
    return {
      picks,
      summary: { mode: 'smart', fellBack: false, requested, filled: picks.length },
    };
  } catch (error) {
    const keywords = keywordsFor(input);
    if (!keywords) throw error;
    deps.logger.warn(
      `Smart image fill failed, falling back to quick fill ("${keywords}"): ${String(error)}`,
    );
    const picks = await quickFill(deps, input.slots, keywords);
    return {
      picks,
      summary: { mode: 'quick', fellBack: true, keywords, requested, filled: picks.length },
    };
  }
}
