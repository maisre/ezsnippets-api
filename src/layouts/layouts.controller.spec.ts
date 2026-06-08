import { Test, TestingModule } from '@nestjs/testing';
import { LayoutsController } from './layouts.controller';

describe('LayoutsController', () => {
  let controller: LayoutsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LayoutsController],
    })
      .useMocker((token) => (typeof token === 'string' ? 'test' : {}))
      .compile();

    controller = module.get<LayoutsController>(LayoutsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

