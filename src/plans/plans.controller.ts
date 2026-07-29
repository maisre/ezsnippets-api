import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { PlansService } from './plans.service';
import { hasActiveSubscription } from './subscription-status';
import { OrgsService } from '../orgs/orgs.service';
import { PagesService } from '../pages/pages.service';
import { LayoutsService } from '../layouts/layouts.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';

@Controller('plans')
export class PlansController {
  constructor(
    private readonly plansService: PlansService,
    private readonly orgsService: OrgsService,
    private readonly pagesService: PagesService,
    private readonly layoutsService: LayoutsService,
  ) {}

  @Get()
  async findAll() {
    return this.plansService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage')
  async getUsage(@Request() req) {
    const orgId = req.user.activeOrg;
    const org = await this.orgsService.findOne(orgId);

    // Mirrors what enforceLimit actually allows — a lapsed subscription reads
    // as "no plan" here so the dashboard doesn't advertise limits the API will
    // refuse to honour.
    if (!hasActiveSubscription(org)) {
      return {
        hasPlan: false,
        plan: null,
        limits: null,
        usage: null,
      };
    }

    const [plan, pageCount, layoutCount] = await Promise.all([
      this.plansService.findByPriceId(org.plan),
      this.pagesService.countForOrg(orgId),
      this.layoutsService.countForOrg(orgId),
    ]);

    const limits = await this.plansService.getLimitsForPriceId(org.plan);

    return {
      hasPlan: true,
      plan: plan?.name || null,
      limits,
      usage: {
        pages: pageCount,
        layouts: layoutCount,
      },
    };
  }
}
