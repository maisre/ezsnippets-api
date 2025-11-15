import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SnippetsService } from './snippets.service';
import { Snippet } from './interfaces/snippet.interface';

@Controller('snippets')
export class SnippetsController {
  constructor(private readonly snippetsService: SnippetsService) {}

  @Get()
  async findAll(): Promise<Snippet[]> {
    return this.snippetsService.findAll();
  }

  @Get('summary')
  async allSummary(): Promise<Snippet[]> {
    return this.snippetsService.findAllSummary();
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

    const html = htmlTemplate
      .replace('{{ SNIPPET_HTML }}', String(snippet.html || ''))
      .replace('{{ SNIPPET_CSS }}', String(snippet.css || ''))
      .replace('{{ SNIPPET_JS }}', String(snippet.js || ''));

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}
