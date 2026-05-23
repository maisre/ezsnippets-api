import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Model } from 'mongoose';
import { Plan, PlanLimits } from './interfaces/plan.interface';

const DEFAULT_PLANS = [
  {
    name: 'Basic',
    priceIds: [
      'pri_01kr05y9cq25yt75ey1ddkpger',
      'pri_01kr07scygf6jf4a2xbvra76y6',
    ],
    limits: { maxPages: 3, maxLayouts: 1, maxSnippets: 50 },
  },
  {
    name: 'Pro',
    priceIds: [
      'pri_01kr07vbve5a770reznmza9hdq',
      'pri_01kr07vyv692rrj6gn8m57e683',
    ],
    limits: { maxPages: 25, maxLayouts: 10, maxSnippets: 500 },
  },
  {
    name: 'Enterprise',
    priceIds: [
      'pri_01kr07xbjrdw0jztyfta1xfqre',
      'pri_01kr07xy7sty2xhwcqjgzny8x4',
    ],
    limits: { maxPages: -1, maxLayouts: -1, maxSnippets: -1 },
  },
];

@Injectable()
export class PlansService implements OnModuleInit {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @Inject('PLAN_MODEL') private readonly planModel: Model<Plan>,
    @Inject('PLAN_LIMITS_OVERRIDE')
    private readonly limitsOverride: string | undefined,
  ) {}

  async onModuleInit() {
    await this.seed();
  }

  async seed() {
    const count = await this.planModel.countDocuments().exec();
    if (count > 0) return;

    await this.planModel.insertMany(DEFAULT_PLANS);
    this.logger.log('Seeded default plan configurations');
  }

  async findAll(): Promise<Plan[]> {
    return this.planModel.find().exec();
  }

  async findByPriceId(priceId: string): Promise<Plan | null> {
    return this.planModel.findOne({ priceIds: priceId }).exec();
  }

  async getLimitsForPriceId(priceId: string): Promise<PlanLimits | null> {
    // Check env override first (format: "maxPages,maxLayouts,maxSnippets")
    if (this.limitsOverride) {
      const parts = this.limitsOverride.split(',').map(Number);
      if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
        return {
          maxPages: parts[0],
          maxLayouts: parts[1],
          maxSnippets: parts[2],
        };
      }
    }

    const plan = await this.findByPriceId(priceId);
    return plan?.limits || null;
  }
}
