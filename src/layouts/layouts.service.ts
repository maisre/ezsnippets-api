import {
  Inject,
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { OpenaiService } from '../openai';
import { SnippetsService } from '../snippets/snippets.service';
import { OrgsService } from '../orgs/orgs.service';
import { PlansService } from '../plans/plans.service';
import { ShutterstockService } from '../shutterstock';
import { targetAspectFor, slotShapeFor } from '../shutterstock/target-dimensions';

@Injectable()
export class LayoutsService {
  private readonly logger = new Logger(LayoutsService.name);

  constructor(
    @Inject('LAYOUTS_MODEL') private readonly layoutModel: Model<Layout>,
    private readonly openaiService: OpenaiService,
    private readonly snippetsService: SnippetsService,
    private readonly orgsService: OrgsService,
    private readonly plansService: PlansService,
    private readonly shutterstockService: ShutterstockService,
  ) {}

  async findAll(): Promise<Layout[]> {
    return this.layoutModel.find().exec();
  }

  async findOne(id: string, orgId: string): Promise<Layout | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      return null;
    }
    return this.layoutModel
      .findOne({ _id: id, org: orgId, deletedAt: null })
      .exec();
  }

  // Returns active *and* archived layouts so the dashboard can list archived
  // ones separately; only soft-deleted layouts are hidden.
  async findForOrg(orgId: string): Promise<Layout[]> {
    if (!Types.ObjectId.isValid(orgId)) {
      return [];
    }
    return this.layoutModel.find({ org: orgId, deletedAt: null }).exec();
  }

  // Drives both plan enforcement and the /plans/usage display, so archived and
  // soft-deleted layouts are excluded from both. `deletedAt: null` also matches
  // pre-existing documents that have no such field.
  async countForOrg(orgId: string): Promise<number> {
    if (!Types.ObjectId.isValid(orgId)) return 0;
    return this.layoutModel
      .countDocuments({
        org: orgId,
        status: { $ne: 'archived' },
        deletedAt: null,
      })
      .exec();
  }

  async create(
    createLayoutDto: CreateLayoutDto,
    orgId: string,
    userId: string,
  ): Promise<Layout> {
    await this.enforceLimit(orgId);

    const layoutData = {
      name: createLayoutDto.name,
      siteName: createLayoutDto.siteName,
      description: createLayoutDto.description,
      nav: createLayoutDto.nav,
      footer: createLayoutDto.footer,
      subPages: createLayoutDto.subPages || [],
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    };

    const createdLayout = new this.layoutModel(layoutData);
    return createdLayout.save();
  }

  // Duplicate an existing layout within the caller's active org. Enforces, in
  // order: (1) the user is a member of the org, (2) the source layout belongs
  // to that org (via org-scoped findOne), (3) the plan's layout limit. The copy
  // is built server-side from the stored layout.
  async duplicate(id: string, orgId: string, userId: string): Promise<Layout> {
    const isMember = await this.orgsService.isUserMember(orgId, userId);
    if (!isMember) {
      throw new ForbiddenException('You do not belong to this organization.');
    }

    const source = await this.findOne(id, orgId);
    if (!source) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    await this.enforceLimit(orgId);

    const src = source.toObject();
    // Strip subdocument _ids so the copied subPages get fresh ones.
    const subPages = (src.subPages || []).map(
      ({ _id, ...rest }: any) => rest,
    );

    const createdLayout = new this.layoutModel({
      name: `${source.name} (copy)`,
      siteName: source.siteName,
      description: source.description,
      nav: src.nav,
      footer: src.footer,
      subPages,
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    });
    return createdLayout.save();
  }

  async update(
    id: string,
    updateLayoutDto: UpdateLayoutDto,
    orgId: string,
  ): Promise<Layout> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const updateData: any = {};
    if (updateLayoutDto.name !== undefined)
      updateData.name = updateLayoutDto.name;
    if (updateLayoutDto.siteName !== undefined)
      updateData.siteName = updateLayoutDto.siteName;
    if (updateLayoutDto.description !== undefined)
      updateData.description = updateLayoutDto.description;
    if (updateLayoutDto.nav !== undefined) updateData.nav = updateLayoutDto.nav;
    if (updateLayoutDto.footer !== undefined)
      updateData.footer = updateLayoutDto.footer;
    if (updateLayoutDto.subPages !== undefined)
      updateData.subPages = updateLayoutDto.subPages;

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    return updatedLayout;
  }

  async customize(id: string, orgId: string): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // Gather all snippet references from nav, footer, and subPages
    const allSnippetRefs: Array<{ ref: any; path: string; index?: number; subIndex?: number }> = [];

    if ((layout.nav as any)?.id) {
      allSnippetRefs.push({ ref: layout.nav, path: 'nav' });
    }
    if ((layout.footer as any)?.id) {
      allSnippetRefs.push({ ref: layout.footer, path: 'footer' });
    }
    if (layout.subPages) {
      layout.subPages.forEach((sp: any, spIdx: number) => {
        (sp.snippets || []).forEach((s: any, sIdx: number) => {
          allSnippetRefs.push({ ref: s, path: 'subPage', index: spIdx, subIndex: sIdx });
        });
      });
    }

    // Load all snippet documents
    const snippetDocs = await Promise.all(
      allSnippetRefs.map((entry) =>
        this.snippetsService.findOne(String(entry.ref.id)),
      ),
    );

    // Build input: only snippets with textReplacement
    const validSnippets = snippetDocs.filter(
      (s): s is NonNullable<typeof s> =>
        s != null && !!s.textReplacement && s.textReplacement.length > 0,
    );
    // Seed the AI from the generic English variant (see pages.service).
    const snippetsInput = validSnippets.map((s) => ({
      snippetId: String(s._id),
      replacements: s.textReplacement!.map((tr: any) => ({
        token: tr.token,
        original: tr.english || tr.replacement || '',
      })),
    }));

    // Helper to mark a snippet abstract as customized
    const markCustomized = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      obj.aiCustomized = true;
      return obj;
    };

    if (snippetsInput.length === 0) {
      // No text replacements — just mark all snippet abstracts as customized
      const updateData: any = {};
      if ((layout.nav as any)?.id) {
        updateData.nav = markCustomized(layout.nav);
      }
      if ((layout.footer as any)?.id) {
        updateData.footer = markCustomized(layout.footer);
      }
      if (layout.subPages) {
        updateData.subPages = layout.subPages.map((sp: any) => {
          const spObj = sp.toObject ? sp.toObject() : { ...sp };
          spObj.snippets = (sp.snippets || []).map((s: any) => markCustomized(s));
          return spObj;
        });
      }

      const updatedLayout = await this.layoutModel
        .findOneAndUpdate(
          { _id: id, org: orgId },
          { $set: updateData },
          { new: true },
        )
        .exec();
      if (!updatedLayout) {
        throw new NotFoundException(`Layout with id ${id} not found`);
      }
      return updatedLayout;
    }

    const result = await this.openaiService.customizeContent({
      name: layout.name,
      siteName: layout.siteName,
      description: layout.description,
      snippets: snippetsInput,
    });

    // Build update data with overrides applied and aiCustomized set
    const applyOverride = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      const snippetResult = result.snippets.find(
        (rs) => rs.snippetId === String(ref.id),
      );
      if (snippetResult) {
        obj.textReplacementOverride = snippetResult.replacements;
      }
      obj.aiCustomized = true;
      return obj;
    };

    const updateData: any = {};

    if ((layout.nav as any)?.id) {
      updateData.nav = applyOverride(layout.nav);
    }
    if ((layout.footer as any)?.id) {
      updateData.footer = applyOverride(layout.footer);
    }
    if (layout.subPages) {
      updateData.subPages = layout.subPages.map((sp: any) => {
        const spObj = sp.toObject ? sp.toObject() : { ...sp };
        spObj.snippets = (sp.snippets || []).map((s: any) => applyOverride(s));
        return spObj;
      });
    }

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    return updatedLayout;
  }

  // Fill the layout's image slots with stock photos. Same contract as
  // PagesService.customizeImages, but has to walk the three places a layout
  // keeps snippet references: nav, footer and subPages[].snippets[].
  async customizeImages(
    id: string,
    orgId: string,
    options: { direction?: string; replaceExisting?: boolean } = {},
  ): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // Every snippet-abstract position in the layout, flattened.
    const refs: any[] = [];
    if ((layout.nav as any)?.id) refs.push(layout.nav);
    if ((layout.footer as any)?.id) refs.push(layout.footer);
    (layout.subPages || []).forEach((sp: any) => {
      (sp.snippets || []).forEach((s: any) => refs.push(s));
    });

    const snippetDocs = await Promise.all(
      refs.map((ref) => this.snippetsService.findOne(String(ref.id))),
    );

    const slots: Array<{
      snippetId: string;
      token: string;
      shape?: string;
      context?: string;
      targetAspect: number | null;
    }> = [];
    const seen = new Set<string>();

    refs.forEach((ref, index) => {
      const snippet = snippetDocs[index];
      if (!snippet?.imageReplacement?.length) return;

      const filled = new Set(
        (ref.imageReplacementOverride || [])
          .filter((o: any) => o?.replacement)
          .map((o: any) => o.token),
      );

      const context = (snippet.textReplacement || [])
        .map((tr: any) => tr.english || tr.replacement || '')
        .filter(Boolean)
        .slice(0, 3)
        .join(' | ')
        .slice(0, 200);

      snippet.imageReplacement.forEach((ir: any) => {
        if (!options.replaceExisting && filled.has(ir.token)) return;

        const key = `${String(snippet._id)}::${ir.token}`;
        if (seen.has(key)) return;
        seen.add(key);

        slots.push({
          snippetId: String(snippet._id),
          token: ir.token,
          shape: slotShapeFor(ir.replacement) ?? undefined,
          context: context || undefined,
          targetAspect: targetAspectFor(ir.replacement),
        });
      });
    });

    if (!slots.length) {
      return layout;
    }

    const { slots: queries } = await this.openaiService.deriveImageQueries({
      name: layout.name,
      siteName: layout.siteName,
      description: layout.description,
      direction: options.direction,
      slots: slots.map(({ targetAspect, ...slot }) => slot),
    });

    const aspectByKey = new Map(
      slots.map((s) => [`${s.snippetId}::${s.token}`, s.targetAspect]),
    );

    const picks = await Promise.all(
      queries.map(async (q) => {
        const key = `${q.snippetId}::${q.token}`;
        try {
          const image = await this.shutterstockService.findBestMatch(
            q.query,
            aspectByKey.get(key) ?? null,
          );
          return image ? { snippetId: q.snippetId, token: q.token, image } : null;
        } catch (error) {
          this.logger.warn(
            `Stock search failed for ${key} ("${q.query}"): ${String(error)}`,
          );
          return null;
        }
      }),
    );

    const picksBySnippet = new Map<string, Array<{ token: string; image: any }>>();
    for (const pick of picks) {
      if (!pick) continue;
      const list = picksBySnippet.get(pick.snippetId) || [];
      list.push({ token: pick.token, image: pick.image });
      picksBySnippet.set(pick.snippetId, list);
    }

    if (!picksBySnippet.size) {
      return layout;
    }

    // Applies picks to one snippet reference, preserving any override the run
    // didn't touch. Replacement is written as a unit so a stale shutterstockId
    // can never outlive the image it belonged to.
    const applyPicks = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      const forSnippet = picksBySnippet.get(String(ref.id));
      if (!forSnippet?.length) return obj;

      const overrides = new Map<string, any>(
        (obj.imageReplacementOverride || []).map((o: any) => [o.token, o]),
      );
      for (const { token, image } of forSnippet) {
        overrides.set(token, {
          token,
          replacement: image.previewUrl,
          shutterstockId: image.id,
        });
      }
      obj.imageReplacementOverride = Array.from(overrides.values());
      obj.aiImagesPopulated = true;
      return obj;
    };

    const updateData: any = {};
    if ((layout.nav as any)?.id) updateData.nav = applyPicks(layout.nav);
    if ((layout.footer as any)?.id) updateData.footer = applyPicks(layout.footer);
    if (layout.subPages) {
      updateData.subPages = layout.subPages.map((sp: any) => {
        const spObj = sp.toObject ? sp.toObject() : { ...sp };
        spObj.snippets = (sp.snippets || []).map((s: any) => applyPicks(s));
        return spObj;
      });
    }

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    return updatedLayout;
  }

  // Archive or restore a layout. Restoring re-enters the plan count, so it has
  // to re-check the limit — otherwise archiving, creating replacements, and
  // restoring the originals would leave an org over its cap.
  async setArchived(
    id: string,
    orgId: string,
    archived: boolean,
  ): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    if (!archived && layout.status === 'archived') {
      await this.enforceLimit(orgId);
    }

    const updatedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: { status: archived ? 'archived' : 'active' } },
        { new: true },
      )
      .exec();

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    return updatedLayout;
  }

  // Soft delete: the document is kept so it can be recovered manually, but it
  // is hidden from every read path and drops out of the plan count.
  async remove(id: string, orgId: string): Promise<void> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(orgId)) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const deletedLayout = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { new: true },
      )
      .exec();

    if (!deletedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
  }

  private async enforceLimit(orgId: string): Promise<void> {
    const org = await this.orgsService.findOne(orgId);
    if (!org?.plan) {
      throw new ForbiddenException(
        'No active plan. Subscribe to a plan to create layouts.',
      );
    }

    const limits = await this.plansService.getLimitsForPriceId(org.plan);
    if (!limits || limits.maxLayouts === -1) return; // Unlimited

    const current = await this.countForOrg(orgId);
    if (current >= limits.maxLayouts) {
      throw new ForbiddenException(
        `Layout limit reached (${limits.maxLayouts}). Upgrade your plan to create more layouts.`,
      );
    }
  }
}
