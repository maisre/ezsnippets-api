import { BadRequestException } from '@nestjs/common';
import { UploadsService } from './uploads.service';

describe('UploadsService', () => {
  let service: UploadsService;

  beforeEach(() => {
    // getSignedUrl resolves credentials from the default chain; give it dummy
    // creds + a known CDN base so assetUrl is deterministic.
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    process.env.ASSETS_CDN_URL = 'https://assets.example.com/';
    service = new UploadsService();
    // Don't hit S3 in markSaved.
    (service as any).s3.send = jest.fn().mockResolvedValue({});
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createPresignedUpload', () => {
    it('rejects an unsupported content type', async () => {
      await expect(
        service.createPresignedUpload('org1', 'application/pdf'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing org', async () => {
      await expect(
        service.createPresignedUpload('', 'image/png'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns an org-scoped key, presigned url, and cdn assetUrl', async () => {
      const res = await service.createPresignedUpload('org1', 'image/png');
      expect(res.key).toMatch(/^uploads\/org1\/[a-f0-9-]+\.png$/);
      expect(res.uploadUrl).toContain('https://');
      expect(res.assetUrl).toBe(`https://assets.example.com/${res.key}`);
      expect(res.maxBytes).toBe(5 * 1024 * 1024);
      // POST policy fields the client echoes back to S3.
      expect(res.fields['Content-Type']).toBe('image/png');
      expect(res.fields.tagging).toContain('<Value>temp</Value>');
      expect(res.fields.key).toBe(res.key);
    });
  });

  describe('markSaved', () => {
    it('only tags keys scoped to the org and ignores others', async () => {
      const saved = await service.markSaved('org1', [
        'uploads/org1/a.png',
        'uploads/org2/b.png',
      ]);
      expect(saved).toEqual(['uploads/org1/a.png']);
      expect((service as any).s3.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('extractUploadKeys', () => {
    it('pulls org-scoped upload keys out of content', () => {
      const html =
        '<img src="https://assets.example.com/uploads/org1/a.png"><img src="https://assets.example.com/uploads/org1/a.png"><img src="https://x/uploads/org2/c.png">';
      expect(service.extractUploadKeys(html, 'org1')).toEqual([
        'uploads/org1/a.png',
      ]);
    });
  });
});
