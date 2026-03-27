import { Module, forwardRef } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';
import { pageProviders } from './pages.provider';
import { SnippetsModule } from '../snippets/snippets.module';
import { OpenaiModule } from '../openai';
import { OrgsModule } from '../orgs/orgs.module';
import { PlansModule } from '../plans/plans.module';

@Module({
  imports: [DatabaseModule, SnippetsModule, OpenaiModule.forRootAsync(), OrgsModule, forwardRef(() => PlansModule)],
  controllers: [PagesController],
  providers: [PagesService, ...pageProviders],
  exports: [PagesService],
})
export class PagesModule {}
