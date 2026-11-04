import { ServiceUnavailableException } from '@nestjs/common';
import JSZip from 'jszip';
import { exportMultiPageSiteZip, exportSiteZip } from './site-export';

const opts = (renderUrl: string) => ({
  renderUrl,
  name: 'Site',
  licensingCsv: 'shutterstock_id,uses\n',
});

const html = (urls: string[]) =>
  `<html><body>${urls.map((u) => `<img src="${u}">`).join('')}</body></html>`;

const image = (bytes: number, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), {
    headers: { 'content-type': 'image/png', ...headers },
  });

describe('exportSiteZip', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('runs at most two exports at once and queues the rest', async () => {
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    global.fetch = jest.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      running--;
      return new Response(html([]));
    }) as any;

    const all = Promise.all([1, 2, 3, 4].map((i) => exportSiteZip(opts(`http://view/${i}`))));
    for (let done = 0; done < 4; ) {
      await new Promise((r) => setImmediate(r));
      const r = releases.shift();
      if (r) {
        r();
        done++;
      }
    }
    await all;
    expect(peak).toBe(2);
  });

  it('refuses once the waiting queue is full', async () => {
    const releases: Array<() => void> = [];
    global.fetch = jest.fn(async () => {
      await new Promise<void>((r) => releases.push(r));
      return new Response(html([]));
    }) as any;

    const accepted = Array.from({ length: 22 }, (_, i) =>
      exportSiteZip(opts(`http://view/${i}`)),
    );
    await expect(exportSiteZip(opts('http://view/x'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Drain so module state is clean for the next test.
    for (let done = 0; done < 22; ) {
      await new Promise((r) => setImmediate(r));
      const r = releases.shift();
      if (r) {
        r();
        done++;
      }
    }
    await Promise.all(accepted);
  });

  it('skips images over the size cap and caps parallel image fetches', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://img/${i}.png`);
    urls.push('https://img/huge.png', 'https://img/unlabelled-huge.png', 'https://img/font.woff2');
    let inFlight = 0;
    let peak = 0;
    global.fetch = jest.fn(async (url: string) => {
      if (url === 'http://view/page') return new Response(html(urls));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      if (url.endsWith('huge.png') && !url.includes('unlabelled')) {
        return image(10, { 'content-length': String(21 * 1024 * 1024) });
      }
      if (url.includes('unlabelled')) return image(21 * 1024 * 1024);
      if (url.endsWith('.woff2')) {
        return new Response('x', { headers: { 'content-type': 'font/woff2' } });
      }
      return image(100);
    }) as any;

    const { buffer } = await exportSiteZip(opts('http://view/page'));
    const zip = await JSZip.loadAsync(buffer);
    const assets = Object.keys(zip.files).filter((f) => f.startsWith('assets/') && !zip.files[f].dir);
    expect(assets).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe('exportMultiPageSiteZip', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const shared = 'https://img/shared.png';
  const site = {
    name: 'Bakery',
    pages: [
      { name: 'Home', file: 'index.html' },
      { name: 'About Us', file: 'about-us.html' },
    ],
    files: [
      {
        path: 'index.html',
        content: `<link rel="icon" href="/favicon-32x32.png" /><img src="${shared}"><img src="https://img/home.png"><script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>`,
      },
      { path: 'about-us.html', content: `<img src="${shared}">` },
      { path: 'styles.css', content: `.hero{background:url("${shared}")}` },
      { path: 'scripts.js', content: 'console.log(1)' },
    ],
  };

  it('zips every page, shares one copy of each image and lists the pages', async () => {
    const imageFetches: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      if (url === 'http://view/static') return Response.json(site);
      imageFetches.push(url);
      return image(100);
    }) as any;

    const { buffer, filename } = await exportMultiPageSiteZip(opts('http://view/static'));
    const zip = await JSZip.loadAsync(buffer);
    const read = (p: string) => zip.file(p)!.async('string');

    expect(filename).toBe('site.zip');
    expect(imageFetches.sort()).toEqual(['https://img/home.png', shared]);
    const assets = Object.keys(zip.files).filter((f) => f.startsWith('assets/') && !zip.files[f].dir);
    expect(assets).toHaveLength(2);

    const index = await read('index.html');
    const about = await read('about-us.html');
    const css = await read('styles.css');
    const sharedLocal = /<img src="(assets\/[^"]+)">$/.exec(about)![1];
    expect(index).toContain(`src="${sharedLocal}"`);
    expect(css).toContain(`url("${sharedLocal}")`);
    expect(index).not.toContain('favicon');
    expect(index).not.toContain('socket.io');
    expect(await read('scripts.js')).toBe('console.log(1)');

    const readme = await read('README.txt');
    expect(readme).toMatch(/index\.html\s+Home \(home page\)/);
    expect(readme).toMatch(/about-us\.html\s+About Us/);
    expect(readme).toContain('styles.css');
    expect(readme).not.toContain('IMAGE LICENSING');
  });

  it('refuses a file path that is not a flat page/stylesheet/script name', async () => {
    global.fetch = jest.fn(async () =>
      Response.json({ ...site, files: [{ path: '../evil.html', content: '' }] }),
    ) as any;
    await expect(exportMultiPageSiteZip(opts('http://view/static'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('multi-page README navigation', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const site = (navigation: unknown) => ({
    pages: [
      { name: 'Home', file: 'index.html' },
      { name: 'Menu', file: 'menu.html' },
    ],
    files: [{ path: 'index.html', content: '<p>x</p>' }],
    navigation,
  });
  const readmeFor = async (navigation: unknown) => {
    global.fetch = jest.fn(async () => Response.json(site(navigation))) as any;
    const { buffer } = await exportMultiPageSiteZip(opts('http://view/static'));
    return (await JSZip.loadAsync(buffer)).file('README.txt')!.async('string');
  };

  it('lists only the links that were connected', async () => {
    const readme = await readmeFor({
      nav: [
        { text: 'Home', file: 'index.html', method: 'label' },
        { text: 'Menu', file: 'menu.html', method: 'href' },
      ],
      footer: [{ text: '', file: 'index.html', method: 'logo' }],
    });
    expect(readme).toContain(
      'NAVIGATION\n  These links were connected to the page files:\n' +
        '  "Home" -> index.html\n  "Menu" -> menu.html\n  "(logo)" -> index.html\n',
    );
    expect(readme).not.toMatch(/reachable|check this/i);
  });

  it('leaves the section out when nothing was connected', async () => {
    expect(await readmeFor({ nav: [], footer: [] })).not.toContain('NAVIGATION');
  });
});
