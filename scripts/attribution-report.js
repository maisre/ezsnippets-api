#!/usr/bin/env node
/**
 * Signups → built something → paying, per traffic source.
 *
 * Reads `user.acquisition` (saved at signup from the visitor's first UTM-tagged
 * visit + the "How did you hear about us?" answer, see src/auth/acquisition.ts)
 * and joins each user to their pages/layouts and to the orgs they own. This is
 * the number to judge a sponsorship by: Plausible shows visits and signups per
 * source, but only this follows a user to a payment weeks later, and it can't
 * be blocked.
 *
 *   node scripts/attribution-report.js                  # by source
 *   node scripts/attribution-report.js --by campaign    # by source / campaign
 *   node scripts/attribution-report.js --since 2026-11-01
 *
 * Against prod (read-only):
 *
 *   DATABASE_URL="$(aws ssm get-parameter --profile ez --region us-east-1 \
 *     --name /ez/prod/DATABASE_URL --with-decryption \
 *     --query Parameter.Value --output text)" \
 *     node scripts/attribution-report.js
 *
 * Source = utm_source, else ?ref=, else the referring site, else what they
 * said on the signup form, else "direct / unknown". Users who signed up before
 * attribution existed are counted as "(before tracking)".
 */
const mongoose = require('mongoose');
require('dotenv').config({ quiet: true });

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const by = flag('--by') || 'source';
const since = flag('--since');

if (!['source', 'campaign'].includes(by)) {
  console.error('--by must be "source" or "campaign"');
  process.exit(1);
}

// Mirrors src/plans/subscription-status.ts. A plan with no status is a comped
// account, not a customer, so it doesn't count as paying here.
const PAYING = new Set(['active', 'past_due']);

function sourceOf(a) {
  if (!a) return '(before tracking)';
  if (a.utmSource) return a.utmSource;
  if (a.ref) return a.ref;
  if (a.referrer) {
    try {
      return new URL(a.referrer).hostname.replace(/^www\./, '');
    } catch {
      /* fall through */
    }
  }
  if (a.heardAbout) return `said: ${a.heardAbout}`;
  return 'direct / unknown';
}

function keyOf(a) {
  const source = sourceOf(a);
  return by === 'campaign' ? `${source} / ${a?.utmCampaign || '-'}` : source;
}

function pct(n, d) {
  return d ? `${Math.round((n / d) * 100)}%` : '-';
}

function printTable(title, rows, cols) {
  console.log(`\n${title}`);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c]).length)),
  );
  const line = (cells) =>
    cells.map((v, i) => (i === 0 ? String(v).padEnd(widths[i]) : String(v).padStart(widths[i]))).join('  ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(cols.map((c) => r[c]))));
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  await mongoose.connect(process.env.DATABASE_URL);
  const db = mongoose.connection.db;

  const userFilter = {};
  if (since) {
    const t = new Date(since);
    if (isNaN(t.getTime())) throw new Error(`Bad --since date: ${since}`);
    userFilter._id = { $gte: mongoose.Types.ObjectId.createFromTime(t.getTime() / 1000) };
  }
  const users = await db
    .collection('users')
    .find(userFilter, { projection: { acquisition: 1 } })
    .toArray();
  const ids = users.map((u) => u._id);

  const builders = new Set();
  for (const coll of ['pages', 'layouts']) {
    const creators = await db.collection(coll).distinct('createdBy', { createdBy: { $in: ids } });
    creators.forEach((id) => builders.add(String(id)));
  }

  const payingOwners = new Set();
  const trialingOwners = new Set();
  const orgs = await db
    .collection('orgs')
    .find(
      { members: { $elemMatch: { user: { $in: ids }, role: 'owner' } }, subscriptionStatus: { $exists: true } },
      { projection: { members: 1, subscriptionStatus: 1, billingBlocked: 1 } },
    )
    .toArray();
  for (const org of orgs) {
    const owner = org.members.find((m) => m.role === 'owner');
    if (!owner) continue;
    if (PAYING.has(org.subscriptionStatus) && !org.billingBlocked) payingOwners.add(String(owner.user));
    else if (org.subscriptionStatus === 'trialing') trialingOwners.add(String(owner.user));
  }

  const groups = new Map();
  const heard = new Map();
  for (const u of users) {
    const id = String(u._id);
    const key = keyOf(u.acquisition);
    const g = groups.get(key) || { source: key, signups: 0, built: 0, trialing: 0, paying: 0 };
    g.signups++;
    if (builders.has(id)) g.built++;
    if (trialingOwners.has(id)) g.trialing++;
    if (payingOwners.has(id)) g.paying++;
    groups.set(key, g);

    const h = u.acquisition?.heardAbout;
    if (h) {
      const label = u.acquisition.heardAboutDetail ? `${h}: ${u.acquisition.heardAboutDetail}` : h;
      heard.set(label, (heard.get(label) || 0) + 1);
    }
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.signups - a.signups)
    .map((g) => ({
      ...g,
      'built %': pct(g.built, g.signups),
      'paying %': pct(g.paying, g.signups),
    }));

  console.log(`${users.length} users${since ? ` since ${since}` : ''}`);
  printTable(
    by === 'campaign' ? 'By source / campaign' : 'By source',
    rows,
    ['source', 'signups', 'built', 'built %', 'trialing', 'paying', 'paying %'],
  );
  if (heard.size) {
    printTable(
      '"How did you hear about us?"',
      [...heard.entries()].sort((a, b) => b[1] - a[1]).map(([answer, n]) => ({ answer, signups: n })),
      ['answer', 'signups'],
    );
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
