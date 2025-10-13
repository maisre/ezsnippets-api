import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Page } from './interfaces/page.interface';

@Injectable()
export class PagesService {
  constructor(@Inject('PAGES_MODEL') private readonly pageModel: Model<Page>) {}

  async findAll(): Promise<Page[]> {
    return this.pageModel.find().exec();
  }

  async findOne(id: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.pageModel.findById(id).exec();
  }
}
