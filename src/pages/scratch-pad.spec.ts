import { PagesService } from './pages.service';
import { SCRATCH_PAD_LIMIT } from '../common/scratch-pad';

// findOne() validates both ids as ObjectIds, so fixtures need real ones.
const PAGE_ID = '507f1f77bcf86cd799439011';
const ORG_ID = '507f1f77bcf86cd799439012';

/**
 * A snippet abstract carrying the customizations that a park/restore must not
 * lose. `shutterstockId` matters most: it is what the finalize licensing
 * hand-off is assembled from, so dropping it means telling a customer to
 * license an image that is no longer on their page — or failing to tell them
 * about one that is.
 */
function customizedAbstract(snippetId: string) {
  return {
    id: snippetId,
    cssOverride: `.${snippetId} { color: rebeccapurple; }`,
    jsOverride: `console.log("${snippetId}");`,
    htmlOverride: { headline: `<h1>${snippetId}</h1>` },
    textReplacementOverride: [
      { token: 'headline', replacement: `Real headline for ${snippetId}` },
    ],
    imageReplacementOverride: [
      {
        token: 'hero',
        replacement: `https://img.example/${snippetId}.jpg`,
        shutterstockId: `ss-${snippetId}`,
      },
    ],
    aiCustomized: true,
    aiImagesPopulated: true,
  };
}

function buildService(page: any) {
  // Mirrors a Mongoose document closely enough for these paths: findOne returns
  // the stored doc, findOneAndUpdate applies $set and hands back the result.
  const stored = page;
  const writes: any[] = [];

  const pageModel: any = {
    findOne: () => ({ exec: async () => stored }),
    findOneAndUpdate: (_filter: any, update: any) => {
      writes.push(update.$set);
      Object.assign(stored, update.$set);
      return { exec: async () => stored };
    },
  };

  const pubsub: any = { publish: jest.fn().mockResolvedValue(undefined) };
  const noop: any = {};

  const service = new PagesService(
    pageModel,
    pubsub,
    noop, // openai
    noop, // snippets
    noop, // orgs
    noop, // plans
    noop, // shutterstock
    noop, // aiUsage
    noop, // templates
  );

  return { service, stored, writes, pubsub };
}

