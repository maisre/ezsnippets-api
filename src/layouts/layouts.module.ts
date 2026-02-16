import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LayoutsController } from './layouts.controller';
import { LayoutsService } from './layouts.service';
import { layoutProviders } from './layouts.provider';
import { OpenaiModule } from '../openai';
import { SnippetsModule } from '../snippets/snippets.module';

@Module({
  imports: [DatabaseModule, OpenaiModule.forRootAsync(), SnippetsModule],
  controllers: [LayoutsController],
  providers: [LayoutsService, ...layoutProviders],
  exports: [LayoutsService],
})
export class LayoutsModule {}

