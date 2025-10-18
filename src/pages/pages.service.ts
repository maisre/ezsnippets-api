import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Page } from './interfaces/page.interface';
import { CreatePageDto } from './dto/create-page.dto';

@Injectable()
export class PagesService {
  constructor(@Inject('PAGES_MODEL') private readonly pageModel: Model<Page>) {}

  async findAll(): Promise<Page[]> {
    return this.pageModel.find().exec();
  }

  async findOne(id: string, userId: string): Promise<Page | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(userId)) {
      return null;
    }
    return this.pageModel.findOne({ _id: id, owner: userId }).exec();
  }

  async findForOwner(ownerId: string): Promise<Page[]> {
    if (!Types.ObjectId.isValid(ownerId)) {
      return [];
    }
    return this.pageModel.find({ owner: ownerId }).exec();
  }

  async create(createPageDto: CreatePageDto, ownerId: string): Promise<Page> {
    const pageData = {
      name: createPageDto.name,
      projectId: createPageDto.projectId
        ? new Types.ObjectId(createPageDto.projectId)
        : undefined,
      owner: new Types.ObjectId(ownerId),
      snippets: createPageDto.snippets || [],
    };

    const createdPage = new this.pageModel(pageData);
    return createdPage.save();
  }
}
