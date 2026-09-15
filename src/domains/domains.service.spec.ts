import { DomainsService, FAILURE_THRESHOLD } from './domains.service';

/**
 * Covers the status machine in applyCheck, which decides whether a customer's
 * client-facing link keeps working. The rules are easy to get subtly wrong and
 * the failure mode — a live domain going dark on one flaky DNS lookup — is
 * invisible until a customer complains.
 */
describe('DomainsService.applyCheck', () => {
  let service: DomainsService;
  let written: any;

  beforeEach(() => {
    written = null;
    const model: any = {
      findByIdAndUpdate: (_id: string, update: any) => {
        written = update.$set;
        return { exec: async () => ({ ...written }) };
      },
    };
    service = new DomainsService(model, {} as any, {} as any);
  });

  const domain = (over: Partial<any> = {}) =>
    ({ id: 'd1', hostname: 'view.x.com', status: 'pending', failureCount: 0, ...over }) as any;

  it('marks a passing check active and clears the error', async () => {
    await service.applyCheck(domain({ status: 'pending', failureCount: 2 }), {
      ok: true,
    });

    expect(written.status).toBe('active');
    expect(written.lastError).toBeNull();
    expect(written.failureCount).toBe(0);
    expect(written.verifiedAt).toBeInstanceOf(Date);
  });

  it('keeps a live domain live through a transient failure', async () => {
    // One bad lookup must not take a paying customer's link down.
    await service.applyCheck(domain({ status: 'active', failureCount: 0 }), {
      ok: false,
      error: 'nope',
    });

    expect(written.status).toBe('active');
    expect(written.failureCount).toBe(1);
    expect(written.lastError).toBe('nope');
  });

  it('gives up on a live domain once failures persist', async () => {
    await service.applyCheck(
      domain({ status: 'active', failureCount: FAILURE_THRESHOLD - 1 }),
      { ok: false, error: 'still nope' },
    );

    expect(written.status).toBe('failed');
  });

  it('leaves a brand-new domain pending rather than failed', async () => {
    // A customer who has just added a domain and not yet touched their DNS
    // should read "Waiting for DNS", not a red error they caused nothing of.
    await service.applyCheck(domain({ status: 'pending', failureCount: 0 }), {
      ok: false,
      error: 'no CNAME yet',
    });

    expect(written.status).toBe('pending');
    // The specific reason is still recorded and shown, so nothing is hidden.
    expect(written.lastError).toBe('no CNAME yet');
  });

  it('fails a never-working domain once it has been given enough chances', async () => {
    await service.applyCheck(
      domain({ status: 'pending', failureCount: FAILURE_THRESHOLD - 1 }),
      { ok: false, error: 'no CNAME yet' },
    );

    expect(written.status).toBe('failed');
  });
});

describe('DomainsService.target', () => {
  const original = process.env.CUSTOM_DOMAIN_TARGET;
  afterEach(() => {
    if (original === undefined) delete process.env.CUSTOM_DOMAIN_TARGET;
    else process.env.CUSTOM_DOMAIN_TARGET = original;
  });

  it('defaults to the production view host', () => {
    delete process.env.CUSTOM_DOMAIN_TARGET;
    const service = new DomainsService({} as any, {} as any, {} as any);
    expect(service.target).toBe('view.ez-snippets.com');
  });

  it('normalises whatever the environment supplies', () => {
    process.env.CUSTOM_DOMAIN_TARGET = 'HTTPS://View.EZ-Snippets.com/';
    const service = new DomainsService({} as any, {} as any, {} as any);
    expect(service.target).toBe('view.ez-snippets.com');
  });
});

/**
 * resolveServable is the single authority behind both the TLS gate and the
 * diagnose endpoint, so its reasons are what someone reads at 2am. Collapsing
 * them back into a bare null is the regression worth catching.
 */
describe('DomainsService.resolveServable', () => {
  const build = (domain: any, entitled = true) => {
    const model: any = {
      findOne: () => ({ exec: async () => domain }),
    };
    const service = new DomainsService(model, {} as any, {} as any);
    jest.spyOn(service, 'isEntitled').mockResolvedValue(entitled);
    return service;
  };

  it('reports an empty hostname', async () => {
    const r = await build(null).resolveServable('');
    expect(r).toMatchObject({ ok: false, reason: 'no-hostname' });
  });

  it('distinguishes never-registered from not-yet-verified', async () => {
    const missing = await build(null).resolveServable('view.x.com');
    expect(missing).toMatchObject({ ok: false, reason: 'not-registered' });

    const pending = await build({
      hostname: 'view.x.com',
      status: 'pending',
      lastError: 'no CNAME',
      org: 'o1',
    }).resolveServable('view.x.com');
    expect(pending).toMatchObject({ ok: false, reason: 'not-verified' });
    // The stored error is carried through so the log says what DNS actually did.
    expect((pending as any).detail).toContain('no CNAME');
  });

  it('reports a verified domain whose plan lapsed', async () => {
    const r = await build(
      { hostname: 'view.x.com', status: 'active', org: 'o1' },
      false,
    ).resolveServable('view.x.com');
    expect(r).toMatchObject({ ok: false, reason: 'not-entitled' });
  });

  it('approves a verified, entitled domain', async () => {
    const r = await build({
      hostname: 'view.x.com',
      status: 'active',
      org: 'o1',
    }).resolveServable('view.x.com');
    expect(r.ok).toBe(true);
  });

  it('normalises the hostname before deciding', async () => {
    const r = await build({
      hostname: 'view.x.com',
      status: 'active',
      org: 'o1',
    }).resolveServable('  VIEW.X.com:443  ');
    expect(r.ok).toBe(true);
  });
});
