import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { DomainsService } from './domains.service';
import { CreateDomainDto } from './dto/create-domain.dto';
import type { CustomDomain } from './interfaces/custom-domain.interface';
import { JwtAuthGuard } from '../auth/jwt.strategy';

/**
 * Custom domains are org-scoped: every route reads and writes only the active
 * org's domains, so one customer can never see or touch another's.
 */
@UseGuards(JwtAuthGuard)
@Controller('domains')
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Get()
  async findAll(@Request() req): Promise<CustomDomain[]> {
    return this.domainsService.findAllForOrg(req.user.activeOrg);
  }

  /**
   * The hostname customers point their CNAME at, so the setup instructions in
   * the UI stay correct if the edge ever moves instead of being hardcoded into
   * the frontend bundle.
   */
  @Get('target')
  target(): { target: string } {
    return { target: this.domainsService.target };
  }

  @Post()
  async create(
    @Body() dto: CreateDomainDto,
    @Request() req,
  ): Promise<CustomDomain> {
    return this.domainsService.create(
      dto.hostname,
      req.user.activeOrg,
      req.user.userId,
    );
  }

  /** "Check now" — re-runs the DNS lookup without waiting for the cron. */
  @Post(':id/verify')
  async verify(
    @Param('id') id: string,
    @Request() req,
  ): Promise<CustomDomain> {
    return this.domainsService.verify(id, req.user.activeOrg);
  }

  /**
   * One-call answer to "why isn't my domain working" — stored state, a live
   * DNS lookup, entitlement, and whether TLS would be issued right now.
   * Org-scoped like everything else here, so it is safe to point a customer at.
   */
  @Get(':id/diagnose')
  async diagnose(@Param('id') id: string, @Request() req) {
    return this.domainsService.diagnose(id, req.user.activeOrg);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    return this.domainsService.remove(id, req.user.activeOrg);
  }
}