describe('PagesService scratch pad', () => {
  describe('park', () => {
    it('moves a snippet off the page and onto the scratch pad', async () => {
      const { service, stored } = buildService({
        snippets: [customizedAbstract('a'), customizedAbstract('b')],
        scratchPad: [],
      });

      await service.parkSnippet(PAGE_ID, ORG_ID, 0);

      expect(stored.snippets.map((s: any) => s.id)).toEqual(['b']);
      expect(stored.scratchPad.map((s: any) => s.id)).toEqual(['a']);
    });

    it('preserves every customization, shutterstockId included', async () => {
      const original = customizedAbstract('a');
      const { service, stored } = buildService({
        snippets: [original],
        scratchPad: [],
      });

      await service.parkSnippet(PAGE_ID, ORG_ID, 0);

      // The whole point of storing SnippetAbstract on the shelf rather than a
      // bare id: this must be the same object, not a reconstruction of it.
      expect(stored.scratchPad[0]).toEqual(original);
    });

    it('rejects an out-of-range index rather than throwing a 500', async () => {
      const { service } = buildService({ snippets: [], scratchPad: [] });

      await expect(service.parkSnippet(PAGE_ID, ORG_ID, 3)).rejects.toThrow(
        /No snippet at position 3/,
      );
    });

    it(`refuses to park beyond ${SCRATCH_PAD_LIMIT}`, async () => {
      const full = Array.from({ length: SCRATCH_PAD_LIMIT }, (_, i) =>
        customizedAbstract(`parked-${i}`),
      );
      const { service, stored } = buildService({
        snippets: [customizedAbstract('a')],
        scratchPad: full,
      });

      await expect(service.parkSnippet(PAGE_ID, ORG_ID, 0)).rejects.toThrow(
        /Scratch pad is full/,
      );
      // And the page keeps its snippet — a refused park must not half-apply.
      expect(stored.snippets).toHaveLength(1);
      expect(stored.scratchPad).toHaveLength(SCRATCH_PAD_LIMIT);
    });
  });

  describe('restore', () => {
    it('round-trips a snippet without losing anything', async () => {
      const original = customizedAbstract('a');
      const { service, stored } = buildService({
        snippets: [original, customizedAbstract('b')],
        scratchPad: [],
      });

      await service.parkSnippet(PAGE_ID, ORG_ID, 0);
      await service.restoreSnippet(PAGE_ID, ORG_ID, 0, 1);

      expect(stored.scratchPad).toHaveLength(0);
      expect(stored.snippets.map((s: any) => s.id)).toEqual(['b', 'a']);
      // Deep equality against the pre-park object is the regression guard.
      expect(stored.snippets[1]).toEqual(original);
    });

    it('appends when no position is given', async () => {
      const { service, stored } = buildService({
        snippets: [customizedAbstract('a'), customizedAbstract('b')],
        scratchPad: [customizedAbstract('parked')],
      });

      await service.restoreSnippet(PAGE_ID, ORG_ID, 0);

      expect(stored.snippets.map((s: any) => s.id)).toEqual([
        'a',
        'b',
        'parked',
      ]);
    });

    it('clamps an out-of-range insertion point instead of failing', async () => {
      const { service, stored } = buildService({
        snippets: [customizedAbstract('a')],
        scratchPad: [customizedAbstract('parked')],
      });

      await service.restoreSnippet(PAGE_ID, ORG_ID, 0, 99);

      expect(stored.snippets.map((s: any) => s.id)).toEqual(['a', 'parked']);
    });

    it('rejects an out-of-range scratch index', async () => {
      const { service } = buildService({ snippets: [], scratchPad: [] });

      await expect(
        service.restoreSnippet(PAGE_ID, ORG_ID, 0),
      ).rejects.toThrow(/No snippet at position 0 on the scratch pad/);
    });
  });

  describe('screenshot bookkeeping', () => {
    it('marks the page dirty when a park changes what renders', async () => {
      const { service, writes, pubsub } = buildService({
        snippets: [customizedAbstract('a')],
        scratchPad: [],
      });

      await service.parkSnippet(PAGE_ID, ORG_ID, 0);

      expect(writes[0].contentUpdatedAt).toBeInstanceOf(Date);
      expect(pubsub.publish).toHaveBeenCalled();
    });

    it('leaves it alone when only the shelf is reordered', async () => {
      const { service, writes, pubsub } = buildService({
        snippets: [],
        scratchPad: [customizedAbstract('a'), customizedAbstract('b')],
      });

      await service.reorderScratchPad(PAGE_ID, ORG_ID, 0, 1);

      // Reordering the shelf changes nothing a visitor can see. Bumping here
      // would queue a screenshot capture for an invisible edit, on every drag.
      expect(writes[0].contentUpdatedAt).toBeUndefined();
      expect(pubsub.publish).not.toHaveBeenCalled();
    });

    it('leaves it alone when a parked snippet is discarded', async () => {
      const { service, writes, stored } = buildService({
        snippets: [],
        scratchPad: [customizedAbstract('a'), customizedAbstract('b')],
      });

      await service.discardScratchSnippet(PAGE_ID, ORG_ID, 0);

      expect(stored.scratchPad.map((s: any) => s.id)).toEqual(['b']);
      expect(writes[0].contentUpdatedAt).toBeUndefined();
    });
  });

  describe('licensing', () => {
    it('never lists images belonging to a parked snippet', async () => {
      const onPage = customizedAbstract('on-page');
      const parked = customizedAbstract('parked');
      const { service } = buildService({
        snippets: [onPage],
        scratchPad: [parked],
      });
      // getLicensing consults the Shutterstock client only for this flag.
      (service as any).shutterstockService = { canEditCollections: () => false };

      const { images } = await service.getLicensing(PAGE_ID, ORG_ID);
      const ids = images.map((i) => i.shutterstockId);

      expect(ids).toContain('ss-on-page');
      // The regression that matters: a customer told to license a photo that
      // is sitting on the shelf and appears nowhere in their exported site.
      expect(ids).not.toContain('ss-parked');
    });
  });

  describe('reorder', () => {
    it('moves within the shelf', async () => {
      const { service, stored } = buildService({
        snippets: [],
        scratchPad: ['a', 'b', 'c'].map(customizedAbstract),
      });

      await service.reorderScratchPad(PAGE_ID, ORG_ID, 2, 0);

      expect(stored.scratchPad.map((s: any) => s.id)).toEqual(['c', 'a', 'b']);
    });
  });
});
