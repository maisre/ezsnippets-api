import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { exportSiteZip } from '../export/site-export';
import { Layout } from './interfaces/layout.interface';
import { CreateLayoutDto } from './dto/create-layout.dto';
import { UpdateLayoutDto } from './dto/update-layout.dto';
import { OpenaiService } from '../openai';
import { AiUsageService } from '../ai-usage';
import { TemplatesService } from '../templates/templates.service';
import { SnippetsService } from '../snippets/snippets.service';
import { OrgsService } from '../orgs/orgs.service';
import { PlansService } from '../plans/plans.service';
import { hasActiveSubscription } from '../plans/subscription-status';
import { ShutterstockService } from '../shutterstock';
import { targetAspectFor, slotShapeFor } from '../shutterstock/target-dimensions';
import { wrapAffiliate, imagePageUrl } from '../shutterstock/affiliate';
import { validateSlug } from '../common/slug-rules';
import { assertSlugAvailable } from '../common/slug-conflict';

/**
 * Normalize a layout's `nav`/`footer` to a snippet abstract.
 *
 * Subpage snippets have always been stored as abstracts ({ id, ...overrides }),
 * but nav and footer were written as bare id strings by the editor. Every
 * consumer here guarded on `nav?.id`, which is false for a string — so AI text
 * customization, image population and the licensing collector all silently
 * skipped the nav and footer. Normalizing on read fixes that, and because the
 * normalized value is what gets written back, a layout upgrades itself to the
 * abstract shape the first time it's customized. ez-view already accepted both
 * shapes, so nothing needed to change there.
 */
