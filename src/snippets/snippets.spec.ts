import { Test, TestingModule } from '@nestjs/testing';
import { Snippets } from './snippets';

describe('Snippets', () => {
  let provider: Snippets;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [Snippets],
    }).compile();

    provider = module.get<Snippets>(Snippets);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });
});
