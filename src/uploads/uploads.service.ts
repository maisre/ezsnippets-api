import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { S3Client, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'crypto';

// Allowed image content-types -> file extension. SVG is intentionally excluded
// (it can carry script and would be served from our asset domain).
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Tag applied at upload time. The S3 lifecycle rule expires objects still
// tagged lifecycle=temp after 7 days; markSaved() flips it to lifecycle=saved.
// As a presigned-POST field, tagging must be an XML <Tagging> document rather
// than the key=value form the x-amz-tagging PUT header takes.
const TEMP_TAGGING_XML =
  '<Tagging><TagSet><Tag><Key>lifecycle</Key><Value>temp</Value></Tag></TagSet></Tagging>';
const PRESIGN_TTL_SECONDS = 300; // 5 minutes
// Hard cap enforced by S3 via the presigned-POST content-length-range
// condition: an over-size upload is rejected with 400 EntityTooLarge, so a
// tampered client can't bypass it. The frontend also checks maxBytes up front
// for a friendlier error before the upload starts.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  assetUrl: string;
  // Form fields the client must append (in order) before the file when POSTing
  // to uploadUrl as multipart/form-data. The file must be appended last.
  fields: Record<string, string>;
  maxBytes: number;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly s3: S3Client;
  private readonly bucket = process.env.ASSETS_BUCKET || 'ez-snippet-assets';
  private readonly cdnUrl = (process.env.ASSETS_CDN_URL || '').replace(
    /\/+$/,
    '',
  );

  constructor() {
    // AWS_ENDPOINT_URL is only set when pointing at LocalStack. There we must
    // also force path-style addressing: LocalStack can't route a presigned POST
    // sent to the virtual-host URL (bucket.localhost:4566) and answers with
    // "Unable to find operation for request to service s3: POST /". Real S3
    // keeps virtual-host addressing, so this stays a local-only branch.
    const endpoint = process.env.AWS_ENDPOINT_URL;
    this.s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });
  }

  async createPresignedUpload(
    orgId: string,
    contentType: string,
  ): Promise<PresignedUpload> {
    if (!orgId) {
      throw new BadRequestException('No active org for upload');
    }
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
      throw new BadRequestException(`Unsupported image type: ${contentType}`);
    }

    const key = `uploads/${orgId}/${randomUUID()}.${ext}`;
    // Presigned POST (not PUT) so the content-length-range condition is part of
    // the signed policy and enforced by S3. Every value in Fields is also added
    // as an exact-match condition, so the client can't swap the key, type, or
    // tag without breaking the signature.
    const { url, fields } = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]],
      Fields: {
        'Content-Type': contentType,
        tagging: TEMP_TAGGING_XML,
      },
      Expires: PRESIGN_TTL_SECONDS,
    });

    return {
      key,
      uploadUrl: url,
      assetUrl: this.assetUrl(key),
      fields,
      maxBytes: MAX_UPLOAD_BYTES,
    };
  }

  // Flip referenced uploads from temp -> saved so the lifecycle rule keeps
  // them. Only keys scoped to this org are accepted.
  async markSaved(orgId: string, keys: string[]): Promise<string[]> {
    const prefix = `uploads/${orgId}/`;
    const scoped = keys.filter((k) => k.startsWith(prefix));
    const rejected = keys.filter((k) => !k.startsWith(prefix));
    if (rejected.length) {
      this.logger.warn(
        `Refusing to tag ${rejected.length} key(s) outside org ${orgId}`,
      );
    }

    await Promise.all(
      scoped.map((key) =>
        this.s3
          .send(
            new PutObjectTaggingCommand({
              Bucket: this.bucket,
              Key: key,
              Tagging: { TagSet: [{ Key: 'lifecycle', Value: 'saved' }] },
            }),
          )
          .catch((err: unknown) =>
            this.logger.warn(`Failed to tag saved for ${key}: ${String(err)}`),
          ),
      ),
    );
    return scoped;
  }

  // Build the public display URL for an object key. Falls back to an s3:// URI
  // if ASSETS_CDN_URL is not configured (see assets-CDN-config story).
  assetUrl(key: string): string {
    return this.cdnUrl
      ? `${this.cdnUrl}/${key}`
      : `s3://${this.bucket}/${key}`;
  }

  // Pull uploads/<orgId>/... object keys referenced in a content blob. Lets a
  // future server-side save hook tag images without trusting the client list.
  extractUploadKeys(content: string, orgId: string): string[] {
    if (!content) return [];
    const re = new RegExp(`uploads/${orgId}/[A-Za-z0-9.\\-_/]+`, 'g');
    return Array.from(new Set(content.match(re) ?? []));
  }
}
