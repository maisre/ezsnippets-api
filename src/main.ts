import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);
  app.enableCors({ origin: allowedOrigins });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
