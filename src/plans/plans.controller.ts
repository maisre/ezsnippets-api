import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { PlansService } from './plans.service';
import { PaddleCatalogService } from './paddle-catalog.service';
import { hasActiveSubscription } from './subscription-status';
import { OrgsService } from '../orgs/orgs.service';
import { PagesService } from '../pages/pages.service';
import { LayoutsService } from '../layouts/layouts.service';
import { DomainsService } from '../domains/domains.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';

@Controller('plans')
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly catalogService: PaddleCatalogService,
    private readonly orgsService: OrgsService,
    private readonly pagesService: PagesService,
    private readonly layoutsService: LayoutsService,
    private readonly domainsService: DomainsService,
  ) {}

  /**
   * The pricing page. Prices, trials, and which plans are on sale all come
   * from Paddle; limits and copy come from our catalog. `source` tells the
   * client whether it's looking at live data, a cached read, or nothing —
   * an empty list with source `unavailable` must not render as "no plans".
   */
  @Get()
  async findAll() {
    return this.catalogService.getCatalog();
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage')
  async getUsage(@Request() req) {
    const orgId = req.user.activeOrg;
    const org = await this.orgsService.findOne(orgId);

    // Mirrors what enforceLimit actually allows — a lapsed subscription reads
    // as "no plan" here so the dashboard doesn't advertise limits the API will
    // refuse to honour.
    // paddleCustomerId is returned either way: it identifies who the customer
    // is, not what they're entitled to. Paddle.js needs it as `pwCustomer` for
    // Retain, and a lapsed customer is exactly who Retain wants to win back.
    const paddleCustomerId = org?.paddleCustomerId ?? null;

    if (!hasActiveSubscription(org)) {
      return {
        hasPlan: false,
        plan: null,
        limits: null,
        usage: null,
        paddleCustomerId,
      };
    }

    const [pageCount, layoutCount, domainCount] = await Promise.all([
      this.pagesService.countForOrg(orgId),
      this.layoutsService.countForOrg(orgId),
      this.domainsService.countForOrg(orgId),
    ]);

    return {
      hasPlan: true,
      plan: this.plansService.planName(org.productId),
      limits: this.plansService.getLimits(org.productId),
      usage: {
        pages: pageCount,
        layouts: layoutCount,
        domains: domainCount,
      },
      paddleCustomerId,
    };
  }
}
