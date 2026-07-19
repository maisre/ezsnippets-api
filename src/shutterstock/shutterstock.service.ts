import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ShutterstockImage, ImageSearchResult } from './interfaces';

// Shutterstock search responses are watermarked preview comps. That is
// deliberate: pages are mockups shown to a client for approval, and licensing
// happens afterwards — the end customer buys the licenses themselves. This is
// why every selected image's `id` must be retained (see imageReplacementOverride
// on the page snippet abstract): the id list is what a licensing hand-off is
// assembled from later. A comp URL alone can't be traced back to an asset.
interface ShutterstockApiResponse {
  page: number;
  per_page: number;
  total_count: number;
  search_id: string;
  data: ShutterstockApiImage[];
}

interface ShutterstockApiImage {
  id: string;
  description: string;
  aspect: number;
  image_type: string;
  assets: {
    preview?: {
      url: string;
      width: number;
      height: number;
    };
  };
}

const SEARCH_TIMEOUT_MS = 10_000;

@Injectable()
export class ShutterstockService {
  private readonly logger = new Logger(ShutterstockService.name);
  private readonly apiToken = process.env.SHUTTERSTOCK_API_TOKEN || '';
  private readonly baseUrl =
    process.env.SHUTTERSTOCK_BASE_URL || 'https://api.shutterstock.com/v2';

  constructor() {
    if (!this.apiToken) {
      this.logger.warn(
        'SHUTTERSTOCK_API_TOKEN is not configured. Image search will fail.',
      );
    }
  }

  get isConfigured(): boolean {
    return !!this.apiToken;
  }

  /**
   * Search Shutterstock for preview comps matching `query`.
   *
   * Unlike the previous ez-view implementation this has a hard timeout: image
   * search runs in a loop over every image token on a page, so one hung request
   * would otherwise stall the whole customize-images call.
   */
  async searchImages(
    query: string,
    perPage: number = 9,
  ): Promise<ImageSearchResult> {
    if (!this.apiToken) {
      this.logger.error('Shutterstock API token is not configured');
      throw new UnauthorizedException(
        'Shutterstock API token is not configured',
      );
    }

    const searchParams = new URLSearchParams({
      query,
      per_page: perPage.toString(),
      view: 'full',
    });
    const url = `${this.baseUrl}/images/search?${searchParams.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'User-Agent': 'ez-snippet/1.0',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        await this.handleApiError(response);
      }

      const data: ShutterstockApiResponse = await response.json();

      const images: ShutterstockImage[] = data.data
        .filter((img) => img.assets?.preview)
        .map((img) => ({
          id: img.id,
          description: img.description || '',
          previewUrl: img.assets.preview!.url,
          width: img.assets.preview!.width,
          height: img.assets.preview!.height,
          aspect: img.aspect,
        }));

      return {
        success: true,
        query,
        totalCount: data.total_count,
        images,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error('Failed to search Shutterstock images', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query,
      });

      throw new ServiceUnavailableException(
        'Unable to connect to Shutterstock API. Please try again later.',
      );
    }
  }

  /**
   * Search, then return the single result whose aspect ratio best fits the
   * slot. Returns null when the search finds nothing, so callers can leave the
   * slot on its placeholder rather than forcing a bad fit.
   *
   * `targetAspect` of null means no preference — take the top-ranked result,
   * which is Shutterstock's own relevance ordering.
   */
  async findBestMatch(
    query: string,
    targetAspect: number | null,
    perPage = 9,
  ): Promise<ShutterstockImage | null> {
    const { images } = await this.searchImages(query, perPage);
    if (!images.length) return null;
    if (targetAspect === null) return images[0];

    // Compare in log space so "twice as wide as wanted" and "half as wide"
    // score as equally bad; a linear diff would bias toward wide crops.
    let best = images[0];
    let bestDistance = Infinity;
    for (const image of images) {
      const aspect = image.aspect || (image.height ? image.width / image.height : 0);
      if (!aspect) continue;
      const distance = Math.abs(Math.log(aspect / targetAspect));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = image;
      }
    }
    return best;
  }

  private async handleApiError(response: Response): Promise<never> {
    const status = response.status;
    let errorMessage: string;

    try {
      const errorBody = await response.json();
      errorMessage = errorBody.message || errorBody.error || response.statusText;
    } catch {
      errorMessage = response.statusText;
    }

    this.logger.error(`Shutterstock API error: ${status}`, {
      status,
      message: errorMessage,
    });

    switch (status) {
      case 401:
        throw new UnauthorizedException(
          'Invalid Shutterstock API token. Please check your configuration.',
        );

      case 403:
        throw new ForbiddenException(
          'Access to Shutterstock API is forbidden. Please check your API permissions.',
        );

      case 429: {
        const retryAfter = response.headers.get('Retry-After');
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              'Shutterstock API rate limit exceeded. Please try again later.',
            retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      case 502:
      case 503:
      case 504:
        throw new ServiceUnavailableException(
          'Shutterstock API is temporarily unavailable. Please try again later.',
        );

      default:
        throw new HttpException(
          `Shutterstock API error: ${errorMessage}`,
          status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST,
        );
    }
  }
}
