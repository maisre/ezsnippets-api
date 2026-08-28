#!/usr/bin/env node
/**
 * Capture a web-sized preview image of every library snippet (or a subset).
 *
 *   node scripts/capture-snippets.js                      # every snippet
 *   node scripts/capture-snippets.js --missing            # only ones with no image yet
 *   node scripts/capture-snippets.js 690115ada482ced6556e3410 ...   # explicit ids
 *   node scripts/capture-snippets.js --type header --limit 20
 *   node scripts/capture-snippets.js --retry-failed
 *
 * Re-runnable: every run overwrites the images it captures and merges into the
 * manifest, so a partial run resumes with --missing and a fix to a handful of
 * snippets is re-shot by id without touching the other 1500.
 *
 * Output is WebP at --width (default 640), ~2x the ~300px palette card the
 * frontend renders these in. The 1538 PNGs this replaces averaged 175 KB each
 * (263 MB total) at full 1920px width — far more pixels and bytes than a
 * card-sized thumbnail can use, and PNG is the wrong codec for a photographic
 * marketing section. WebP at this width lands around 20-40 KB.
 *
 * Rendering goes through ez-view's /view/snippet/:id, the same endpoint the
 * editor previews from, so the capture shows what a page will actually render.
 *
 * Playwright and sharp are not ez-api dependencies — they are resolved out of
 * ez-background, which owns the production screenshot pipeline. Same convention
 * as capture-page.js and _shot.js.
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { chromium } = require(
  '/Users/mckay/Projects/ez-snippet/production/ez-background/node_modules/playwright',
);
const sharp = require(
  '/Users/mckay/Projects/ez-snippet/production/ez-background/node_modules/sharp',
);

const DB = process.env.DATABASE_URL || 'mongodb://localhost:27017/ez';
const VIEW = process.env.VIEW_URL || 'http://localhost:3100';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const OUT = path.resolve(
  flag('--out', process.env.SNIPPET_SHOT_DIR || path.join(__dirname, '..', 'snippet-shots')),
);
const WIDTH = Number(flag('--width', 640));
const QUALITY = Number(flag('--quality', 72));
// Render width. 1440 is the desktop breakpoint the library is designed against;
// capturing narrower would trip mobile media queries and show the wrong layout.
const VIEWPORT_WIDTH = Number(flag('--viewport-width', 1440));
// Hard cap on captured height. A few snippets are full-bleed heroes with 200vh
// of scroll; uncapped they encode into a ribbon that is unreadable at card size
// and dwarfs every other file.
const MAX_HEIGHT = Number(flag('--max-height', 2600));
const CONCURRENCY = Number(flag('--concurrency', 4));
const LIMIT = Number(flag('--limit', 0));
const TYPE = flag('--type', null);
const IDS_FILE = flag('--ids-file', null);
const ONLY_MISSING = bool('--missing');
const RETRY_FAILED = bool('--retry-failed');

const MANIFEST = path.join(OUT, 'manifest.json');
const FAILURES = path.join(OUT, 'failures.json');

const explicitIds = args.filter((a) => /^[a-f0-9]{24}$/i.test(a));
const unknown = args.filter((a) => !/^[a-f0-9]{24}$/i.test(a));
if (unknown.length) {
  console.error(`unrecognised argument(s): ${unknown.join(' ')}`);
  console.error(
    'usage: capture-snippets.js [<snippetId>...] [--missing] [--retry-failed] [--type <t>]\n' +
      '                          [--limit <n>] [--ids-file <f>] [--out <dir>]\n' +
      '                          [--width <px>] [--quality <n>] [--max-height <px>] [--concurrency <n>]',
  );
  process.exit(1);
}

/**
 * Walk the snippet once so reveal-on-scroll animations settle.
 *
 * Much of the library animates in on an IntersectionObserver. A resting
 * screenshot of an unscrolled page catches those sections at opacity: 0, which
 * reads as a blank card. Same walk capture-page.js does.
 */
async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        window.scrollTo(0, y);
        y += Math.floor(window.innerHeight * 0.8);
        if (y < document.body.scrollHeight) setTimeout(step, 80);
        else {
          window.scrollTo(0, 0);
          setTimeout(resolve, 400);
        }
      };
      step();
    });
  });
  // Webfonts (Montserrat/Source Sans via Google Fonts, Font Awesome icons)
  // arrive after load; shooting before they swap in captures fallback glyphs
  // and the wrong metrics.
  await page.evaluate(() => document.fonts.ready).catch(() => {});
}

/**
 * Vertical extent of the rendered snippet, in page coordinates.
 *
 * Normally this is just the <main> box. But a header designed to overlay a
 * hero (`.header { position: absolute }`) is out of flow, so on a preview page
 * with nothing behind it <main> collapses to 0px and the snippet looks like it
 * failed to render. Falling back to the union of the descendant boxes recovers
 * the real extent for those, and for any other snippet whose only content is
 * absolutely positioned.
 */
async function measure(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main#main-content');
    if (!main) return null;

    const own = main.getBoundingClientRect();
    if (own.height >= 8) {
      return { y: own.top + window.scrollY, height: own.height };
    }

    let top = Infinity;
    let bottom = -Infinity;
    for (const el of main.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      // Skip zero-area and display:none nodes, which report an empty rect at
      // the origin and would drag `top` to 0 for no reason.
      if (r.width < 1 || r.height < 1) continue;
      top = Math.min(top, r.top + window.scrollY);
      bottom = Math.max(bottom, r.bottom + window.scrollY);
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
      return { y: own.top + window.scrollY, height: own.height };
    }
    return { y: top, height: bottom - top };
  });
}

