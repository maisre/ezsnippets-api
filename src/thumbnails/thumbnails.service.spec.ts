import { ThumbnailsService } from './thumbnails.service';

describe('ThumbnailsService', () => {
  let service: ThumbnailsService;
  let send: jest.Mock;

  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'test';
    process.env.AWS_SECRET_ACCESS_KEY = 'test';
    process.env.AWS_REGION = 'us-east-1';
    service = new ThumbnailsService();
    send = jest.fn().mockResolvedValue({});
    (service as any).s3.send = send;
  });

  it('deletes the key ez-background writes', async () => {
    await service.remove('org1', 'layout', 'abc');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.Key).toBe(
      'thumbnails/org1/layout/abc.webp',
    );
  });

  it('never throws when S3 fails', async () => {
    send.mockRejectedValue(new Error('AccessDenied'));
    await expect(service.remove('org1', 'page', 'abc')).resolves.toBeUndefined();
    await expect(
      service.removeAllForOrg('org1', 'page'),
    ).resolves.toBeUndefined();
  });

  it('deletes every object under the org and type, across list pages', async () => {
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'thumbnails/org1/page/a.webp' }],
        IsTruncated: true,
        NextContinuationToken: 't',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [{ Key: 'thumbnails/org1/page/b.webp' }],
      })
      .mockResolvedValueOnce({});
    await service.removeAllForOrg('org1', 'page');

    const inputs = send.mock.calls.map((c) => c[0].input);
    expect(inputs[0].Prefix).toBe('thumbnails/org1/page/');
    expect(inputs[1].Delete.Objects).toEqual([
      { Key: 'thumbnails/org1/page/a.webp' },
    ]);
    expect(inputs[2].ContinuationToken).toBe('t');
    expect(inputs[3].Delete.Objects).toEqual([
      { Key: 'thumbnails/org1/page/b.webp' },
    ]);
  });

  it('sends no delete when the org has no thumbnails', async () => {
    await service.removeAllForOrg('org1', 'layout');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
