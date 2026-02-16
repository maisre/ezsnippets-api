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
