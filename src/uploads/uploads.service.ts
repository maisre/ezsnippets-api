import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  PutObjectTaggingCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
const TEMP_TAG = 'lifecycle=temp';
const PRESIGN_TTL_SECONDS = 300; // 5 minutes
// Advisory cap returned to clients. Hard enforcement at S3 requires a presigned
// POST policy (content-length-range); PUT can't enforce size on its own. The
// frontend checks this before uploading. See follow-up note in the tracker.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  assetUrl: string;
  headers: Record<string, string>;
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
    this.s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
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
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      Tagging: TEMP_TAG,
    });
    const uploadUrl = await getSignedUrl(this.s3, command, {
      expiresIn: PRESIGN_TTL_SECONDS,
    });

    return {
      key,
      uploadUrl,
      assetUrl: this.assetUrl(key),
      // The client MUST send exactly these headers on the PUT or the signature
      // won't match.
      headers: { 'Content-Type': contentType, 'x-amz-tagging': TEMP_TAG },
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
