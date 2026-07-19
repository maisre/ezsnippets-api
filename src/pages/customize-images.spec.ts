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
  findBestMatch: jest.Mock;
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
    deriveImageQueries: jest.fn().mockResolvedValue({ slots: opts.queries }),
  };
  const snippetsService: any = {
    findOne: async (id: string) => opts.snippets.find((s) => String(s._id) === id),
  };
  const shutterstock: any = { findBestMatch: opts.findBestMatch };

  const service = new PagesService(
    pageModel,
    pubsub,
    openai,
    snippetsService,
    {} as any,
    {} as any,
    shutterstock,
  );

  return { service, saved, openai, shutterstock };
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
      findBestMatch: jest
        .fn()
        .mockResolvedValue({ id: 'SS-111', previewUrl: 'https://ss/a.jpg', aspect: 1.5 }),
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
      findBestMatch: jest
        .fn()
        .mockResolvedValue({ id: 'SS-NEW', previewUrl: 'https://ss/new.jpg', aspect: 1.5 }),
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
      findBestMatch: jest
        .fn()
        .mockResolvedValue({ id: 'SS-222', previewUrl: 'https://ss/b.jpg', aspect: 1.5 }),
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
    const findBestMatch = jest.fn();
    const { service } = buildService({
      page: { name: 'Home', snippets: [abstractFor('s1', existing)] },
      snippets: [SNIPPET],
      queries: [],
      findBestMatch,
    });

    const result = await service.customizeImages(PAGE_ID, ORG_ID);

    // No slots to fill, so neither OpenAI nor Shutterstock is called at all.
    expect(findBestMatch).not.toHaveBeenCalled();
    expect(result.snippets[0].imageReplacementOverride).toEqual(existing);
  });

  it('passes the slot shape and user direction through to query derivation', async () => {
    const { service, openai } = buildService({
      page: { name: 'Home', description: 'A coffee roaster', snippets: [abstractFor('s1')] },
      snippets: [SNIPPET],
      queries: [],
      findBestMatch: jest.fn(),
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
      findBestMatch: jest
        .fn()
        .mockRejectedValueOnce(new Error('shutterstock 429'))
        .mockResolvedValueOnce({ id: 'SS-333', previewUrl: 'https://ss/c.jpg', aspect: 1 }),
    });

    await service.customizeImages(PAGE_ID, ORG_ID);

    // The failed slot is simply absent; the successful one is written.
    const written = saved[0][0].imageReplacementOverride;
    expect(written).toEqual([
      { token: 'avatar', replacement: 'https://ss/c.jpg', shutterstockId: 'SS-333' },
    ]);
  });
});
