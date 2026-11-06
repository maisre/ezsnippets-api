import { OpenaiService } from './openai.service';

// Fake chat client: answers chunk requests from a handler, briefs with a fixed brief.
function serviceWith(handler: (keys: string[], call: number) => Record<string, string>) {
  const service = new OpenaiService('test-key');
  const calls: any[] = [];
  let chunkCall = 0;
  (service as any).client = {
    chat: {
      completions: {
        create: jest.fn(async (args: any) => {
          calls.push(args);
          const user: string = args.messages[1].content;
          if (user.includes('"brief"')) {
            return { choices: [{ message: { content: JSON.stringify({ brief: 'Bean Co, coffee' }) } }] };
          }
          const blocks = JSON.parse(user.split('Blocks to rewrite:\n')[1].split('\n\nRespond')[0]);
          const keys = blocks.flatMap((b: any) => Object.keys(b.slots));
          return { choices: [{ message: { content: JSON.stringify({ t: handler(keys, chunkCall++) }) } }] };
        }),
      },
    },
  };
  return { service, calls };
}

function snippet(id: string, n: number) {
  return {
    snippetId: id,
    replacements: Array.from({ length: n }, (_, i) => ({ token: `P_${i + 1}`, original: `orig ${id} ${i + 1}` })),
  };
}

describe('OpenaiService.customizeContent', () => {
  it('retries slots the model skipped', async () => {
    // First pass answers only the first key of each chunk; the retry answers everything.
    const { service } = serviceWith((keys, call) =>
      Object.fromEntries((call === 0 ? keys.slice(0, 1) : keys).map((k) => [k, `new ${k}`])),
    );

    const result = await service.customizeContent({ name: 'Home', snippets: [snippet('a', 3)] });

    expect(result.snippets[0].replacements.map((r) => r.replacement)).toEqual(['new 1', 'new 2', 'new 3']);
  });

  it('keeps the original text when a slot is never answered', async () => {
    const { service } = serviceWith(() => ({}));
    const result = await service.customizeContent({ name: 'Home', snippets: [snippet('a', 1)] });
    expect(result.snippets[0].replacements[0].replacement).toBe('orig a 1');
  });

  it('writes a brief only when the work is split', async () => {
    const small = serviceWith((keys) => Object.fromEntries(keys.map((k) => [k, 'x'])));
    await small.service.customizeContent({ name: 'Home', snippets: [snippet('a', 5)] });
    expect(small.calls).toHaveLength(1);

    const big = serviceWith((keys) => Object.fromEntries(keys.map((k) => [k, 'x'])));
    await big.service.customizeContent({ name: 'Home', snippets: [snippet('a', 30), snippet('b', 30)] });
    // brief + 2 chunks, and each chunk prompt carries the brief
    expect(big.calls).toHaveLength(3);
    expect(big.calls.slice(1).every((c) => c.messages[1].content.includes('Bean Co, coffee'))).toBe(true);
  });

  it('sends a repeated snippet once but answers every copy', async () => {
    const { service, calls } = serviceWith((keys) => Object.fromEntries(keys.map((k) => [k, `new ${k}`])));
    const result = await service.customizeContent({ name: 'Home', snippets: [snippet('a', 2), snippet('a', 2)] });
    expect(calls).toHaveLength(1);
    expect(result.snippets).toHaveLength(2);
    expect(result.snippets[1].replacements[1].replacement).toBe('new 2');
  });
});
