import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { templateProviders } from './templates.provider';
import { SnippetsModule } from '../snippets/snippets.module';
import { OrgsModule } from '../orgs/orgs.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [
    DatabaseModule,
    SnippetsModule,
    OrgsModule,
    forwardRef(() => PlansModule),
  ],
  controllers: [TemplatesController],
  providers: [TemplatesService, ...templateProviders],
  exports: [TemplatesService],
})
export class TemplatesModule {}
