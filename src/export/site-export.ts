import { Logger, ServiceUnavailableException } from '@nestjs/common';

const logger = new Logger('SiteExport');
import JSZip from 'jszip';
import { slugify as toSlug } from '../common/slugify';

// Shared static-site export used by both pages and layouts. Fetches a rendered
// HTML document from ez-view (the single rendering source), strips the editor's
// live-reload wiring, bundles every referenced image into /assets with relative
// URLs, and zips it up with a licensing manifest and README.

export interface ExportOptions {
  /** ez-view render URL, e.g. `${VIEW_URL}/view/page/:id`. */
  renderUrl: string;
  /** Human name used for the zip filename. */
  name: string;
  /** license-manifest.csv contents (Shutterstock ids). */
  licensingCsv: string;
}

// An export holds every bundled image and then the zip in memory, inside the
// same process that serves the whole API. Unbounded, a few simultaneous
// image-heavy exports could OOM-kill ez-api for everyone, so they run at most
// MAX_RUNNING at a time and the rest wait their turn (the editor just shows its
// spinner a little longer). Past MAX_WAITING the box is clearly overloaded and
// we refuse rather than pile up held-open requests.
const MAX_RUNNING_EXPORTS = 2;
const MAX_WAITING_EXPORTS = 20;
// Per-export memory bounds: images fetched in parallel, per-image size, and
// the total bundled. An image over either cap keeps its external URL.
const IMAGE_FETCH_CONCURRENCY = 6;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 80 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30000;

let runningExports = 0;
const waitingExports: Array<() => void> = [];

async function withExportSlot<T>(work: () => Promise<T>): Promise<T> {
  if (runningExports >= MAX_RUNNING_EXPORTS) {
    if (waitingExports.length >= MAX_WAITING_EXPORTS) {
      logger.warn(`Export refused: ${runningExports} running, ${waitingExports.length} waiting`);
      throw new ServiceUnavailableException(
        'Downloads are busy right now. Please try again in a minute.',
      );
    }
    // The finishing export hands its slot straight to us (runningExports is
    // not decremented in between), so nobody can jump the queue.
    await new Promise<void>((resolve) => waitingExports.push(resolve));
  } else {
    runningExports++;
  }
  try {
    return await work();
  } finally {
    const next = waitingExports.shift();
    if (next) next();
    else runningExports--;
  }
}

export function exportSiteZip(
  opts: ExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  return withExportSlot(() => buildSiteZip(opts));
}

async function buildSiteZip(
  opts: ExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  // Timed out so a hung render can't hold an export slot forever.
  const res = await fetch(opts.renderUrl, {
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    // A 503 to the browser isn't reported to Sentry, so this line is the only
    // record of why. (A 404 here once meant ez-view rejected the internal Host.)
    logger.error(`Export render failed: ${res.status} from ${opts.renderUrl}`);
    throw new ServiceUnavailableException('Could not render the content for export');
  }
  let html = await res.text();

  html = stripLiveReload(html);
  html = stripRendererIcons(html);
  const {
    texts: [rewritten],
    assets,
  } = await bundleImages([html]);

  const zip = new JSZip();
  zip.file('index.html', rewritten);
  for (const [name, buf] of assets) {
    zip.file(`assets/${name}`, buf);
  }
  zip.file('license-manifest.csv', opts.licensingCsv);
  zip.file('README.txt', readme(countManifestRows(opts.licensingCsv)));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, filename: `${(toSlug(opts.name) || 'site')}.zip` };
}

/** What ez-view's GET /view/layout/:id/static returns. */
interface StaticSiteParts {
  /** Subpages in order; the first is index.html. */
  pages: Array<{ name: string; file: string }>;
  /** Every text file of the site: the page documents, styles.css, scripts.js. */
  files: Array<{ path: string; content: string }>;
  /** Nav/footer links ez-view connected to a page (only clear matches). */
  navigation?: { nav: NavLink[]; footer: NavLink[] };
}

interface NavLink {
  text: string;
  file: string;
}

