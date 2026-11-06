import { assignByShape, keywordsFor, perPageFor, pickBest, FillSlot } from './image-fill';

function img(id: string, aspect: number) {
  return { id, description: '', previewUrl: '', width: 0, height: 0, aspect };
}

function slot(token: string, targetAspect: number | null): FillSlot {
  return { snippetId: 's', token, targetAspect, avatar: false };
}

describe('image-fill', () => {
  it('pickBest skips images already used', () => {
    const images = [img('a', 1.5), img('b', 1.4)];
    expect(pickBest(images, 1.5, new Set(['a']))?.id).toBe('b');
    expect(pickBest(images, 1.5, new Set(['a', 'b']))).toBeNull();
  });

  // A 3:1 banner has few good matches, so it must pick before an easy 4:3 card
  // takes the only wide image.
  it('gives the most extreme shapes first pick', () => {
    const pool = [img('wide', 3), img('normal', 1.3)];
    const picks = assignByShape([slot('card', 1.33), slot('banner', 3)], pool, new Set());
    const byToken = Object.fromEntries(picks.map((p) => [p.token, p.image.id]));
    expect(byToken).toEqual({ banner: 'wide', card: 'normal' });
  });

  it('never reuses an image, leaving extra slots empty', () => {
    const picks = assignByShape([slot('a', 1), slot('b', 1)], [img('x', 1)], new Set());
    expect(picks).toHaveLength(1);
  });

  it('keywords fall back to site name, then name', () => {
    expect(keywordsFor({ keywords: ' a  b ', siteName: 'S', name: 'N' })).toBe('a b');
    expect(keywordsFor({ keywords: '', siteName: 'S', name: 'N' })).toBe('S');
    expect(keywordsFor({ name: 'N' })).toBe('N');
  });

  it('asks for about three candidates per slot, within bounds', () => {
    expect(perPageFor(1)).toBe(20);
    expect(perPageFor(10)).toBe(30);
    expect(perPageFor(80)).toBe(100);
  });
});

describe('broaderQueries', () => {
  it('drops trailing words, most specific first', () => {
    const { broaderQueries } = require('./image-fill');
    expect(broaderQueries('craft brewery taproom')).toEqual([
      'craft brewery taproom',
      'craft brewery',
      'craft',
    ]);
  });
});
