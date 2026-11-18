import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export type ThumbnailTarget = 'page' | 'layout';

/**
 * Removes dashboard thumbnails when their page or layout is deleted.
 *
 * ez-background writes one image per document at
 * `thumbnails/<orgId>/<type>/<id>.webp` (ScreenshotService.capture — keep the
 * key format in sync) and overwrites it on every re-shot, so a delete is the
 * only thing that can leave a file behind.
 *
 * Every call is best-effort: a failed S3 call is logged and swallowed, because
 * a leftover 20 KB image must never be the reason a delete fails.
 */
@Injectable()
export class ThumbnailsService {
  private readonly logger = new Logger(ThumbnailsService.name);
  private readonly bucket = process.env.ASSETS_BUCKET || 'ez-snippet-assets';
  private readonly s3: S3Client;

  constructor() {
    // Same LocalStack branch as UploadsService.
    const endpoint = process.env.AWS_ENDPOINT_URL;
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  static keyFor(orgId: string, type: ThumbnailTarget, id: string): string {
    return `thumbnails/${orgId}/${type}/${id}.webp`;
  }

  /** Delete one document's thumbnail. Missing objects are not an error. */
  async remove(
    orgId: string,
    type: ThumbnailTarget,
    id: string,
  ): Promise<void> {
    const key = ThumbnailsService.keyFor(orgId, type, id);
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(`Failed to delete ${key}: ${String(err)}`);
    }
  }

  /** Delete every page or layout thumbnail an org has. */
  async removeAllForOrg(orgId: string, type: ThumbnailTarget): Promise<void> {
    const prefix = `thumbnails/${orgId}/${type}/`;
    try {
      let token: string | undefined;
      do {
        const page = await this.s3.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        const objects = (page.Contents ?? [])
          .filter((o) => o.Key)
          .map((o) => ({ Key: o.Key as string }));
        if (objects.length) {
          await this.s3.send(
            new DeleteObjectsCommand({
              Bucket: this.bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          );
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      this.logger.warn(`Failed to delete ${prefix}*: ${String(err)}`);
    }
  }
}
