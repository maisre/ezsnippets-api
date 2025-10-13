import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SnippetsController } from './snippets.controller';
import { SnippetsService } from './snippets.service';
import { snippetProviders } from './snippets.provider';

@Module({
  imports: [DatabaseModule],
  controllers: [SnippetsController],
  providers: [SnippetsService, ...snippetProviders],
  exports: [SnippetsService],
})
export class SnippetsModule {}