async function captureOne(context, id) {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));

  try {
    // 'load' rather than 'networkidle': the view template opens a socket.io
    // connection that never goes idle, so networkidle would burn the full
    // timeout on every single snippet.
    const response = await page.goto(`${VIEW}/view/snippet/${id}`, {
      waitUntil: 'load',
      timeout: 30000,
    });
    if (response && !response.ok()) {
      throw new Error(`ez-view returned ${response.status()}`);
    }

    await settle(page);

    const box = await measure(page);
    if (!box || box.height < 8) {
      throw new Error(`snippet rendered empty (height ${box ? Math.round(box.height) : 0}px)`);
    }

    // Clip against the full page rather than element.screenshot(): a snippet
    // whose outer element is narrower than the viewport (a centred card, say)
    // would otherwise crop to that element and lose the full-bleed background
    // that is half of how the section reads. fullPage so the clip can extend
    // past the viewport for tall snippets.
    const height = Math.min(Math.ceil(box.height), MAX_HEIGHT);
    const raw = await page.screenshot({
      type: 'png',
      fullPage: true,
      clip: { x: 0, y: Math.max(0, box.y), width: VIEWPORT_WIDTH, height },
    });

    const buf = await sharp(raw)
      .resize({ width: WIDTH, withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer();
    const meta = await sharp(buf).metadata();

    fs.writeFileSync(path.join(OUT, `${id}.webp`), buf);
    return {
      id,
      bytes: buf.length,
      width: meta.width,
      height: meta.height,
      truncated: Math.ceil(box.height) > MAX_HEIGHT,
      pageErrors: pageErrors.length ? pageErrors.slice(0, 3) : undefined,
    };
  } finally {
    await page.close();
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  await mongoose.connect(DB);
  const db = mongoose.connection.db;

  const query = {};
  if (TYPE) query.type = TYPE;

  let wanted = explicitIds;
  if (IDS_FILE) {
    wanted = wanted.concat(
      fs.readFileSync(IDS_FILE, 'utf8').split(/\s+/).filter((s) => /^[a-f0-9]{24}$/i.test(s)),
    );
  }
  if (RETRY_FAILED) {
    if (!fs.existsSync(FAILURES)) {
      console.error(`--retry-failed: no ${FAILURES} from a previous run`);
      process.exit(1);
    }
    wanted = wanted.concat(JSON.parse(fs.readFileSync(FAILURES, 'utf8')).map((f) => f.id));
  }
  if (wanted.length) {
    query._id = { $in: [...new Set(wanted)].map((s) => new mongoose.Types.ObjectId(s)) };
  }

  let snippets = await db
    .collection('snippets')
    .find(query, { projection: { type: 1 } })
    .sort({ _id: 1 })
    .toArray();
  await mongoose.disconnect();

  if (ONLY_MISSING) {
    snippets = snippets.filter((s) => !fs.existsSync(path.join(OUT, `${s._id}.webp`)));
  }
  if (LIMIT) snippets = snippets.slice(0, LIMIT);

  if (!snippets.length) {
    console.log('Nothing to capture.');
    return;
  }

  console.log(`Capturing ${snippets.length} snippet(s) -> ${OUT}`);
  console.log(
    `  render ${VIEWPORT_WIDTH}px wide, output ${WIDTH}px WebP q${QUALITY}, ` +
      `height cap ${MAX_HEIGHT}px, concurrency ${CONCURRENCY}\n`,
  );

  const browser = await chromium.launch();
  const results = [];
  const failures = [];
  let next = 0;
  let done = 0;

  const worker = async () => {
    const context = await browser.newContext({
      viewport: { width: VIEWPORT_WIDTH, height: 900 },
      deviceScaleFactor: 1,
    });
    try {
      while (next < snippets.length) {
        const s = snippets[next++];
        const id = String(s._id);
        try {
          const r = await captureOne(context, id);
          results.push({ ...r, type: s.type });
          done++;
          if (done % 25 === 0 || done === snippets.length) {
            console.log(`  ${done}/${snippets.length} captured`);
          }
        } catch (e) {
          failures.push({ id, type: s.type, error: e.message.split('\n')[0] });
          done++;
          console.error(`  FAIL ${id} (${s.type}): ${e.message.split('\n')[0]}`);
        }
      }
    } finally {
      await context.close();
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, snippets.length) }, worker));
  await browser.close();

  // Merge into any existing manifest so a subset run does not erase the record
  // of the snippets it did not touch.
  const manifest = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    : {};
  for (const r of results) manifest[r.id] = r;
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(FAILURES, JSON.stringify(failures, null, 2));

  const bytes = results.reduce((a, r) => a + r.bytes, 0);
  const truncated = results.filter((r) => r.truncated);
  console.log('\n=== Summary ===');
  console.log(`Captured:  ${results.length}`);
  console.log(
    `Failed:    ${failures.length}` +
      (failures.length ? `  (see ${FAILURES}, re-run with --retry-failed)` : ''),
  );
  if (results.length) {
    const max = Math.max(...results.map((r) => r.bytes));
    console.log(
      `Size:      ${(bytes / 1048576).toFixed(1)} MB total, ` +
        `${Math.round(bytes / results.length / 1024)} KB avg, ${Math.round(max / 1024)} KB max`,
    );
  }
  if (truncated.length) {
    console.log(`Truncated: ${truncated.length} snippet(s) hit the ${MAX_HEIGHT}px height cap`);
  }
  console.log(`Manifest:  ${MANIFEST}`);
  console.log('\nNext: node scripts/upload-snippet-shots.js');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
