import { BadRequestException, HttpException } from '@nestjs/common';
import { FeedbackService, MAX_MESSAGE_LENGTH, MAX_PER_HOUR } from './feedback.service';

describe('FeedbackService', () => {
  const user = { userId: '64b000000000000000000001', email: 'a@b.co', activeOrg: '64b000000000000000000002' };
  let model: { countDocuments: jest.Mock; create: jest.Mock };
  let service: FeedbackService;

  beforeEach(() => {
    model = { countDocuments: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) };
    service = new FeedbackService(model as any);
  });

  it('saves trimmed feedback with its context', async () => {
    await service.create(
      {
        kind: 'snippet',
        reason: 'broken',
        message: '  The button overlaps  ',
        snippet: 'abc',
        context: { page: 'p1', snippetIds: ['abc', '', 'def', 42 as any] },
      },
      user,
    );
    const saved = model.create.mock.calls[0][0];
    expect(saved).toMatchObject({
      user: user.userId,
      org: user.activeOrg,
      email: 'a@b.co',
      kind: 'snippet',
      reason: 'broken',
      message: 'The button overlaps',
      snippet: 'abc',
      context: { page: 'p1', snippetIds: ['abc', 'def'] },
    });
  });

  it('drops a reason on non-snippet feedback', async () => {
    await service.create({ kind: 'idea', reason: 'broken', message: 'Dark mode' }, user);
    expect(model.create.mock.calls[0][0].reason).toBeUndefined();
  });

  it('rejects an unknown kind, an empty message and an overlong one', async () => {
    await expect(service.create({ kind: 'rant', message: 'x' }, user)).rejects.toThrow(BadRequestException);
    await expect(service.create({ kind: 'bug', message: '   ' }, user)).rejects.toThrow(BadRequestException);
    await expect(
      service.create({ kind: 'bug', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, user),
    ).rejects.toThrow(BadRequestException);
    expect(model.create).not.toHaveBeenCalled();
  });

  it('rate-limits per user per hour', async () => {
    model.countDocuments.mockResolvedValue(MAX_PER_HOUR);
    await expect(service.create({ kind: 'bug', message: 'again' }, user)).rejects.toThrow(HttpException);
    expect(model.create).not.toHaveBeenCalled();
  });
});
