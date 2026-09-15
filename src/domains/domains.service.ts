import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Model } from 'mongoose';
import { promises as dns } from 'dns';
import { CustomDomain } from './interfaces/custom-domain.interface';
import { normalizeHostname, validateHostname } from './hostname-rules';
import { OrgsService } from '../orgs/orgs.service';
import { PlansService } from '../plans/plans.service';
import { hasActiveSubscription } from '../plans/subscription-status';

/**
 * How many consecutive failed checks flip a live domain to `failed`. A single
 * resolver hiccup must not take a paying customer's client-facing link down,
 * so an already-active domain keeps serving until the failures persist.
 */
export const FAILURE_THRESHOLD = 3;

/**
 * Why a hostname may or may not be served.
 *
 * The failure reasons are separate cases rather than a single null because
 * every one of them means something different to whoever is debugging:
 * `not-registered` is a typo or someone else's DNS pointed at us,
 * `not-verified` is a DNS record that is missing or wrong, and `not-entitled`
 * is a billing problem. Collapsing them makes "my domain doesn't work"
 * unanswerable without a database session.
 */
export type ServableReason =
  | 'no-hostname'
  | 'not-registered'
  | 'not-verified'
  | 'not-entitled';

export type ServableResult =
  | { ok: true; domain: CustomDomain; orgId: string }
  | {
      ok: false;
      reason: ServableReason;
      detail: string;
      domain?: CustomDomain;
    };

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    @Inject('CUSTOM_DOMAINS_MODEL')
    private readonly domainModel: Model<CustomDomain>,
    private readonly orgsService: OrgsService,
    @Inject(forwardRef(() => PlansService))
    private readonly plansService: PlansService,
  ) {}

  /**
   * The hostname customers point their CNAME at. Configurable so staging can
   * verify against its own edge rather than prod's.
   */
  get target(): string {
    return normalizeHostname(
      process.env.CUSTOM_DOMAIN_TARGET || 'view.ez-snippets.com',
    );
  }

  async findAllForOrg(orgId: string): Promise<CustomDomain[]> {
    return this.domainModel.find({ org: orgId }).sort({ createdAt: 1 }).exec();
  }

  async countForOrg(orgId: string): Promise<number> {
    return this.domainModel.countDocuments({ org: orgId }).exec();
  }

  async create(
    rawHostname: string,
    orgId: string,
    userId?: string,
  ): Promise<CustomDomain> {
    const check = validateHostname(rawHostname);
    if (!check.ok) {
      throw new BadRequestException(check.reason);
    }
    const hostname = normalizeHostname(rawHostname);

    await this.enforceLimit(orgId);

    // Claimed by anyone — including this org — is a conflict. The unique index
    // is the real guard against a race; this is just the friendly message.
    const existing = await this.domainModel.findOne({ hostname }).exec();
    if (existing) {
      throw new ConflictException(
        `${hostname} is already connected to an account.`,
      );
    }

    try {
      const created = await this.domainModel.create({
        org: orgId,
        hostname,
        createdBy: userId,
        status: 'pending',
      });
      // Check immediately: if they set the CNAME up before adding it here (a
      // common order), this goes straight to active and skips the waiting.
      return await this.verify(String(created.id), orgId);
    } catch (err: any) {
      if (err?.code === 11000) {
        throw new ConflictException(
          `${hostname} is already connected to an account.`,
        );
      }
      throw err;
    }
  }

  async remove(id: string, orgId: string): Promise<void> {
    const result = await this.domainModel
      .findOneAndDelete({ _id: id, org: orgId })
      .exec();
    if (!result) {
      throw new NotFoundException('Domain not found');
    }
  }

  /**
   * Resolve the hostname's CNAME chain and confirm it points at our edge.
   *
   * The CNAME *is* the proof of ownership: only someone who controls the zone
   * can create it, and it has to exist anyway for traffic to reach us. That's
   * why there's no separate TXT-token step — it would be a second thing for the
   * customer to get wrong without proving anything the CNAME doesn't.
   */
  async verify(id: string, orgId?: string): Promise<CustomDomain> {
    const filter: any = orgId ? { _id: id, org: orgId } : { _id: id };
    const domain = await this.domainModel.findOne(filter).exec();
    if (!domain) {
      throw new NotFoundException('Domain not found');
    }

    const outcome = await this.checkDns(domain.hostname);
    return this.applyCheck(domain, outcome);
  }

  /** Pure-ish DNS probe, separated so the cron and the API share one code path. */
  async checkDns(
    hostname: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const target = this.target;
    try {
      const records = await dns.resolveCname(hostname);
      const found = records.map((r) => normalizeHostname(r));
      if (found.includes(target)) {
        return { ok: true };
      }
      return {
        ok: false,
        error: `${hostname} points at ${found.join(', ') || 'nothing'} instead of ${target}.`,
      };
    } catch (err: any) {
      if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') {
        return {
          ok: false,
          error: `No CNAME record found for ${hostname} yet. DNS changes can take a while to propagate.`,
        };
      }
      this.logger.warn(`DNS check for ${hostname} failed: ${err?.code ?? err}`);
      return { ok: false, error: `Could not look up ${hostname}. Try again shortly.` };
    }
  }

  /**
   * Fold a check result into the stored record. Shared by the on-demand
   * "Check now" button and the background re-verification cron.
   */
  async applyCheck(
    domain: CustomDomain,
    outcome: { ok: boolean; error?: string },
  ): Promise<CustomDomain> {
    const now = new Date();
    const update: any = { lastCheckedAt: now };

    if (outcome.ok) {
      update.status = 'active';
      update.lastError = null;
      update.failureCount = 0;
      update.verifiedAt = now;
    } else {
      const failures = (domain.failureCount ?? 0) + 1;
      update.failureCount = failures;
      update.lastError = outcome.error;
      // `failed` means "we have tried enough times to say this is broken", not
      // "the last lookup missed". Below the threshold a live domain stays live
      // (one flaky resolver must not take a client-facing link down) and a new
      // one stays `pending` — a customer who has just added a domain and not
      // yet touched their DNS should read "Waiting for DNS", not a red error.
      // The specific lastError is shown either way, so nothing is hidden.
      if (failures < FAILURE_THRESHOLD) {
        update.status = domain.status === 'active' ? 'active' : 'pending';
      } else {
        update.status = 'failed';
      }
    }

    return (await this.domainModel
      .findByIdAndUpdate(domain.id, { $set: update }, { new: true })
      .exec()) as CustomDomain;
  }

  /** Every domain the re-verification sweep should look at. */
  async findCheckable(): Promise<CustomDomain[]> {
    return this.domainModel
      .find({ status: { $in: ['active', 'pending', 'failed'] } })
      .exec();
  }

  /**
   * Re-check every domain: entitlement first, then DNS.
   *
   * Driven by ez-background on a schedule, but the logic lives here because
   * ez-api owns the plan catalog and is the only writer of these documents —
   * ez-background would otherwise need its own copy of the tier table, which
   * would silently rot the first time a plan's limits changed.
   *
   * Entitlement is checked first and short-circuits: a Pro -> Starter downgrade
   * keeps the subscription active, so nothing else would notice that the org no
   * longer has custom domains. This sweep is what closes that window — ez-view
   * sees only the resulting `status`, not the plan.
   */
  async reverifyAll(): Promise<{
    checked: number;
    active: number;
    demoted: number;
    failed: number;
  }> {
    const domains = await this.findCheckable();
    const entitlementCache = new Map<string, boolean>();
    let active = 0;
    let demoted = 0;
    let failed = 0;

    for (const domain of domains) {
      const orgId = String(domain.org);
      if (!entitlementCache.has(orgId)) {
        entitlementCache.set(orgId, await this.isEntitled(orgId));
      }

      if (!entitlementCache.get(orgId)) {
        if (domain.status !== 'failed') {
          demoted += 1;
          this.logger.log(
            `Demoting ${domain.hostname}: org ${orgId} is no longer entitled to custom domains`,
          );
        }
        await this.domainModel
          .findByIdAndUpdate(domain.id, {
            $set: {
              status: 'failed',
              lastError:
                'Your current plan does not include custom domains. Upgrade to Pro or Agency to serve this domain again.',
              lastCheckedAt: new Date(),
            },
          })
          .exec();
        continue;
      }

      const updated = await this.applyCheck(
        domain,
        await this.checkDns(domain.hostname),
      );
      if (updated.status === 'active') active += 1;
      else failed += 1;
    }

    return { checked: domains.length, active, demoted, failed };
  }

  /**
   * The authority behind both the Caddy ask endpoint and ez-view's host gate:
   * a hostname only counts if it is verified AND the org still pays for it.
   *
   * Entitlement is re-checked here rather than cached on the domain document so
   * a downgrade, cancellation or failed payment stops serving immediately —
   * without a webhook having to remember to touch every domain row.
   */
  async resolveServable(hostname: string): Promise<ServableResult> {
    const host = normalizeHostname(hostname);
    if (!host) {
      return { ok: false, reason: 'no-hostname', detail: 'No domain supplied.' };
    }

    // Look the hostname up regardless of status, so the caller can tell
    // "never registered" apart from "registered but not verified yet". Those
    // two look identical from outside and need completely different answers.
    const domain = await this.domainModel.findOne({ hostname: host }).exec();
    if (!domain) {
      return {
        ok: false,
        reason: 'not-registered',
        detail: `${host} is not connected to any account.`,
      };
    }

    if (domain.status !== 'active') {
      return {
        ok: false,
        reason: 'not-verified',
        detail: `${host} is ${domain.status}: ${domain.lastError ?? 'DNS not confirmed yet'}`,
        domain,
      };
    }

    const orgId = String(domain.org);
    if (!(await this.isEntitled(orgId))) {
      return {
        ok: false,
        reason: 'not-entitled',
        detail: `org ${orgId} has no active plan that includes custom domains`,
        domain,
      };
    }

    return { ok: true, domain, orgId };
  }

  /**
   * Everything needed to answer "why isn't my domain working?" in one call.
   *
   * Deliberately one endpoint rather than a list of things to go and check:
   * diagnosing this otherwise means correlating the stored record, a live DNS
   * lookup, the org's plan and the TLS gate — four places, three of which need
   * a database session or a shell on the box. In production that is the
   * difference between a two-minute answer and an afternoon.
   *
   * Runs a *live* DNS lookup rather than reporting the last stored result, so
   * it reflects the customer's DNS as it is right now, not as of the last sweep.
   */
  async diagnose(id: string, orgId: string) {
    const domain = await this.domainModel
      .findOne({ _id: id, org: orgId })
      .exec();
    if (!domain) {
      throw new NotFoundException('Domain not found');
    }

    const [dns, entitled, servable] = await Promise.all([
      this.checkDns(domain.hostname),
      this.isEntitled(String(domain.org)),
      this.resolveServable(domain.hostname),
    ]);

    return {
      hostname: domain.hostname,
      // What we have stored.
      stored: {
        status: domain.status,
        lastError: domain.lastError,
        failureCount: domain.failureCount,
        verifiedAt: domain.verifiedAt,
        lastCheckedAt: domain.lastCheckedAt,
      },
      // What DNS says right now.
      dns: {
        expectedTarget: this.target,
        ok: dns.ok,
        error: dns.error ?? null,
      },
      // Whether the plan still covers it.
      entitlement: { entitled },
      // Whether Caddy would issue/renew a certificate for it at this moment.
      tls: {
        wouldIssue: servable.ok,
        reason: servable.ok ? null : servable.reason,
        detail: servable.ok ? null : servable.detail,
      },
    };
  }

  /** Does this org currently pay for custom domains at all? */
  async isEntitled(orgId: string): Promise<boolean> {
    const org = await this.orgsService.findOne(orgId);
    if (!hasActiveSubscription(org)) return false;
    return this.plansService.getLimits(org.productId).maxCustomDomains !== 0;
  }

  /**
   * Mirrors PagesService.enforceLimit — same subscription gate, same
   * unlimited sentinel, same upgrade-shaped message.
   */
  private async enforceLimit(orgId: string): Promise<void> {
    const org = await this.orgsService.findOne(orgId);
    if (!hasActiveSubscription(org)) {
      throw new ForbiddenException(
        'No active plan. Subscribe to a plan to connect a custom domain.',
      );
    }

    const limits = this.plansService.getLimits(org.productId);
    if (limits.maxCustomDomains === -1) return; // Unlimited
    if (limits.maxCustomDomains === 0) {
      throw new ForbiddenException(
        'Custom domains are available on the Pro and Agency plans. Upgrade to connect one.',
      );
    }

    const current = await this.countForOrg(orgId);
    if (current >= limits.maxCustomDomains) {
      throw new ForbiddenException(
        `Custom domain limit reached (${limits.maxCustomDomains}). Upgrade your plan to connect more.`,
      );
    }
  }
}
