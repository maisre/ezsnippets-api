import { Controller, Get } from '@nestjs/common';
import { PagesService } from './pages.service';
import { Page } from './interfaces/page.interface';

@Controller('pages')
export class PagesController {
  constructor(private readonly pagesService: PagesService) {}

  @Get()
  async findAll(): Promise<Page[]> {
    return this.pagesService.findAll();
  }
}
