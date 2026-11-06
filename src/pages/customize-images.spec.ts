import { PagesService } from './pages.service';

// findOne() validates both ids as ObjectIds, so fixtures need real ones.
const PAGE_ID = '507f1f77bcf86cd799439011';
const ORG_ID = '507f1f77bcf86cd799439012';

// Minimal stand-in for a Mongoose snippet abstract on a page.
function abstractFor(snippetId: string, overrides: any[] = []) {
  const obj: any = {
    id: snippetId,
    imageReplacementOverride: overrides,
  };
  obj.toObject = () => JSON.parse(JSON.stringify({ ...obj, toObject: undefined }));
  return obj;
}

function buildService(opts: {
  page: any;
  snippets: any[];
  queries: Array<{ snippetId: string; token: string; query: string }>;
  searchImages: jest.Mock;
  openaiError?: Error;
}) {
  const saved: any[] = [];

  const pageModel: any = {
    findOne: () => ({ exec: async () => opts.page }),
    findOneAndUpdate: (_filter: any, update: any) => {
      saved.push(update.$set.snippets);
      return { exec: async () => ({ ...opts.page, snippets: update.$set.snippets }) };
    },
  };

  const pubsub: any = { publish: jest.fn().mockResolvedValue(undefined) };
  const openai: any = {
    deriveImageQueries: opts.openaiError
      ? jest.fn().mockRejectedValue(opts.openaiError)
      : jest.fn().mockResolvedValue({ slots: opts.queries }),
  };
  const snippetsService: any = {
    findOne: async (id: string) => opts.snippets.find((s) => String(s._id) === id),
  };
  const shutterstock: any = { searchImages: opts.searchImages };
  // Metering is exercised in the ai-usage tests; here it just needs to allow the
  // call through so the image flow under test can run.
  const aiUsage: any = { consume: jest.fn().mockResolvedValue(undefined) };
  // The AI ceiling is per-plan now, so metering resolves the org's tier before
  // it spends. The numbers don't matter here — only that the lookup succeeds.
  const orgsService: any = {
    findOne: jest.fn().mockResolvedValue({ productId: 'prd_test' }),
  };
  const plansService: any = {
    getLimits: () => ({ aiDailyLimit: 1000 }),
    entitlementFor: async () => null,
  };

  const service = new PagesService(
    pageModel,
    pubsub,
    openai,
    snippetsService,
    orgsService,
    plansService,
    shutterstock,
    aiUsage,
    // Templates aren't on the image-customisation path.
    {} as any,
  );

  return { service, saved, openai, shutterstock, aiUsage };
}

// A search mock that always returns the given images.
function found(...images: any[]) {
  return jest.fn().mockResolvedValue({ images });
}

function img(id: string, aspect: number) {
  return { id, previewUrl: `https://ss/${id}.jpg`, aspect, width: 0, height: 0 };
}

const SNIPPET = {
  _id: 's1',
  textReplacement: [{ token: 'headline', english: 'Fresh roasted daily' }],
  imageReplacement: [{ token: 'hero', replacement: 'image::5', original: '' }],
};

