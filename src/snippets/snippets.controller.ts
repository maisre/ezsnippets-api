import { Controller, Get, Param, Query, Res, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fill } from '../common/fill-template';
import { applyScope } from '../common/apply-scope';
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

  @Get('view/:id')
  async viewSnippet(@Param('id') id: string, @Res() res: Response) {
    console.log('trying to view', id);
    const snippet = await this.snippetsService.findOne(id);

    if (!snippet) {
      throw new NotFoundException(`Snippet with id ${id} not found`);
    }

    const htmlTemplate = readFileSync(
      join(__dirname, '..', 'templates', 'html-template.txt'),
      'utf8',
    );

    // A lone snippet still needs its scope tokens resolved. Without this the
    // preview shipped `{{SNIPPET_SCOPE}}` literally, so every scoped CSS rule
    // matched nothing, and `{{SNIPPET_SCOPE_JS}}` is not even valid JS.
    let html = fill(
      htmlTemplate,
      '{{ SNIPPET_HTML }}',
      applyScope(snippet.html, 0),
    );
    html = fill(html, '{{ SNIPPET_CSS }}', applyScope(snippet.css, 0));
    html = fill(html, '{{ SNIPPET_JS }}', applyScope(snippet.js, 0));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}