// ez-view only ever emits flat, slugged names; anything else is a bug, and
// must not become a path inside the customer's zip.
const SAFE_SITE_PATH = /^[a-z0-9][a-z0-9-]*\.(html|css|js)$/;

/**
 * Multi-page export for layouts: one HTML file per subpage plus shared
 * styles.css / scripts.js, already assembled by ez-view (the rendering source).
 * Here they get the same treatment as a single page — live-reload and renderer
 * icons stripped, images bundled once into a shared assets/ — and are zipped.
 * Runs in the same export slot as exportSiteZip, so the concurrency and size
 * caps cover it.
 */
export function exportMultiPageSiteZip(
  opts: ExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  return withExportSlot(() => buildMultiPageSiteZip(opts));
}

async function buildMultiPageSiteZip(
  opts: ExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  const res = await fetch(opts.renderUrl, {
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    logger.error(`Export render failed: ${res.status} from ${opts.renderUrl}`);
    throw new ServiceUnavailableException('Could not render the content for export');
  }
  const site = (await res.json()) as StaticSiteParts;
  const bad = site.files.find((f) => !SAFE_SITE_PATH.test(f.path));
  if (bad || !site.pages.length) {
    logger.error(`Export render returned an unusable site from ${opts.renderUrl}`);
    throw new ServiceUnavailableException('Could not render the content for export');
  }

  const cleaned = site.files.map((f) =>
    f.path.endsWith('.html')
      ? stripRendererIcons(stripLiveReload(f.content))
      : f.content,
  );
  const { texts, assets } = await bundleImages(cleaned);

  const zip = new JSZip();
  site.files.forEach((f, i) => zip.file(f.path, texts[i]));
  for (const [name, buf] of assets) {
    zip.file(`assets/${name}`, buf);
  }
  zip.file('license-manifest.csv', opts.licensingCsv);
  zip.file(
    'README.txt',
    readme(countManifestRows(opts.licensingCsv), site),
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, filename: `${(toSlug(opts.name) || 'site')}.zip` };
}

// The live-reload script is for the editor preview, not a published static site
// (it would try to open a websocket to the renderer).
function stripLiveReload(html: string): string {
  return html
    .replace(
      /<script[^>]*src=["']https:\/\/cdn\.socket\.io[^"']*["'][^>]*><\/script>/gi,
      '',
    )
    .replace(/<script>\s*const socket = io\([\s\S]*?<\/script>/gi, '');
}

// ez-view's render links EZ Snippet's own favicons by root-relative path. In
// the customer's site they would 404 (or, worse, show our icon), so drop them
// and leave the icon to whoever publishes it.
function stripRendererIcons(html: string): string {
  return html.replace(
    /<link\b[^>]*\brel=["'](?:shortcut )?(?:icon|apple-touch-icon)["'][^>]*\bhref=["']\/(?!\/)[^"']*["'][^>]*>\s*/gi,
    '',
  );
}

// Download every http(s) image referenced by the files (img src + CSS url()),
// store it under a local /assets name, and rewrite the references. Non-image or
// unreachable URLs (fonts, icon CDNs) are left external so they still load
// online. Failures are tolerated — a missing asset keeps its original URL.
//
// Takes every text file of the site at once, so an image used on several pages
// (or in both a page and styles.css) is fetched and stored once, and the size
// caps apply to the whole site rather than per file. All files sit at the zip
// root, so the same relative `assets/...` path works from each of them.
async function bundleImages(
  texts: string[],
): Promise<{ texts: string[]; assets: Map<string, Buffer> }> {
  const urlRe = /(?:src=["']|url\(\s*["']?)(https?:\/\/[^"')\s]+)/g;
  const urls = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(urlRe)) urls.add(m[1]);
  }

  const assets = new Map<string, Buffer>();
  const rewrites: Array<[string, string]> = [];
  let n = 0;
  let totalBytes = 0;
  await mapWithConcurrency([...urls], IMAGE_FETCH_CONCURRENCY, async (url) => {
    const asset = await fetchAsset(url);
    if (!asset) return;
    if (totalBytes + asset.buffer.length > MAX_TOTAL_ASSET_BYTES) return;
    totalBytes += asset.buffer.length;
    const name = `asset-${++n}.${extFor(url, asset.contentType)}`;
    assets.set(name, asset.buffer);
    rewrites.push([url, `assets/${name}`]);
  });

  const rewritten = texts.map((text) => {
    for (const [url, local] of rewrites) text = text.split(url).join(local);
    return text;
  });
  return { texts: rewritten, assets };
}

