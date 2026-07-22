import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  HttpCode,
  Param,
  Res,
  NotFoundException,
  Request,
  UseGuards,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PagesService } from './pages.service';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { CustomizeImagesDto } from './dto/customize-images.dto';
import { CustomizeDto } from './dto/customize.dto';
import { SnippetsService } from '../snippets/snippets.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';

@Controller('pages')
export class PagesController {
  constructor(
    private readonly pagesService: PagesService,
    private readonly snippetsService: SnippetsService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Request() req): Promise<Page[]> {
    return this.pagesService.findForOrg(req.user.activeOrg);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Request() req): Promise<Page> {
    const page = await this.pagesService.findOne(id, req.user.activeOrg);
    if (!page) {
      throw new NotFoundException(`Page with id ${id} not found`);
    }
    return page;
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async create(
    @Body() createPageDto: CreatePageDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.create(createPageDto, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updatePageDto: UpdatePageDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.update(id, updatePageDto, req.user.activeOrg);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/duplicate')
  async duplicate(
    @Param('id') id: string,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.duplicate(id, req.user.activeOrg, req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize')
  async customize(
    @Param('id') id: string,
    @Body() dto: CustomizeDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.customize(id, req.user.activeOrg, {
      onlyMissing: dto?.onlyMissing,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/customize-images')
  async customizeImages(
    @Param('id') id: string,
    @Body() dto: CustomizeImagesDto,
    @Request() req,
  ): Promise<Page> {
    return this.pagesService.customizeImages(id, req.user.activeOrg, {
      direction: dto?.direction,
      replaceExisting: dto?.replaceExisting,
      onlyMissing: dto?.onlyMissing,
    });
  }

  // Shutterstock images the user must license before publishing the download.
  @UseGuards(JwtAuthGuard)
  @Get(':id/licensing')
  async getLicensing(@Param('id') id: string, @Request() req) {
    return this.pagesService.getLicensing(id, req.user.activeOrg);
  }

  // Download the page as a self-contained static-site zip.
  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Request() req,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.pagesService.exportZip(
      id,
      req.user.activeOrg,
    );
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    });
    res.end(buffer);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/archive')
  async archive(@Param('id') id: string, @Request() req): Promise<Page> {
    return this.pagesService.setArchived(id, req.user.activeOrg, true);
  }

  // May throw ForbiddenException if restoring would exceed the plan limit.
  @UseGuards(JwtAuthGuard)
  @Patch(':id/restore')
  async restore(@Param('id') id: string, @Request() req): Promise<Page> {
    return this.pagesService.setArchived(id, req.user.activeOrg, false);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Request() req): Promise<void> {
    return this.pagesService.remove(id, req.user.activeOrg);
  }

  @UseGuards(JwtAuthGuard)
  @Get('view/:id')
  async viewPage(
    @Param('id') id: string,
    @Request() req,
    @Res() res: Response,
  ) {
    const page = await this.pagesService.findOne(id, req.user.activeOrg);

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
