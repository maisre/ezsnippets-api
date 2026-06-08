import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    })
      .useMocker((token) => (typeof token === 'string' ? 'test' : {}))
      .compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return the hello payload', () => {
      expect(appController.getHello()).toBe(JSON.stringify({ person: 'hello' }));
    });
  });
});
