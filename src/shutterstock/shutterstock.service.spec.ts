import { ShutterstockService } from './shutterstock.service';
import { targetAspectFor, slotShapeFor } from './target-dimensions';

function mockSearch(images: Array<{ id: string; w: number; h: number; aspect: number }>) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      total_count: images.length,
      data: images.map((i) => ({
        id: i.id,
        description: '',
        aspect: i.aspect,
        image_type: 'photo',
        assets: { preview: { url: `https://ss/${i.id}.jpg`, width: i.w, height: i.h } },
      })),
    }),
  }) as any;
}

describe('target-dimensions', () => {
  it('derives aspect from the slot dimension table', () => {
    expect(targetAspectFor('image::13')).toBeCloseTo(3.0); // 150x50
    expect(targetAspectFor('image::8')).toBeCloseTo(1.0); // 60x60
  });

  it('classifies slot shapes', () => {
    expect(slotShapeFor('image::5')).toBe('wide'); // 1920x1300
    expect(slotShapeFor('image::8')).toBe('square'); // 60x60
    expect(slotShapeFor('image::26')).toBe('tall'); // 4480x6509
  });

  // An unknown token must yield no preference rather than a wrong guess.
  it('returns null for unknown tokens', () => {
    expect(targetAspectFor('image::999')).toBeNull();
    expect(slotShapeFor('nonsense')).toBeNull();
  });
});

describe('ShutterstockService.findBestMatch', () => {
  const service = new ShutterstockService();

  beforeAll(() => {
    (service as any).apiToken = 'test-token';
  });

  afterEach(() => jest.restoreAllMocks());

  it('picks the result closest to the target aspect', async () => {
    mockSearch([
      { id: 'square', w: 400, h: 400, aspect: 1.0 },
      { id: 'wide', w: 600, h: 400, aspect: 1.5 },
      { id: 'ultrawide', w: 900, h: 300, aspect: 3.0 },
    ]);

    const best = await service.findBestMatch('coffee', 1.48);
    expect(best?.id).toBe('wide');
  });

  // Log-space comparison: 2x too wide and 2x too tall should score equally, so
  // neither direction is systematically favoured.
  it('treats proportional error symmetrically', async () => {
    mockSearch([
      { id: 'double', w: 400, h: 200, aspect: 2.0 },
      { id: 'half', w: 200, h: 400, aspect: 0.5 },
      { id: 'near', w: 420, h: 400, aspect: 1.05 },
    ]);

    const best = await service.findBestMatch('anything', 1.0);
    expect(best?.id).toBe('near');
  });

  it('falls back to top relevance when no aspect is wanted', async () => {
    mockSearch([
      { id: 'first', w: 900, h: 300, aspect: 3.0 },
      { id: 'second', w: 400, h: 400, aspect: 1.0 },
    ]);

    const best = await service.findBestMatch('coffee', null);
    expect(best?.id).toBe('first');
  });

  it('returns null when the search finds nothing', async () => {
    mockSearch([]);
    expect(await service.findBestMatch('zxcvbnm', 1.5)).toBeNull();
  });
});