// Run `fn` over `items` with at most `limit` in flight.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Only images are bundled, and only up to MAX_ASSET_BYTES. Both are decided from
// the headers where possible, so a font or an oversized file is never pulled
// into memory just to be thrown away. The 12s timeout covers the body too.
async function fetchAsset(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    const declared = Number(res.headers.get('content-length'));
    if (!contentType.startsWith('image/') || declared > MAX_ASSET_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const buffer = await readCapped(res, MAX_ASSET_BYTES);
    return buffer ? { buffer, contentType } : null;
  } catch {
    return null;
  }
}

// Read a body, giving up once it passes `max` bytes — for responses with no (or
// a wrong) Content-Length.
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function extFor(url: string, contentType: string): string {
  const byType: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
  };
  const t = byType[contentType.split(';')[0].trim().toLowerCase()];
  if (t) return t;
  const match = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1].toLowerCase() : 'img';
}

function countManifestRows(csv: string): number {
  const lines = csv.trim().split('\n').filter(Boolean);
  return Math.max(0, lines.length - 1); // minus the header row
}

// `site` is given for a multi-page (layout) export: its pages and file names.
function readme(imageCount: number, site?: StaticSiteParts): string {
  const col = (s: string) => s.padEnd(22);
  const has = (path: string) => !!site?.files.some((f) => f.path === path);
  const contents = site
    ? [
        ...site.pages.map(
          (p) => `  ${col(p.file)}${p.name}${p.file === 'index.html' ? ' (home page)' : ''}`,
        ),
        ...(has('styles.css') ? [`  ${col('styles.css')}Styles shared by every page.`] : []),
        ...(has('scripts.js')
          ? [`  ${col('scripts.js')}Scripts shared by every page (navigation, footer).`]
          : []),
        `  ${col('assets/')}Images used by the site.`,
      ]
    : [
        '  index.html            The page.',
        '  assets/               Images used by the page.',
      ];
  return [
    'This website was exported from EZ Snippet.',
    '',
    'CONTENTS',
    ...contents,
    '  license-manifest.csv  The Shutterstock images to license before publishing.',
    '',
    // Nothing to license means nothing to say: "The 0 Shutterstock photo(s)"
    // reads like a bug to the customer's client.
    ...(imageCount > 0
      ? [
          'IMAGE LICENSING',
          `  The ${imageCount} Shutterstock photo${imageCount === 1 ? '' : 's'} in this site ${imageCount === 1 ? 'is a' : 'are'} watermarked preview`,
          `  image${imageCount === 1 ? '' : 's'}. Before you publish, license each id in license-manifest.csv (or send`,
          '  that file to your client to license on their own Shutterstock account) and',
          '  replace the matching files in /assets.',
          '',
        ]
      : []),
    ...(site?.navigation ? navigationSection(site.navigation) : []),
    'PUBLISHING',
    '  Upload all files to any static host — Netlify, S3, cPanel, GitHub Pages, etc.',
    '',
  ].join('\n');
}

// Which nav/footer links the export pointed at the page files. Only clear
// matches are connected; the rest are left for the developer to wire up, so
// they aren't listed.
function navigationSection(nav: NonNullable<StaticSiteParts['navigation']>): string[] {
  const links = [...nav.nav, ...nav.footer];
  if (!links.length) return [];
  return [
    'NAVIGATION',
    '  These links were connected to the page files:',
    ...links.map((l) => `  "${l.text || '(logo)'}" -> ${l.file}`),
    '',
  ];
}
