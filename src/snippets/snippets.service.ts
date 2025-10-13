import { Inject, Injectable } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Snippet } from './interfaces/snippet.interface';

@Injectable()
export class SnippetsService {
  constructor(
    @Inject('SNIPPETS_MODEL') private readonly snippetModel: Model<Snippet>,
  ) {}

  async findAll(): Promise<Snippet[]> {
    return this.snippetModel.find().exec();
  }

  async findOne(id: string): Promise<Snippet | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.snippetModel.findById(id).exec();
  }
}
