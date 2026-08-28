#!/usr/bin/env node
/**
 * Sync locally captured snippet previews to the assets bucket + CloudFront.
 *
 *   node scripts/upload-snippet-shots.js                  # sync everything new/changed
 *   node scripts/upload-snippet-shots.js --dry-run        # report, upload nothing
 *   node scripts/upload-snippet-shots.js 690115ada...     # just these ids
 *   node scripts/upload-snippet-shots.js --force          # re-upload even if unchanged
 *   node scripts/upload-snippet-shots.js --prune          # also delete remote shots with no local file
 *
 * Re-runnable and cheap to re-run: remote ETags are compared against the local
 * file MD5s and unchanged objects are skipped, so a re-capture of 20 snippets
 * uploads 20 objects, not 1580.
 *
 * Objects land at snippets/<snippetId>.webp. The bucket blocks all public
 * access and is read exclusively through CloudFront via an Origin Access
 * Control, so there is no ACL to set — the bucket policy already grants
 * cloudfront.amazonaws.com s3:GetObject on the whole bucket, which covers this
 * new prefix without a policy change.
 *
 * The assets CloudFront cache policy has a 1-day minimum TTL, so a re-uploaded
 * object keeps serving stale at the edge until it is invalidated. This does
 * that automatically on the single path /snippets/* (one path, so it stays
 * inside the free 1000-invalidation-paths-per-month allowance).
 *
 * Bucket and distribution are discovered from the caller's account rather than
 * hardcoded. Only @aws-sdk/client-s3 is an ez-api dependency, so account
 * lookup and invalidation shell out to the AWS CLI.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

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

const PROFILE = flag('--profile', process.env.AWS_PROFILE || 'ez');
const REGION = flag('--region', process.env.AWS_REGION || 'us-east-1');
const SRC = path.resolve(
  flag('--src', process.env.SNIPPET_SHOT_DIR || path.join(__dirname, '..', 'snippet-shots')),
);
const PREFIX = flag('--prefix', 'snippets/').replace(/^\/+|\/+$/g, '') + '/';
const CACHE_CONTROL = flag('--cache-control', 'public, max-age=86400');
const CONCURRENCY = Number(flag('--concurrency', 12));
let BUCKET = flag('--bucket', process.env.ASSETS_BUCKET || null);
let DISTRIBUTION = flag('--distribution', process.env.ASSETS_DISTRIBUTION_ID || null);
const DRY_RUN = bool('--dry-run');
const FORCE = bool('--force');
const PRUNE = bool('--prune');
const NO_INVALIDATE = bool('--no-invalidate');

const only = args.filter((a) => /^[a-f0-9]{24}$/i.test(a));
const unknown = args.filter((a) => !/^[a-f0-9]{24}$/i.test(a));
if (unknown.length) {
  console.error(`unrecognised argument(s): ${unknown.join(' ')}`);
  console.error(
    'usage: upload-snippet-shots.js [<snippetId>...] [--dry-run] [--force] [--prune]\n' +
      '                              [--no-invalidate] [--src <dir>] [--prefix <p>]\n' +
      '                              [--bucket <b>] [--distribution <id>] [--profile <p>] [--region <r>]',
  );
  process.exit(1);
}

// The SDK's default credential chain reads AWS_PROFILE, so setting it here is
// enough to point both the SDK and the CLI calls at the same account.
process.env.AWS_PROFILE = PROFILE;

const aws = (...argv) =>
  execFileSync('aws', [...argv, '--profile', PROFILE, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
  });

function discover() {
  if (!BUCKET) {
    const account = JSON.parse(aws('sts', 'get-caller-identity')).Account;
    // Matches AssetsStack's default naming: account-suffixed for global
    // S3 uniqueness. Override with --bucket if the stack was deployed with
    // -c assetsBucketName=...
    BUCKET = `ez-snippet-assets-${account}`;
  }
  if (!DISTRIBUTION && !NO_INVALIDATE) {
    const list = JSON.parse(aws('cloudfront', 'list-distributions'));
    const match = (list.DistributionList.Items || []).find((d) =>
      (d.Origins.Items || []).some((o) => o.DomainName.startsWith(`${BUCKET}.s3`)),
    );
    if (match) DISTRIBUTION = match.Id;
  }
}

async function listRemote(s3) {
  const seen = new Map();
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }),
    );
    for (const o of page.Contents || []) {
      seen.set(o.Key, { etag: (o.ETag || '').replace(/"/g, ''), size: o.Size });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return seen;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`no capture directory at ${SRC} — run capture-snippets.js first`);
    process.exit(1);
  }

  let files = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.webp'))
    .map((f) => ({ id: path.basename(f, '.webp'), file: path.join(SRC, f) }));

  if (only.length) {
    const wanted = new Set(only.map((s) => s.toLowerCase()));
    files = files.filter((f) => wanted.has(f.id.toLowerCase()));
    const missing = [...wanted].filter((id) => !files.some((f) => f.id.toLowerCase() === id));
    if (missing.length) {
      console.error(`no local capture for: ${missing.join(', ')}`);
    }
  }

  if (!files.length) {
    console.log('Nothing to upload.');
    return;
  }

  discover();
  console.log(`Bucket:       s3://${BUCKET}/${PREFIX}`);
  console.log(`Distribution: ${DISTRIBUTION || '(none found — skipping invalidation)'}`);
  console.log(`Source:       ${SRC}  (${files.length} file(s))`);
  if (DRY_RUN) console.log('DRY RUN — nothing will be written\n');
  else console.log('');

  const s3 = new S3Client({ region: REGION });
  const remote = await listRemote(s3);

  const todo = [];
  let unchanged = 0;
  for (const f of files) {
    const body = fs.readFileSync(f.file);
    const md5 = crypto.createHash('md5').update(body).digest('hex');
    const key = `${PREFIX}${f.id}.webp`;
    const existing = remote.get(key);
    // A single PutObject stores the object MD5 as the ETag, so this is an
    // exact content comparison, not a size/mtime guess.
    if (!FORCE && existing && existing.etag === md5) {
      unchanged++;
      continue;
    }
    todo.push({ ...f, key, body, isNew: !existing });
  }

  const stale = PRUNE
    ? [...remote.keys()].filter(
        (k) => !files.some((f) => `${PREFIX}${f.id}.webp` === k),
      )
    : [];

  console.log(`To upload: ${todo.length}  (${todo.filter((t) => t.isNew).length} new, ${todo.length - todo.filter((t) => t.isNew).length} changed)`);
  console.log(`Unchanged: ${unchanged}`);
  if (PRUNE) console.log(`To delete: ${stale.length}`);

  if (DRY_RUN) {
    for (const t of todo.slice(0, 20)) console.log(`  ${t.isNew ? 'NEW ' : 'UPD '} ${t.key}`);
    if (todo.length > 20) console.log(`  ... and ${todo.length - 20} more`);
    for (const k of stale.slice(0, 20)) console.log(`  DEL  ${k}`);
    return;
  }

  let next = 0;
  let uploaded = 0;
  let bytes = 0;
  const failures = [];
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: t.key,
            Body: t.body,
            ContentType: 'image/webp',
            CacheControl: CACHE_CONTROL,
            // Deliberately untagged. The bucket's lifecycle rule expires
            // objects tagged lifecycle=temp under uploads/, and these are
            // dev-managed library assets that must never be swept.
          }),
        );
        uploaded++;
        bytes += t.body.length;
        if (uploaded % 100 === 0) console.log(`  ${uploaded}/${todo.length} uploaded`);
      } catch (e) {
        failures.push({ key: t.key, error: e.message.split('\n')[0] });
        console.error(`  FAIL ${t.key}: ${e.message.split('\n')[0]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  let deleted = 0;
  for (let i = 0; i < stale.length; i += 1000) {
    const chunk = stale.slice(i, i + 1000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: chunk.map((Key) => ({ Key })) },
      }),
    );
    deleted += chunk.length;
  }

  // Only invalidate when something actually moved — an invalidation on a no-op
  // sync is pure waste against the monthly path allowance.
  let invalidation = null;
  if (!NO_INVALIDATE && DISTRIBUTION && (uploaded || deleted)) {
    const res = JSON.parse(
      aws(
        'cloudfront', 'create-invalidation',
        '--distribution-id', DISTRIBUTION,
        '--paths', `/${PREFIX}*`,
      ),
    );
    invalidation = res.Invalidation.Id;
  }

  console.log('\n=== Summary ===');
  console.log(`Uploaded:     ${uploaded}  (${(bytes / 1048576).toFixed(1)} MB)`);
  console.log(`Unchanged:    ${unchanged}`);
  if (PRUNE) console.log(`Deleted:      ${deleted}`);
  console.log(`Failed:       ${failures.length}`);
  console.log(`Invalidation: ${invalidation || '(none)'}`);
  if (failures.length) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
