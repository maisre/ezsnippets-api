import { Global, Module } from '@nestjs/common';
import { SqsService } from './sqs.service.js';

@Global()
@Module({
  providers: [SqsService],
  exports: [SqsService],
})
export class SqsModule {}
