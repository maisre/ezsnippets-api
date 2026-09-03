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
        .select('_id type tags')
        .limit(200)
        .exec();
    }
    return this.snippetModel
      .find({ $or: [{ org: { $exists: false } }, { org: null }] })
      .select('_id type tags')
      .limit(200)
      .exec();
  }

  async getFilters(orgId?: string): Promise<{ types: string[]; tags: string[] }> {
    const filter = orgId
      ? { $or: [{ org: { $exists: false } }, { org: null }, { org: orgId }] }
      : { $or: [{ org: { $exists: false } }, { org: null }] };

    const [types, tags] = await Promise.all([
      this.snippetModel.distinct('type', filter).exec(),
      this.snippetModel.distinct('tags', filter).exec(),
    ]);

    return {
      types: types.filter(Boolean).map(String).sort(),
      tags: tags.filter(Boolean).map(String).sort(),
    };
  }

  /**
   * Which of the given ids exist and are visible to the org.
   *
   * One query rather than N lookups, because templates validate every snippet
   * id they reference on save. Invalid ObjectIds are dropped before the query
   * instead of throwing — a bad id is simply "doesn't exist" to the caller.
   */
  async findExistingIds(ids: string[], orgId?: string): Promise<Set<string>> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return new Set();

    const visible = orgId
      ? [{ org: { $exists: false } }, { org: null }, { org: orgId }]
      : [{ org: { $exists: false } }, { org: null }];

    const found = await this.snippetModel
      .find({ _id: { $in: valid }, $or: visible })
      .select('_id')
      .exec();

    return new Set(found.map((doc) => String(doc._id)));
  }

  async findOne(id: string): Promise<Snippet | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    return this.snippetModel.findById(id).exec();
  }
}
