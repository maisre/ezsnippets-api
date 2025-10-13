import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PagesService } from './pages.service';
import { Page } from './interfaces/page.interface';
import { SnippetsService } from '../snippets/snippets.service';

@Controller('pages')
export class PagesController {
  constructor(
    private readonly pagesService: PagesService,
    private readonly snippetsService: SnippetsService,
  ) {}

  @Get()
  async findAll(): Promise<Page[]> {
    return this.pagesService.findAll();
  }

  @Get('view/:id')
  async viewPage(@Param('id') id: string, @Res() res: Response) {
    const page = await this.pagesService.findOne(id);

    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }

    const snippetPromises = page.snippets.map((snippetAbstract) =>
      this.snippetsService.findOne(String(snippetAbstract.id)),
    );

    const snippets = await Promise.all(snippetPromises);
    const validSnippets = snippets.filter((snippet) => snippet !== null);

    const concatenatedHtml = validSnippets
      .map((snippet) => snippet.html || '')
      .join('\n');
    const concatenatedCss = validSnippets
      .map((snippet) => snippet.css || '')
      .join('\n');
    const concatenatedJs = validSnippets
      .map((snippet) => snippet.js || '')
      .join('\n');

    const htmlTemplate = readFileSync(
      join(__dirname, '..', 'templates', 'html-template.txt'),
      'utf8',
    );

    const html = htmlTemplate
      .replace('{{ SNIPPET_HTML }}', concatenatedHtml)
      .replace('{{ SNIPPET_CSS }}', concatenatedCss)
      .replace('{{ SNIPPET_JS }}', concatenatedJs);

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}
