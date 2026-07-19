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

export interface CustomizeContentInput {
  name: string;
  siteName?: string;
  description?: string;
  snippets: Array<{
    snippetId: string;
    replacements: Array<{ token: string; original: string }>;
  }>;
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

  async customizeContent(
    context: CustomizeContentInput,
  ): Promise<CustomizeContentResult> {
    if (!this.apiKey) {
      throw new UnauthorizedException('OpenAI API key is not configured');
    }

    const systemPrompt = `You are a website content customizer. Given a page/layout name, description, and a list of text placeholder tokens with their original values, generate contextually appropriate replacement text for each token. The replacement text should be tailored to the specific page/site context while maintaining a similar length and tone to the original. Return your response as a JSON object.`;

    const tokenList = context.snippets.flatMap((s) =>
      s.replacements.map((r) => ({
        snippetId: s.snippetId,
        token: r.token,
        original: r.original,
      })),
    );

    let userPrompt = `Page/Layout name: ${context.name}\n`;
    if (context.siteName) {
      userPrompt += `Site name: ${context.siteName}\n`;
    }
    if (context.description) {
      userPrompt += `Description: ${context.description}\n`;
    }
    userPrompt += `\nHere are the text tokens that need customized replacement text:\n`;
    userPrompt += JSON.stringify(tokenList, null, 2);
    userPrompt += `\n\nRespond with a JSON object in this exact format:\n`;
    userPrompt += `{"snippets": [{"snippetId": "...", "replacements": [{"token": "...", "replacement": "..."}]}]}`;

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
        this.logger.warn('OpenAI returned empty response');
        return { snippets: [] };
      }

      const parsed = JSON.parse(content) as CustomizeContentResult;

      // Ensure all tokens have replacements, falling back to originals
      const result: CustomizeContentResult = {
        snippets: context.snippets.map((inputSnippet) => {
          const resultSnippet = parsed.snippets?.find(
            (s) => s.snippetId === inputSnippet.snippetId,
          );
          return {
            snippetId: inputSnippet.snippetId,
            replacements: inputSnippet.replacements.map((inputReplacement) => {
              const resultReplacement = resultSnippet?.replacements?.find(
                (r) => r.token === inputReplacement.token,
              );
              return {
                token: inputReplacement.token,
                replacement:
                  resultReplacement?.replacement || inputReplacement.original,
              };
            }),
          };
        }),
      };

      return result;
    } catch (error) {
      return this.handleApiError(error);
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
