import { Test, TestingModule } from '@nestjs/testing';
import { PagesController } from './pages.controller';

describe('PagesController', () => {
  let controller: PagesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PagesController],
    })
      .useMocker((token) => (typeof token === 'string' ? 'test' : {}))
      .compile();

    controller = module.get<PagesController>(PagesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
