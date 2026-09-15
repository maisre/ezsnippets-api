import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { DomainsService } from './domains.service';

/**
 * Caddy's on-demand TLS "ask" endpoint.
 *
 * Caddy calls this before issuing a Let's Encrypt certificate for a hostname it
 * has never seen. 200 means "go ahead"; anything else means "refuse". That
 * makes this the gate standing between us and being a free certificate-minting
 * service for anybody who points a DNS record at our IP — which is how an
 * account gets rate-limited by Let's Encrypt.
 *
 * Two things therefore have to be true before it answers 200, both enforced in
 * DomainsService.resolveServable: the hostname is verified (status `active`),
 * and the owning org is still entitled to custom domains right now.
 *
 * Deliberately NOT behind JwtAuthGuard — Caddy has no token. It is protected by
 * a shared secret instead, because ez-api is publicly reachable at
 * api.ez-snippets.com, so without one this would be an open oracle for which
 * customer domains exist.
 */
@Controller('domains')
export class CaddyCheckController {
  private readonly logger = new Logger(CaddyCheckController.name);

  constructor(private readonly domainsService: DomainsService) {}

  @Get('caddy-check')
  async check(
    @Query('domain') domain: string,
    @Query('secret') querySecret?: string,
    @Headers('x-caddy-secret') headerSecret?: string,
  ): Promise<{ ok: true }> {
    this.assertSecret(querySecret || headerSecret);

    const resolved = await this.domainsService.resolveServable(domain || '');
    if (!resolved.ok) {
      // Caddy only looks at the status code, so this log line is the ONLY
      // record of why a certificate was refused. It names the reason because
      // "not registered", "DNS not confirmed" and "plan lapsed" need three
      // different replies to the customer asking why their domain is down.
      this.logger.warn(
        `TLS refused for ${domain || '(none)'} [${resolved.reason}]: ${resolved.detail}`,
      );
      throw new ForbiddenException();
    }

    this.logger.log(`TLS approved for ${resolved.domain.hostname}`);
    return { ok: true };
  }

  /**
   * Re-verify every domain — entitlement, then DNS. Triggered by
   * ez-background's cron rather than run there, so the plan catalog stays in
   * one place. Shares the ask endpoint's shared secret; it is a write, so it
   * must never be callable by the public internet.
   */
  @Post('reverify')
  async reverify(
    @Query('secret') querySecret?: string,
    @Headers('x-caddy-secret') headerSecret?: string,
  ) {
    this.assertSecret(querySecret || headerSecret);
    const result = await this.domainsService.reverifyAll();
    this.logger.log(
      `Re-verified ${result.checked} domains: ${result.active} active, ${result.demoted} demoted, ${result.failed} failing`,
    );
    return result;
  }

  /**
   * Fails closed: an unset CADDY_ASK_SECRET refuses everything rather than
   * silently leaving the endpoint open.
   */
  private assertSecret(provided?: string): void {
    const expected = process.env.CADDY_ASK_SECRET;
    if (!expected) {
      this.logger.error(
        'CADDY_ASK_SECRET is not set — refusing all on-demand TLS requests. ' +
          'Custom domains cannot get certificates until it is configured.',
      );
      throw new ForbiddenException();
    }
    if (!provided || !safeEqual(provided, expected)) {
      throw new ForbiddenException();
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
