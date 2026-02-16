import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { PagesController } from './pages.controller';
import { PagesService } from './pages.service';
import { pageProviders } from './pages.provider';
import { SnippetsModule } from '../snippets/snippets.module';
import { OpenaiModule } from '../openai';

@Module({
  imports: [DatabaseModule, SnippetsModule, OpenaiModule.forRootAsync()],
  controllers: [PagesController],
  providers: [PagesService, ...pageProviders],
  exports: [PagesService],
})
export class PagesModule {}
