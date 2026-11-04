import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SnippetsService } from './snippets.service';
import { Snippet } from './interfaces/snippet.interface';

/**
 * Public and unauthenticated, so it serves the shared library only.
 *
 * There used to be a `GET /snippets` returning every full snippet document
 * (~20MB of hydrated docs per call; a few in parallel could exhaust the API
 * container's memory) and an `?orgId=` parameter that returned any org's
 * private snippets to anyone. Neither had a caller — the editor uses
 * /summary, and full bodies are rendered by ez-view — so both are gone.
 */
@Controller('snippets')
export class SnippetsController {
  constructor(private readonly snippetsService: SnippetsService) {}

  @Get('summary')
  async allSummary(): Promise<Snippet[]> {
    return this.snippetsService.findAllSummary();
  }

  @Get('filters')
  async getFilters() {
    return this.snippetsService.getFilters();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Snippet> {
    const snippet = await this.snippetsService.findOne(id);
    // Org-owned snippets are private to their org; this route has no caller
    // identity to check against.
    if (!snippet || (snippet as any).org) {
      throw new NotFoundException(`Snippet ${id} not found`);
    }
    return snippet;
  }
}
