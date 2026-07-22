import { ServiceUnavailableException } from '@nestjs/common';
import JSZip from 'jszip';

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

export async function exportSiteZip(
  opts: ExportOptions,
): Promise<{ buffer: Buffer; filename: string }> {
  const res = await fetch(opts.renderUrl);
  if (!res.ok) {
    throw new ServiceUnavailableException('Could not render the content for export');
  }
  let html = await res.text();

  html = stripLiveReload(html);
  const { html: rewritten, assets } = await bundleImages(html);

  const zip = new JSZip();
  zip.file('index.html', rewritten);
  for (const [name, buf] of assets) {
    zip.file(`assets/${name}`, buf);
  }
  zip.file('license-manifest.csv', opts.licensingCsv);
  zip.file('README.txt', readme(countManifestRows(opts.licensingCsv)));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, filename: `${slugify(opts.name)}.zip` };
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

// Download every http(s) image referenced by the HTML (img src + CSS url()),
// store it under a local /assets name, and rewrite the references. Non-image or
// unreachable URLs (fonts, icon CDNs) are left external so they still load
// online. Failures are tolerated — a missing asset keeps its original URL.
async function bundleImages(
  html: string,
): Promise<{ html: string; assets: Map<string, Buffer> }> {
  const urlRe = /(?:src=["']|url\(\s*["']?)(https?:\/\/[^"')\s]+)/g;
  const urls = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(html)) !== null) {
    urls.add(m[1]);
  }

  const assets = new Map<string, Buffer>();
  const rewrites: Array<[string, string]> = [];
  let n = 0;
  await Promise.all(
    [...urls].map(async (url) => {
      const asset = await fetchAsset(url);
      if (!asset || !asset.contentType.startsWith('image/')) return;
      const name = `asset-${++n}.${extFor(url, asset.contentType)}`;
      assets.set(name, asset.buffer);
      rewrites.push([url, `assets/${name}`]);
    }),
  );

  for (const [url, local] of rewrites) {
    html = html.split(url).join(local);
  }
  return { html, assets };
}

async function fetchAsset(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    const arr = await res.arrayBuffer();
    if (arr.byteLength > 20 * 1024 * 1024) return null; // 20MB safety cap
    return { buffer: Buffer.from(arr), contentType };
  } catch {
    return null;
  }
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

function slugify(name: string): string {
  return (
    (name || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site'
  );
}

function readme(imageCount: number): string {
  return [
    'This website was exported from EZ Snippet.',
    '',
    'CONTENTS',
    '  index.html            The page.',
    '  assets/               Images used by the page.',
    '  license-manifest.csv  The Shutterstock images to license before publishing.',
    '',
    'IMAGE LICENSING',
    `  The ${imageCount} Shutterstock photo(s) in this site are watermarked preview`,
    '  images. Before you publish, license each id in license-manifest.csv (or send',
    '  that file to your client to license on their own Shutterstock account) and',
    '  replace the matching files in /assets.',
    '',
    'PUBLISHING',
    '  Upload all files to any static host — Netlify, S3, cPanel, GitHub Pages, etc.',
    '',
  ].join('\n');
}
