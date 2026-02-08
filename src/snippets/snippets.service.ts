import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Snippet } from './interfaces/snippet.interface';

@Injectable()
export class SnippetsService {
  constructor(
    @Inject('SNIPPETS_MODEL') private readonly snippetModel: Model<Snippet>,
  ) {}

  async findAll(orgId?: string): Promise<Snippet[]> {
    if (orgId) {
      return this.snippetModel
        .find({ $or: [{ org: { $exists: false } }, { org: null }, { org: orgId }] })
        .exec();
    }
    return this.snippetModel
      .find({ $or: [{ org: { $exists: false } }, { org: null }] })
      .exec();
  }

  async findAllSummary(orgId?: string): Promise<Snippet[]> {
    if (orgId) {
      return this.snippetModel
        .find({ $or: [{ org: { $exists: false } }, { org: null }, { org: orgId }] })
        .select('_id type')
        .limit(200)
        .exec();
    }
    return this.snippetModel
      .find({ $or: [{ org: { $exists: false } }, { org: null }] })
      .select('_id type')
      .limit(200)
      .exec();
  }

  async findOne(id: string): Promise<Snippet | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.snippetModel.findById(id).exec();
  }
}
