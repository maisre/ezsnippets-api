import './instrument';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { TRUST_PROXY } from './common/trust-proxy';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Real client IP behind Caddy (rate limits key on it). See TRUST_PROXY.
  app.set('trust proxy', TRUST_PROXY);

  app.use(cookieParser());

  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);
  // credentials:true so browsers send/accept the ez_session cookie on
  // cross-origin requests (e.g. the editor on view.* calling /uploads/*).
  app.enableCors({ origin: allowedOrigins, credentials: true });

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