describe('PagesService.customizeImages', () => {
  it('writes the shutterstock id alongside the url', async () => {
    const { service, saved } = buildService({
      page: { name: 'Home', description: 'A coffee roaster', snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [{ snippetId: 's1', token: 'hero', query: 'coffee beans roasting' }],
      searchImages: found({ id: 'SS-111', previewUrl: 'https://ss/a.jpg', aspect: 1.5 }),
    });

    await service.customizeImages(PAGE_ID, ORG_ID);

    expect(saved[0][0].imageReplacementOverride).toEqual([
      { token: 'hero', replacement: 'https://ss/a.jpg', shutterstockId: 'SS-111' },
    ]);
  });

  // The regression that matters for the licensing hand-off: a replaced image
  // must never leave the previous image's id behind, or the user gets told to
  // license a photo that is no longer on their page.
  it('replaces the id when it replaces the url', async () => {
    const existing = [
      { token: 'hero', replacement: 'https://ss/old.jpg', shutterstockId: 'SS-OLD' },
    ];
    const { service, saved } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1', existing)] },
      snippets: [SNIPPET],
      queries: [{ snippetId: 's1', token: 'hero', query: 'coffee' }],
      searchImages: found({ id: 'SS-NEW', previewUrl: 'https://ss/new.jpg', aspect: 1.5 }),
    });

    await service.customizeImages(PAGE_ID, ORG_ID, { replaceExisting: true });

    const written = saved[0][0].imageReplacementOverride;
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      token: 'hero',
      replacement: 'https://ss/new.jpg',
      shutterstockId: 'SS-NEW',
    });
    expect(JSON.stringify(written)).not.toContain('SS-OLD');
  });

  // An uploaded image has no shutterstockId. Overwriting it with stock must
  // gain one; the pair is always written together.
  it('adds an id when stock replaces an upload', async () => {
    const existing = [{ token: 'hero', replacement: 'https://cdn/upload.png' }];
    const { service, saved } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1', existing)] },
      snippets: [SNIPPET],
      queries: [{ snippetId: 's1', token: 'hero', query: 'coffee' }],
      searchImages: found({ id: 'SS-222', previewUrl: 'https://ss/b.jpg', aspect: 1.5 }),
    });

    await service.customizeImages(PAGE_ID, ORG_ID, { replaceExisting: true });

    expect(saved[0][0].imageReplacementOverride[0]).toEqual({
      token: 'hero',
      replacement: 'https://ss/b.jpg',
      shutterstockId: 'SS-222',
    });
  });

  it('leaves hand-picked images alone unless replaceExisting is set', async () => {
    const existing = [
      { token: 'hero', replacement: 'https://cdn/mine.png' },
    ];
    const searchImages = jest.fn();
    const { service } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1', existing)] },
      snippets: [SNIPPET],
      queries: [],
      searchImages,
    });

    const result = await service.customizeImages(PAGE_ID, ORG_ID);

    // No slots to fill, so neither OpenAI nor Shutterstock is called at all.
    expect(searchImages).not.toHaveBeenCalled();
    expect(result.snippets[0].imageReplacementOverride).toEqual(existing);
  });

  it('passes the slot shape and user direction through to query derivation', async () => {
    const { service, openai } = buildService({
      page: { name: 'Home', description: 'A coffee roaster', snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [],
      searchImages: jest.fn(),
    });

    await service.customizeImages(PAGE_ID, ORG_ID, { direction: 'warm, natural light' });

    const arg = openai.deriveImageQueries.mock.calls[0][0];
    expect(arg.direction).toBe('warm, natural light');
    // image::5 is 1920x1300 -> wide
    expect(arg.slots[0]).toMatchObject({ snippetId: 's1', token: 'hero', shape: 'wide' });
    expect(arg.slots[0].context).toContain('Fresh roasted daily');
  });

  it('keeps going when one slot search fails', async () => {
    const twoSlot = {
      ...SNIPPET,
      imageReplacement: [
        { token: 'hero', replacement: 'image::5' },
        { token: 'avatar', replacement: 'image::8' },
      ],
    };
    const { service, saved } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1')] },
      snippets: [twoSlot],
      queries: [
        { snippetId: 's1', token: 'hero', query: 'coffee' },
        { snippetId: 's1', token: 'avatar', query: 'barista portrait' },
      ],
      searchImages: jest.fn(async (query: string) => {
        if (query === 'coffee') throw new Error('shutterstock 429');
        return { images: [{ id: 'SS-333', previewUrl: 'https://ss/c.jpg', aspect: 1 }] };
      }),
    });

    await service.customizeImages(PAGE_ID, ORG_ID);

    // The failed slot is simply absent; the successful one is written.
    const written = saved[0][0].imageReplacementOverride;
    expect(written).toEqual([
      { token: 'avatar', replacement: 'https://ss/c.jpg', shutterstockId: 'SS-333' },
    ]);
  });

  // Two slots whose queries share a top result used to get the same photo.
  it('smart fill never puts the same photo in two slots when it has a choice', async () => {
    const twoSlot = {
      ...SNIPPET,
      imageReplacement: [
        { token: 'a', replacement: 'image::1' },
        { token: 'b', replacement: 'image::1' },
      ],
    };
    const { service, saved } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1')] },
      snippets: [twoSlot],
      queries: [
        { snippetId: 's1', token: 'a', query: 'coffee' },
        { snippetId: 's1', token: 'b', query: 'coffee' },
      ],
      searchImages: found(img('SS-1', 1.5), img('SS-2', 1.4)),
    });

    await service.customizeImages(PAGE_ID, ORG_ID);

    const ids = saved[0][0].imageReplacementOverride.map((o: any) => o.shutterstockId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('PagesService.customizeImages quick mode', () => {
  const MULTI = {
    _id: 's1',
    textReplacement: [],
    imageReplacement: [
      { token: 'hero', replacement: 'image::5' }, // 1920x1300, wide
      { token: 'card', replacement: 'image::11' }, // 400x300
      { token: 'tall', replacement: 'image::24' }, // 3673x5207, tall
      { token: 'face', replacement: 'image::8' }, // 60x60 avatar
    ],
  };

  it('runs one keyword search plus a portrait search, with no AI call', async () => {
    const searchImages = jest.fn(async (query: string) =>
      query.includes('headshot')
        ? { images: [img('FACE', 1)] }
        : { images: [img('W', 1.5), img('C', 1.33), img('T', 0.7), img('X', 1)] },
    );
    const { service, saved, openai, aiUsage } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1')] },
      snippets: [MULTI],
      queries: [],
      searchImages,
    });

    const result: any = await service.customizeImages(PAGE_ID, ORG_ID, {
      mode: 'quick',
      keywords: '  craft   brewery ',
    });

    expect(openai.deriveImageQueries).not.toHaveBeenCalled();
    expect(aiUsage.consume).not.toHaveBeenCalled();
    expect(searchImages).toHaveBeenCalledTimes(2);
    expect(searchImages.mock.calls[0][0]).toBe('craft brewery');

    const byToken = Object.fromEntries(
      saved[0][0].imageReplacementOverride.map((o: any) => [o.token, o.shutterstockId]),
    );
    expect(byToken).toEqual({ hero: 'W', card: 'C', tall: 'T', face: 'FACE' });
    expect(result.imageFill).toMatchObject({
      mode: 'quick',
      fellBack: false,
      keywords: 'craft brewery',
      requested: 4,
      filled: 4,
    });
  });

  it('uses the site name when no keywords are given', async () => {
    const searchImages = found(img('A', 1.5));
    const { service } = buildService({
      page: { name: 'Home', siteName: "Stan's HVAC", snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [],
      searchImages,
    });

    await service.customizeImages(PAGE_ID, ORG_ID, { mode: 'quick' });

    expect(searchImages.mock.calls[0][0]).toBe("Stan's HVAC");
  });

  it('fails without marking anything when the search finds nothing', async () => {
    const { service, saved } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [],
      searchImages: found(),
    });

    await expect(
      service.customizeImages(PAGE_ID, ORG_ID, { mode: 'quick', keywords: 'zxqv' }),
    ).rejects.toThrow(/No stock photos matched/);
    expect(saved).toHaveLength(0);
  });

  it('smart mode falls back to quick fill when OpenAI fails', async () => {
    const searchImages = found(img('A', 1.5));
    const { service, saved } = buildService({
      page: { name: 'Home', siteName: 'Bean Co', snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [],
      searchImages,
      openaiError: new Error('429 insufficient_quota'),
    });

    const result: any = await service.customizeImages(PAGE_ID, ORG_ID);

    expect(searchImages.mock.calls[0][0]).toBe('Bean Co');
    expect(saved[0][0].imageReplacementOverride[0].shutterstockId).toBe('A');
    expect(result.imageFill).toMatchObject({ mode: 'quick', fellBack: true, keywords: 'Bean Co' });
  });
});
