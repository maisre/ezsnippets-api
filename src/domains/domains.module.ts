import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DomainsController } from './domains.controller';
import { CaddyCheckController } from './caddy-check.controller';
import { DomainsService } from './domains.service';
import { customDomainProviders } from './domains.provider';
import { OrgsModule } from '../orgs/orgs.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [DatabaseModule, OrgsModule, forwardRef(() => PlansModule)],
  // CaddyCheckController is listed first so its fixed path is matched before
  // anything parameterised, and it stays outside DomainsController's
  // JwtAuthGuard — Caddy authenticates with a shared secret, not a token.
  controllers: [CaddyCheckController, DomainsController],
  providers: [DomainsService, ...customDomainProviders],
  exports: [DomainsService],
})
export class DomainsModule {}
