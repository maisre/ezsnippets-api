import { Inject, Injectable } from '@nestjs/common';
import { Model } from 'mongoose';
import { Page } from './interfaces/page.interface';

@Injectable()
export class PagesService {
  constructor(@Inject('PAGES_MODEL') private readonly pageModel: Model<Page>) {}

  async findAll(): Promise<Page[]> {
    return this.pageModel.find().exec();
  }
}
