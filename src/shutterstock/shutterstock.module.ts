import { Module } from '@nestjs/common';
import { ShutterstockService } from './shutterstock.service';

@Module({
  providers: [ShutterstockService],
  exports: [ShutterstockService],
})
export class ShutterstockModule {}
