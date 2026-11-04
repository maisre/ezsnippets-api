/**
 * Body of POST /feedback. ez-api has no global ValidationPipe, so
 * FeedbackService.create checks and trims every field itself.
 */
export class CreateFeedbackDto {
  kind: string;
  reason?: string;
  message: string;
  snippet?: string;
  context?: {
    url?: string;
    page?: string;
    layout?: string;
    subPage?: string;
    snippetIds?: string[];
    viewport?: string;
    userAgent?: string;
  };
}
