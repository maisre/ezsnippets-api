import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import OpenAI from 'openai';
import {
  ContentChunk,
  ContentSnippetInput,
  KeyedSlot,
  MAX_CHUNK_SLOTS,
  buildChunks,
  dedupeSnippets,
  mapLimit,
  roleOf,
} from './content-chunks';

/** Parallel requests per customize run. Well inside gpt-4o-mini rate limits. */
const CHUNK_CONCURRENCY = 10;

export interface CustomizeContentInput {
  name: string;
  siteName?: string;
  description?: string;
  snippets: ContentSnippetInput[];
}

export interface CustomizeContentResult {
  snippets: Array<{
    snippetId: string;
    replacements: Array<{ token: string; replacement: string }>;
  }>;
}

export interface ImageQueryInput {
  name: string;
  siteName?: string;
  description?: string;
  /** Optional free-text steer from the user, e.g. "warm, natural light". */
  direction?: string;
  slots: Array<{
    snippetId: string;
    token: string;
    /** 'wide' | 'tall' | 'square' — the slot's shape, or undefined if unknown. */
    shape?: string;
    /** Nearby copy from the same snippet, to disambiguate what the image is for. */
    context?: string;
  }>;
}

export interface ImageQueryResult {
  slots: Array<{ snippetId: string; token: string; query: string }>;
}

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);
  private readonly client: OpenAI;

  constructor(@Inject('OPENAI_API_KEY') private readonly apiKey: string) {
    if (!this.apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY is not configured. Content customization will fail.',
      );
    }
    this.client = new OpenAI({ apiKey: this.apiKey });
  }

  /**
   * Rewrite a page's or layout's placeholder text for the business.
   *
   * The work is split into small chunks (see content-chunks.ts) that run in
   * parallel. When there is more than one chunk, a short site brief is written
   * first so every chunk tells the same story. Slots the model skips get one
   * targeted retry; anything still missing keeps its original text.
   */
  async customizeContent(
    context: CustomizeContentInput,
  ): Promise<CustomizeContentResult> {
    if (!this.apiKey) {
      throw new UnauthorizedException('OpenAI API key is not configured');
    }

    const unique = dedupeSnippets(context.snippets);
    const { chunks, slots } = buildChunks(unique);
    const texts = new Map<string, string>();

    if (chunks.length) {
      try {
        const brief = chunks.length > 1 ? await this.siteBrief(context) : undefined;
        const runAll = async (list: ContentChunk[]) => {
          await mapLimit(list, CHUNK_CONCURRENCY, async (chunk) => {
            const got = await this.rewriteChunkWithRetry(context, chunk, brief);
            got.forEach((text, key) => texts.set(key, text));
          });
        };

        await runAll(chunks);

        const missing = slots.filter((slot) => !texts.has(slot.key));
        if (missing.length) {
          this.logger.warn(
            `Text customize: retrying ${missing.length}/${slots.length} skipped slots`,
          );
          await runAll(chunkMissing(missing, unique));
        }
      } catch (error) {
        return this.handleApiError(error);
      }

      const stillMissing = slots.filter((slot) => !texts.has(slot.key)).length;
      if (stillMissing) {
        this.logger.warn(
          `Text customize: ${stillMissing}/${slots.length} slots kept their original text`,
        );
      }
    }

    // Answer per input snippet (duplicates included) so callers can map
    // results back by snippetId exactly as before.
    const keyFor = new Map(slots.map((s) => [`${s.snippetId}::${s.token}`, s.key]));
    return {
      snippets: context.snippets.map((snippet) => ({
        snippetId: snippet.snippetId,
        replacements: snippet.replacements.map((r) => {
          const key = keyFor.get(`${snippet.snippetId}::${r.token}`);
          return {
            token: r.token,
            replacement: (key && texts.get(key)) || r.original,
          };
        }),
      })),
    };
  }

  /** One retry on failure: a single flaky request shouldn't sink the run. */
  private async rewriteChunkWithRetry(
    context: CustomizeContentInput,
    chunk: ContentChunk,
    brief?: string,
  ): Promise<Map<string, string>> {
    try {
      return await this.rewriteChunk(context, chunk, brief);
    } catch (error) {
      if (
        error instanceof OpenAI.APIError &&
        (error.status === 401 || error.status === 403)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.rewriteChunk(context, chunk, brief);
    }
  }

  private async rewriteChunk(
    context: CustomizeContentInput,
    chunk: ContentChunk,
    brief?: string,
  ): Promise<Map<string, string>> {
    const systemPrompt = `You are a website copywriter. You rewrite the placeholder text of a website template so it fits a specific business.

Rules:
- Rewrite EVERY slot and return exactly one entry per key you are given.
- Match each slot's role and rough length: headings stay short, links/buttons stay 1-4 words, paragraphs stay within about 30% of the original's length.
- Write for this business only. Never keep details from the placeholder that belong to a different kind of business.
- Stay consistent with the site brief when one is given. Invent plausible specifics (names, numbers, places) only where a slot needs them.
- Use the section and block descriptions to decide what each slot is for, and avoid repeating the same phrase across slots.
- Plain text only: no markdown, no HTML, no surrounding quotes.
Return your response as a JSON object.`;

    let userPrompt = `Site/page name: ${context.name}\n`;
    if (context.siteName) userPrompt += `Site name: ${context.siteName}\n`;
    if (context.description) userPrompt += `Description: ${context.description}\n`;
    userPrompt += `Current year: ${new Date().getFullYear()}\n`;
    if (brief) userPrompt += `\nSite brief (keep to these facts):\n${brief}\n`;

    const sections = chunk.sections.map((section) => ({
      ...(section.section ? { where: section.section } : {}),
      ...(section.about ? { block: section.about } : {}),
      slots: Object.fromEntries(
        section.slots.map((slot) => [
          slot.key,
          { role: roleOf(slot.token), text: slot.original },
        ]),
      ),
    }));
    userPrompt += `\nBlocks to rewrite:\n${JSON.stringify(sections)}`;
    userPrompt += `\n\nRespond with a JSON object in this exact format, covering every key:\n{"t": {"<key>": "<new text>"}}`;

    const response = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const result = new Map<string, string>();
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return result;

    let parsed: { t?: Record<string, unknown> };
    try {
      parsed = JSON.parse(content);
    } catch {
      // A cut-off reply is treated as all-skipped; the retry pass covers it.
      return result;
    }
    const wanted = new Set(chunk.sections.flatMap((s) => s.slots.map((x) => x.key)));
    for (const [key, value] of Object.entries(parsed.t ?? {})) {
      if (!wanted.has(key) || typeof value !== 'string') continue;
      const text = value.trim();
      if (text) result.set(key, text);
    }
    return result;
  }

  /**
   * A few lines every chunk works from, so a split page still agrees on the
   * business name, offerings and facts. Best-effort: without it the chunks
   * still run, just with less shared context.
   */
  private async siteBrief(context: CustomizeContentInput): Promise<string | undefined> {
    let userPrompt = `Site/page name: ${context.name}\n`;
    if (context.siteName) userPrompt += `Site name: ${context.siteName}\n`;
    if (context.description) userPrompt += `Description: ${context.description}\n`;
    userPrompt += `\nWrite a brief of 4-6 short lines: business name, 3-5 specific offerings, who it is for, tone of voice, location if implied, and 2-3 concrete facts to reuse (e.g. founding year, hours, a guarantee). Invent plausible details where the description is silent.\nRespond with a JSON object: {"brief": "..."}`;

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You write a short brief for website copywriters so every section of a site tells the same story. Return your response as a JSON object.',
          },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 350,
      });
      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return undefined;
      const brief = JSON.parse(content)?.brief;
      return typeof brief === 'string' && brief.trim() ? brief.trim() : undefined;
    } catch (error) {
      this.logger.warn(`Site brief failed, continuing without it: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Turn a page's description into one stock-photo search query per image slot.
   *
   * Deliberately separate from customizeContent: the two are driven by separate
   * buttons, so re-running text must not re-run images (or vice versa). It also
   * needs a different prompt — a site description is prose, and feeding it to
   * Shutterstock verbatim returns noise. What's wanted is 2-5 concrete visual
   * keywords per slot, varied by what each slot is actually for.
   */
  async deriveImageQueries(
    context: ImageQueryInput,
  ): Promise<ImageQueryResult> {
    if (!this.apiKey) {
      throw new UnauthorizedException('OpenAI API key is not configured');
    }
    if (!context.slots.length) {
      return { slots: [] };
    }

    const systemPrompt = `You write search queries for a stock photography API. Given a website's name and description, plus a list of image slots on a page, produce ONE search query per slot.

Rules:
- Each query must be 2-5 concrete, visual keywords describing a photograph. No sentences, no punctuation, no brand names.
- Describe the SUBJECT of a photo, not the website. "artisan coffee beans roasting" is good; "coffee shop homepage hero" is not.
- Vary queries across slots so the page does not end up with near-identical photos. Use each slot's shape and surrounding copy to decide what it is for: a "wide" slot is usually a hero or banner, "square" is often a portrait, card or avatar, "tall" is a sidebar or feature image.
- Stay consistent with the site's subject matter and tone throughout.
Return your response as a JSON object.`;

    let userPrompt = `Site/page name: ${context.name}\n`;
    if (context.siteName) {
      userPrompt += `Site name: ${context.siteName}\n`;
    }
    if (context.description) {
      userPrompt += `Description: ${context.description}\n`;
    }
    if (context.direction) {
      userPrompt += `Art direction from the user (respect this): ${context.direction}\n`;
    }
    userPrompt += `\nImage slots needing a query:\n`;
    userPrompt += JSON.stringify(context.slots, null, 2);
    userPrompt += `\n\nRespond with a JSON object in this exact format:\n`;
    userPrompt += `{"slots": [{"snippetId": "...", "token": "...", "query": "..."}]}`;

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        this.logger.warn('OpenAI returned empty response for image queries');
        return { slots: [] };
      }

      const parsed = JSON.parse(content) as ImageQueryResult;

      // Drop slots the model skipped rather than inventing a query: a bad query
      // yields a confidently wrong photo, whereas a missing one just leaves the
      // slot on its placeholder, which is the safer failure.
      const slots = context.slots
        .map((slot) => {
          const match = parsed.slots?.find(
            (s) => s.snippetId === slot.snippetId && s.token === slot.token,
          );
          const query = match?.query?.trim();
          return query
            ? { snippetId: slot.snippetId, token: slot.token, query }
            : null;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      return { slots };
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  /**
   * Suggest 3-5 short keyword sets for image Quick fill, from the site's name
   * and description. One small call; the user picks or edits one, and Quick
   * fill does the rest without any further AI.
   */
  async suggestImageKeywords(context: {
    name: string;
    siteName?: string;
    description?: string;
  }): Promise<string[]> {
    if (!this.apiKey) {
      throw new UnauthorizedException('OpenAI API key is not configured');
    }

    const systemPrompt = `You suggest search keywords for a stock photography API, to fill every image on a website with one search.

Rules:
- Return 5 options. Each option is 2-3 common, concrete, visual words describing the photos the site would show, e.g. "craft brewery taproom" or "dentist office smiling patient".
- Describe photo SUBJECTS, not the website. No brand names, no punctuation, no sentences.
- The photo library requires EVERY word to match, so prefer broad, common words over niche ones ("brewery beer" finds far more than "taproom flight paddle").
- Make the options meaningfully different (e.g. people vs place vs product), all true to the site's subject.
Return your response as a JSON object.`;

    let userPrompt = `Site/page name: ${context.name}\n`;
    if (context.siteName) userPrompt += `Site name: ${context.siteName}\n`;
    if (context.description) userPrompt += `Description: ${context.description}\n`;
    userPrompt += `\nRespond with a JSON object in this exact format:\n{"keywords": ["...", "..."]}`;

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) return [];

      const parsed = JSON.parse(content) as { keywords?: unknown };
      if (!Array.isArray(parsed.keywords)) return [];

      const seen = new Set<string>();
      return parsed.keywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.replace(/\s+/g, ' ').trim().slice(0, 100))
        .filter((k) => {
          const key = k.toLowerCase();
          if (!k || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 5);
    } catch (error) {
      return this.handleApiError(error);
    }
  }

  private handleApiError(error: unknown): never {
    if (error instanceof OpenAI.APIError) {
      const status = error.status;
      const message = error.message;

      this.logger.error(`OpenAI API error: ${status}`, {
        status,
        message,
        code: error.code,
      });

      switch (status) {
        case 401:
          throw new UnauthorizedException(
            'Invalid OpenAI API key. Please check your configuration.',
          );
        case 403:
          throw new ForbiddenException(
            'Access to OpenAI API is forbidden. Please check your API permissions.',
          );
        case 429:
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message:
                'OpenAI API rate limit exceeded. Please try again later.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        case 503:
        case 502:
        case 504:
          throw new ServiceUnavailableException(
            'OpenAI API is temporarily unavailable. Please try again later.',
          );
        default:
          throw new HttpException(
            `OpenAI API error: ${message}`,
            status && status >= 500
              ? HttpStatus.BAD_GATEWAY
              : HttpStatus.BAD_REQUEST,
          );
      }
    }

    if (error instanceof HttpException) {
      throw error;
    }

    this.logger.error('Failed to call OpenAI API', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    throw new ServiceUnavailableException(
      'Unable to connect to OpenAI API. Please try again later.',
    );
  }
}

/** Regroups skipped slots by snippet (keeping block context) into retry chunks. */
function chunkMissing(
  missing: KeyedSlot[],
  snippets: ContentSnippetInput[],
): ContentChunk[] {
  const info = new Map(snippets.map((s) => [s.snippetId, s]));
  const chunks: ContentChunk[] = [];
  for (let i = 0; i < missing.length; i += MAX_CHUNK_SLOTS) {
    const part = missing.slice(i, i + MAX_CHUNK_SLOTS);
    const bySnippet = new Map<string, KeyedSlot[]>();
    for (const slot of part) {
      const list = bySnippet.get(slot.snippetId) || [];
      list.push(slot);
      bySnippet.set(slot.snippetId, list);
    }
    chunks.push({
      sections: [...bySnippet.entries()].map(([id, list]) => ({
        section: info.get(id)?.section,
        about: info.get(id)?.about,
        slots: list,
      })),
    });
  }
  return chunks;
}