function toSnippetRef(value: any): any | null {
  if (!value) return null;
  if (typeof value === 'string') return { id: value };
  if (typeof value === 'object' && value.id) return value;
  return null;
}

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
    private readonly aiUsageService: AiUsageService,
    private readonly templatesService: TemplatesService,
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
    if (updateLayoutDto.slug !== undefined) {
      const check = validateSlug(updateLayoutDto.slug);
      if (!check.ok) {
        throw new BadRequestException(check.reason);
      }
      if (check.value) {
        // Pages share the same /:slug namespace on a custom domain.
        await assertSlugAvailable(
          this.layoutModel.db,
          orgId,
          check.value,
          'pages',
        );
      }
      updateData.slug = check.value;
    }
    if (updateLayoutDto.nav !== undefined) updateData.nav = updateLayoutDto.nav;
    if (updateLayoutDto.footer !== undefined)
      updateData.footer = updateLayoutDto.footer;
    if (updateLayoutDto.subPages !== undefined) {
      // The layout editor owns subpage membership/order but not the page-scoped
      // customizations (AI text/image overrides, aiCustomized/aiImagesPopulated)
      // on each subpage snippet. A naive full replace wiped those whenever a
      // snippet was dragged in or reordered. Merge instead, preserving each
      // snippet's customizations by id.
      const existing = await this.layoutModel
        .findOne({ _id: id, org: orgId })
        .exec();
      if (!existing) {
        throw new NotFoundException(`Layout with id ${id} not found`);
      }
      updateData.subPages = this.mergeSubPages(
        updateLayoutDto.subPages as any[],
        (existing.subPages as any[]) ?? [],
      );
    }

    // Mark the layout dirty so ez-background re-screenshots it once edits settle.
    updateData.contentUpdatedAt = new Date();

    let updatedLayout: Layout | null;
    try {
      updatedLayout = await this.layoutModel
        .findOneAndUpdate(
          { _id: id, org: orgId },
          { $set: updateData },
          { new: true },
        )
        .exec();
    } catch (err: any) {
      // The partial unique index on { org, slug } is the real guard; translate
      // it rather than letting a raw E11000 reach the editor.
      if (err?.code === 11000 && updateData.slug) {
        throw new ConflictException(
          `Another site already uses "${updateData.slug}".`,
        );
      }
      throw err;
    }

    if (!updatedLayout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    return updatedLayout;
  }

  /**
   * Merge a client-supplied set of subpages (membership/order of subpages and
   * of the snippets within them) onto the stored subpages, preserving each
   * subpage snippet's page-scoped customization fields. Snippets are matched by
   * id across all stored subpages, consumed in order, so a snippet keeps its
   * overrides even if it moves between subpages. A snippet with no stored match
   * is new and passes through untouched. Only overwrites a customization field
   * when the client sends a real (non-empty) value.
   */
  private mergeSubPages(incoming: any[], stored: any[]): any[] {
    const nonEmpty = (v: any): boolean =>
      v != null &&
      !(typeof v === 'string' && v.trim() === '') &&
      !(Array.isArray(v) && v.length === 0) &&
      !(
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).length === 0
      );

    // Queue of stored snippet abstracts per id, gathered across every stored
    // subpage in order, consumed positionally.
    const storedById = new Map<string, any[]>();
    for (const sp of stored) {
      const spObj = sp?.toObject ? sp.toObject() : sp;
      for (const sa of spObj?.snippets ?? []) {
        const obj = sa?.toObject ? sa.toObject() : { ...sa };
        const key = String(obj.id);
        if (!storedById.has(key)) storedById.set(key, []);
        storedById.get(key)!.push(obj);
      }
    }

    return incoming.map((sp) => ({
      ...sp,
      snippets: (sp.snippets ?? []).map((inc: any) => {
        const queue = storedById.get(String(inc.id));
        const prev = queue && queue.length ? queue.shift() : undefined;
        if (!prev) {
          return inc;
        }
        return {
          ...prev,
          ...inc,
          cssOverride: nonEmpty(inc.cssOverride)
            ? inc.cssOverride
            : prev.cssOverride,
          jsOverride: nonEmpty(inc.jsOverride)
            ? inc.jsOverride
            : prev.jsOverride,
          htmlOverride: nonEmpty(inc.htmlOverride)
            ? inc.htmlOverride
            : prev.htmlOverride,
          textReplacementOverride: nonEmpty(inc.textReplacementOverride)
            ? inc.textReplacementOverride
            : prev.textReplacementOverride,
          imageReplacementOverride: nonEmpty(inc.imageReplacementOverride)
            ? inc.imageReplacementOverride
            : prev.imageReplacementOverride,
          aiCustomized: inc.aiCustomized ?? prev.aiCustomized,
          aiImagesPopulated: inc.aiImagesPopulated ?? prev.aiImagesPopulated,
        };
      }),
    }));
  }

  async customize(
    id: string,
    orgId: string,
    options: { onlyMissing?: boolean } = {},
  ): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // In onlyMissing mode we only touch snippets never AI-customized, leaving
    // the rest — and their overrides — untouched.
    const shouldDo = (ref: any) => !options.onlyMissing || ref.aiCustomized !== true;

    // Gather all snippet references from nav, footer, and subPages
    const allSnippetRefs: Array<{ ref: any; path: string; index?: number; subIndex?: number }> = [];

    const navRef = toSnippetRef(layout.nav);
    const footerRef = toSnippetRef(layout.footer);
    if (navRef) {
      allSnippetRefs.push({ ref: navRef, path: 'nav' });
    }
    if (footerRef) {
      allSnippetRefs.push({ ref: footerRef, path: 'footer' });
    }
    if (layout.subPages) {
      layout.subPages.forEach((sp: any, spIdx: number) => {
        (sp.snippets || []).forEach((s: any, sIdx: number) => {
          allSnippetRefs.push({ ref: s, path: 'subPage', index: spIdx, subIndex: sIdx });
        });
      });
    }

    // Load all snippet documents (parallel to allSnippetRefs by index).
    const snippetDocs = await Promise.all(
      allSnippetRefs.map((entry) =>
        this.snippetsService.findOne(String(entry.ref.id)),
      ),
    );

    // Build input: only targeted snippets that have textReplacement.
    // Seed the AI from the generic English variant (see pages.service).
    const snippetsInput = allSnippetRefs
      .map((entry, i) => ({ ref: entry.ref, doc: snippetDocs[i] }))
      .filter(
        ({ ref, doc }) =>
          shouldDo(ref) &&
          doc != null &&
          !!doc.textReplacement &&
          doc.textReplacement.length > 0,
      )
      .map(({ doc }) => ({
        snippetId: String(doc!._id),
        replacements: doc!.textReplacement!.map((tr: any) => ({
          token: tr.token,
          original: tr.english || tr.replacement || '',
        })),
      }));

    // Helper to mark a snippet abstract as customized (only if targeted).
    const markCustomized = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      if (shouldDo(ref)) obj.aiCustomized = true;
      return obj;
    };

    if (snippetsInput.length === 0) {
      // No text replacements — just mark all snippet abstracts as customized
      const updateData: any = {};
      if (navRef) {
        updateData.nav = markCustomized(navRef);
      }
      if (footerRef) {
        updateData.footer = markCustomized(footerRef);
      }
      if (layout.subPages) {
        updateData.subPages = layout.subPages.map((sp: any) => {
          const spObj = sp.toObject ? sp.toObject() : { ...sp };
          spObj.snippets = (sp.snippets || []).map((s: any) => markCustomized(s));
          return spObj;
        });
      }

      updateData.contentUpdatedAt = new Date();

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

    // Meter before we spend: everything above this point is local work, and the
    // early return above means an org isn't charged for a no-op customize.
    await this.aiUsageService.consume(
      String(orgId),
      'layout.customize',
      await this.aiLimitFor(String(orgId)),
    );

    const result = await this.openaiService.customizeContent({
      name: layout.name,
      siteName: layout.siteName,
      description: layout.description,
      snippets: snippetsInput,
    });

    // Build update data with overrides applied and aiCustomized set. In
    // onlyMissing mode, already-customized snippets are left exactly as-is.
    const applyOverride = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      if (!shouldDo(ref)) return obj;
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

    if (navRef) {
      updateData.nav = applyOverride(navRef);
    }
    if (footerRef) {
      updateData.footer = applyOverride(footerRef);
    }
    if (layout.subPages) {
      updateData.subPages = layout.subPages.map((sp: any) => {
        const spObj = sp.toObject ? sp.toObject() : { ...sp };
        spObj.snippets = (sp.snippets || []).map((s: any) => applyOverride(s));
        return spObj;
      });
    }

    updateData.contentUpdatedAt = new Date();

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
    options: {
      direction?: string;
      replaceExisting?: boolean;
      onlyMissing?: boolean;
    } = {},
  ): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    // In onlyMissing mode we only touch snippets never image-populated.
    const shouldDo = (ref: any) =>
      !options.onlyMissing || ref.aiImagesPopulated !== true;

    // Every snippet-abstract position in the layout, flattened.
    const refs: any[] = [];
    const navRef = toSnippetRef(layout.nav);
    const footerRef = toSnippetRef(layout.footer);
    if (navRef) refs.push(navRef);
    if (footerRef) refs.push(footerRef);
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
      if (!shouldDo(ref)) return;
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

    const picksBySnippet = new Map<string, Array<{ token: string; image: any }>>();

    // Skip the OpenAI + Shutterstock round-trip when there's nothing to fill
    // (e.g. onlyMissing where the new snippets carry no image slots). Targeted
    // snippets are still marked done below so the "missing" count clears.
    if (slots.length) {
      await this.aiUsageService.consume(
        String(orgId),
        'layout.customize-images',
        await this.aiLimitFor(String(orgId)),
      );

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
            return image
              ? { snippetId: q.snippetId, token: q.token, image }
              : null;
          } catch (error) {
            this.logger.warn(
              `Stock search failed for ${key} ("${q.query}"): ${String(error)}`,
            );
            return null;
          }
        }),
      );

      for (const pick of picks) {
        if (!pick) continue;
        const list = picksBySnippet.get(pick.snippetId) || [];
        list.push({ token: pick.token, image: pick.image });
        picksBySnippet.set(pick.snippetId, list);
      }
    }

    // Applies picks to one snippet reference and marks every targeted ref as
    // image-populated — even ones with no slots or no successful pick — so a
    // repeat "missing" run doesn't keep re-targeting them. Non-targeted refs are
    // left as-is. Replacement is written as a unit so a stale shutterstockId can
    // never outlive the image it belonged to.
    const applyPicks = (ref: any) => {
      const obj = ref.toObject ? ref.toObject() : { ...ref };
      if (!shouldDo(ref)) return obj;

      const forSnippet = picksBySnippet.get(String(ref.id));
      if (forSnippet?.length) {
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
      }
      obj.aiImagesPopulated = true;
      return obj;
    };

    const updateData: any = {};
    if (navRef) updateData.nav = applyPicks(navRef);
    if (footerRef) updateData.footer = applyPicks(footerRef);
    if (layout.subPages) {
      updateData.subPages = layout.subPages.map((sp: any) => {
        const spObj = sp.toObject ? sp.toObject() : { ...sp };
        spObj.snippets = (sp.snippets || []).map((s: any) => applyPicks(s));
        return spObj;
      });
    }

    updateData.contentUpdatedAt = new Date();

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

  private readonly viewUrl = process.env.VIEW_URL || 'http://localhost:3100';

  // Shutterstock images used across the layout (nav, footer, and every subpage
  // snippet), for the finalize licensing hand-off. Deduped by shutterstockId.
  async getLicensing(
    id: string,
    orgId: string,
  ): Promise<{
    images: Array<{
      shutterstockId: string;
      previewUrl: string;
      token: string;
      uses: number;
      licenseUrl: string;
    }>;
    collectionsEnabled: boolean;
  }> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const byId = new Map<
      string,
      { shutterstockId: string; previewUrl: string; token: string; uses: number }
    >();
    const collect = (ref: any) => {
      for (const o of ref?.imageReplacementOverride || []) {
        if (!o?.shutterstockId) continue;
        const existing = byId.get(o.shutterstockId);
        if (existing) {
          existing.uses += 1;
        } else {
          byId.set(o.shutterstockId, {
            shutterstockId: o.shutterstockId,
            previewUrl: o.replacement,
            token: o.token,
            uses: 1,
          });
        }
      }
    };
    const navRef = toSnippetRef(layout.nav);
    const footerRef = toSnippetRef(layout.footer);
    if (navRef) collect(navRef);
    if (footerRef) collect(footerRef);
    for (const sp of (layout.subPages as any[]) || []) {
      for (const s of sp.snippets || []) collect(s);
    }
    return {
      images: [...byId.values()].map((i) => ({
        ...i,
        licenseUrl: wrapAffiliate(imagePageUrl(i.shutterstockId)),
      })),
      collectionsEnabled: this.shutterstockService.isCollectionsConfigured,
    };
  }

  // Build a shareable, affiliate-attributed "license everything" link on demand
  // from this layout's images. Nothing persisted — reaped by age via the
  // ez-background cron. See pages.service.generateCollectionUrl.
  async generateCollectionUrl(
    id: string,
    orgId: string,
  ): Promise<{ licenseAllUrl: string }> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    const { images } = await this.getLicensing(id, orgId);
    const shareUrl = await this.shutterstockService.createShareableCollection(
      layout.name || 'layout',
      images.map((i) => i.shutterstockId),
    );
    return { licenseAllUrl: wrapAffiliate(shareUrl) };
  }

  // Build a downloadable static-site zip for a layout. Renders via ez-view with
  // ?chrome=false so the subpage-switcher overlay is left out of the export.
  async exportZip(
    id: string,
    orgId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    const { images } = await this.getLicensing(id, orgId);
    const csv =
      'shutterstock_id,uses\n' +
      images.map((i) => `${i.shutterstockId},${i.uses}`).join('\n');
    return exportSiteZip({
      renderUrl: `${this.viewUrl}/view/layout/${id}?chrome=false`,
      name: layout.name || 'layout',
      licensingCsv: csv,
    });
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

  /**
   * The org's AI allowance for the day, from its plan.
   *
   * Resolved per call rather than cached so a plan change takes effect at once;
   * it's one indexed read alongside an OpenAI round-trip. Returns undefined
   * when the org can't be loaded, which leaves AiUsageService on its backstop
   * ceiling rather than unmetered.
   */
  /**
   * Start a new site from a layout template: one nav, one footer, and the
   * template's named subpages, all blank.
   *
   * nav and footer are written as snippet abstracts rather than the bare id
   * strings the editor used to save, so a layout created this way is already in
   * the shape the rest of the service expects (see toSnippetRef).
   */
  async createFromTemplate(
    templateId: string,
    dto: { name?: string; siteName?: string; description?: string },
    orgId: string,
    userId: string,
  ): Promise<Layout> {
    const isMember = await this.orgsService.isUserMember(orgId, userId);
    if (!isMember) {
      throw new ForbiddenException('You do not belong to this organization.');
    }

    const template = await this.templatesService.findOne(templateId, orgId);
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }
    if (template.kind !== 'layout') {
      throw new BadRequestException(
        'That is a page template — start a page from it, not a site.',
      );
    }

    await this.enforceLimit(orgId);

    const created = new this.layoutModel({
      name: dto.name?.trim() || template.name,
      siteName: dto.siteName?.trim() || undefined,
      description: dto.description?.trim() || template.description,
      nav: template.nav ? { id: template.nav } : undefined,
      footer: template.footer ? { id: template.footer } : undefined,
      subPages: (template.subPages ?? []).map((sp) => ({
        name: sp.name,
        snippets: (sp.snippetIds ?? []).map((id) => ({ id })),
      })),
      org: new Types.ObjectId(orgId),
      createdBy: new Types.ObjectId(userId),
    });

    return created.save();
  }

  /**
   * Apply a template to an existing layout.
   *
   * A layout-kind template replaces the whole shell — nav, footer and subpages.
   * A page or partial template lands in one subpage instead, which is how a
   * saved group of snippets gets reused inside a site.
   */
  async applyTemplate(
    id: string,
    templateId: string,
    mode: 'append' | 'replace',
    orgId: string,
    subPageIndex?: number,
  ): Promise<Layout> {
    const layout = await this.findOne(id, orgId);
    if (!layout) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }

    const template = await this.templatesService.findOne(templateId, orgId);
    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    const updateData: any = {};

    if (template.kind === 'layout') {
      updateData.nav = template.nav ? { id: template.nav } : undefined;
      updateData.footer = template.footer ? { id: template.footer } : undefined;
      const incoming = (template.subPages ?? []).map((sp) => ({
        name: sp.name,
        snippets: (sp.snippetIds ?? []).map((snippetId) => ({ id: snippetId })),
      }));
      const existing = (layout.toObject().subPages || []).map(
        ({ _id, ...rest }: any) => rest,
      );
      updateData.subPages =
        mode === 'replace' ? incoming : [...existing, ...incoming];
    } else {
      const subPages = (layout.toObject().subPages || []).map(
        ({ _id, ...rest }: any) => rest,
      );
      const index = subPageIndex ?? 0;
      if (!subPages[index]) {
        throw new BadRequestException(
          `This layout has no subpage at position ${index}.`,
        );
      }

      const incoming = template.snippetIds.map((snippetId) => ({
        id: snippetId,
      }));
      subPages[index] = {
        ...subPages[index],
        snippets:
          mode === 'replace'
            ? incoming
            : [...(subPages[index].snippets || []), ...incoming],
      };
      updateData.subPages = subPages;
    }

    updateData.contentUpdatedAt = new Date();

    const updated = await this.layoutModel
      .findOneAndUpdate(
        { _id: id, org: orgId, deletedAt: null },
        { $set: updateData },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Layout with id ${id} not found`);
    }
    return updated;
  }

  private async aiLimitFor(orgId: string): Promise<number | undefined> {
    const org = await this.orgsService.findOne(orgId);
    if (!org) return undefined;
    return this.plansService.getLimits(org.productId).aiDailyLimit;
  }

  private async enforceLimit(orgId: string): Promise<void> {
    const org = await this.orgsService.findOne(orgId);
    if (!hasActiveSubscription(org)) {
      throw new ForbiddenException(
        'No active plan. Subscribe to a plan to create layouts.',
      );
    }

    const limits = this.plansService.getLimits(org.productId);
    if (limits.maxLayouts === -1) return; // Unlimited

    const current = await this.countForOrg(orgId);
    if (current >= limits.maxLayouts) {
      throw new ForbiddenException(
        `Layout limit reached (${limits.maxLayouts}). Upgrade your plan to create more layouts.`,
      );
    }
  }
}
