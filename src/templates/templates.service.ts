import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Template, TemplateKind } from './interfaces/template.interface';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { SnippetsService } from '../snippets/snippets.service';
import { OrgsService } from '../orgs/orgs.service';
import { PlansService } from '../plans/plans.service';
import { hasActiveSubscription } from '../plans/subscription-status';

/** Library templates (no org) plus the org's own. Mirrors SnippetsService. */
function visibleTo(orgId?: string) {
  const shared = [{ org: { $exists: false } }, { org: null }];
  return orgId ? [...shared, { org: orgId }] : shared;
}

@Injectable()
export class TemplatesService {
  constructor(
    @Inject('TEMPLATES_MODEL')
    private readonly templateModel: Model<Template>,
    private readonly snippetsService: SnippetsService,
    private readonly orgsService: OrgsService,
    @Inject(forwardRef(() => PlansService))
    private readonly plansService: PlansService,
  ) {}

  async findAll(orgId?: string, kind?: TemplateKind): Promise<Template[]> {
    const filter: any = { deletedAt: null, $or: visibleTo(orgId) };
    if (kind) filter.kind = kind;
    return this.templateModel.find(filter).sort({ name: 1 }).exec();
  }

  async getFilters(
    orgId?: string,
  ): Promise<{ types: string[]; tags: string[] }> {
    const filter = { deletedAt: null, $or: visibleTo(orgId) };
    const [types, tags] = await Promise.all([
      this.templateModel.distinct('type', filter).exec(),
      this.templateModel.distinct('tags', filter).exec(),
    ]);
    return {
      types: types.filter(Boolean).map(String).sort(),
      tags: tags.filter(Boolean).map(String).sort(),
    };
  }

  /** A template the org may use: a library one, or one it saved. */
  async findOne(id: string, orgId?: string): Promise<Template | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.templateModel
      .findOne({ _id: id, deletedAt: null, $or: visibleTo(orgId) })
      .exec();
  }

  /** Saved templates count toward the plan; library ones are not the org's. */
  async countForOrg(orgId: string): Promise<number> {
    if (!Types.ObjectId.isValid(orgId)) return 0;
    return this.templateModel
      .countDocuments({ org: orgId, deletedAt: null })
      .exec();
  }

  async create(
    dto: CreateTemplateDto,
    orgId: string,
    userId: string,
  ): Promise<Template> {
    const isMember = await this.orgsService.isUserMember(orgId, userId);
    if (!isMember) {
      throw new ForbiddenException('You do not belong to this organization.');
    }

    const kind = dto.kind;
    if (!['partial', 'page', 'layout'].includes(kind)) {
      throw new BadRequestException(
        "kind must be one of 'partial', 'page', 'layout'.",
      );
    }
    if (!dto.name?.trim()) {
      throw new BadRequestException('A template needs a name.');
    }

    await this.enforceLimit(orgId);

    // Normalise to just the ids. Anything else a client sends — overrides,
    // customized text, stock image picks — is dropped here rather than
    // filtered later: a template is a blank arrangement by definition, and
    // this is the only place that invariant can be enforced.
    const doc =
      kind === 'layout'
        ? {
            nav: dto.nav || undefined,
            footer: dto.footer || undefined,
            subPages: (dto.subPages ?? []).map((sp) => ({
              name: sp.name,
              snippetIds: sp.snippetIds ?? [],
            })),
            snippetIds: [],
          }
        : {
            snippetIds: dto.snippetIds ?? [],
            subPages: [],
          };

    const referenced = this.snippetIdsOf({ ...doc, kind } as any);
    if (!referenced.length) {
      throw new BadRequestException(
        'A template needs at least one snippet. Add snippets before saving.',
      );
    }
    await this.assertSnippetsExist(referenced, orgId);

    const created = new this.templateModel({
      ...doc,
      name: dto.name.trim(),
      description: dto.description?.trim() || undefined,
      kind,
      type: dto.type?.trim() || undefined,
      tags: dto.tags ?? [],
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    });

    return created.save();
  }

  async update(
    id: string,
    orgId: string,
    dto: UpdateTemplateDto,
  ): Promise<Template> {
    const owned = await this.findOwned(id, orgId);

    const update: any = {};
    if (dto.name !== undefined) {
      if (!dto.name.trim()) {
        throw new BadRequestException('A template needs a name.');
      }
      update.name = dto.name.trim();
    }
    if (dto.description !== undefined) {
      update.description = dto.description.trim() || undefined;
    }
    if (dto.type !== undefined) update.type = dto.type.trim() || undefined;
    if (dto.tags !== undefined) update.tags = dto.tags;

    const updated = await this.templateModel
      .findOneAndUpdate({ _id: owned._id }, { $set: update }, { new: true })
      .exec();

    if (!updated) throw new NotFoundException(`Template ${id} not found`);
    return updated;
  }

  /** Soft delete, and only ever the org's own — library templates are ours. */
  async remove(id: string, orgId: string): Promise<void> {
    const owned = await this.findOwned(id, orgId);
    await this.templateModel
      .updateOne({ _id: owned._id }, { $set: { deletedAt: new Date() } })
      .exec();
  }

  /**
   * Every snippet id a template references, in no particular order. Used for
   * validation on save and for building preview stacks in the UI.
   */
  snippetIdsOf(template: {
    kind: TemplateKind;
    snippetIds?: string[];
    nav?: string;
    footer?: string;
    subPages?: Array<{ snippetIds?: string[] }>;
  }): string[] {
    if (template.kind !== 'layout') return [...(template.snippetIds ?? [])];

    const ids: string[] = [];
    if (template.nav) ids.push(template.nav);
    if (template.footer) ids.push(template.footer);
    for (const sp of template.subPages ?? []) {
      ids.push(...(sp.snippetIds ?? []));
    }
    return ids;
  }

  private async findOwned(id: string, orgId: string): Promise<Template> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Template ${id} not found`);
    }
    const template = await this.templateModel
      .findOne({ _id: id, org: orgId, deletedAt: null })
      .exec();

    if (!template) {
      // Deliberately the same error whether it doesn't exist or belongs to
      // someone else: a library template is visible but not editable, and
      // saying "you can't edit that" would leak which ids are real.
      throw new NotFoundException(`Template ${id} not found`);
    }
    return template;
  }

  /**
   * Refuse to save a template pointing at snippets that don't exist or the org
   * can't see. A dangling id renders as a hole in every page built from it,
   * and it would be found by the user rather than by us.
   */
  private async assertSnippetsExist(
    ids: string[],
    orgId: string,
  ): Promise<void> {
    const unique = [...new Set(ids)];
    const found = await this.snippetsService.findExistingIds(unique, orgId);
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) {
      throw new BadRequestException(
        `Unknown snippet${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }
  }

  private async enforceLimit(orgId: string): Promise<void> {
    const org = await this.orgsService.findOne(orgId);
    if (!hasActiveSubscription(org)) {
      throw new ForbiddenException(
        'No active plan. Subscribe to a plan to save templates.',
      );
    }

    const { maxSavedTemplates } = this.plansService.getLimits(org.productId);
    if (maxSavedTemplates === -1) return; // Unlimited

    if (maxSavedTemplates === 0) {
      throw new ForbiddenException(
        'Saving your own templates is a Pro feature. Upgrade your plan to save this arrangement.',
      );
    }

    const current = await this.countForOrg(orgId);
    if (current >= maxSavedTemplates) {
      throw new ForbiddenException(
        `Saved template limit reached (${maxSavedTemplates}). Upgrade your plan or delete one to save more.`,
      );
    }
  }
}
