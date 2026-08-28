import { Controller, Get, Param, Query } from '@nestjs/common';
import { SnippetsService } from './snippets.service';
import { Snippet } from './interfaces/snippet.interface';

@Controller('snippets')
export class SnippetsController {
  constructor(private readonly snippetsService: SnippetsService) {}

  @Get()
  async findAll(@Query('orgId') orgId?: string): Promise<Snippet[]> {
    return this.snippetsService.findAll(orgId);
  }

  @Get('summary')
  async allSummary(@Query('orgId') orgId?: string): Promise<Snippet[]> {
    return this.snippetsService.findAllSummary(orgId);
  }

  @Get('filters')
  async getFilters(@Query('orgId') orgId?: string) {
    return this.snippetsService.getFilters(orgId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Snippet | null> {
    console.log('got here', id);
    return this.snippetsService.findOne(id);
  }
}
