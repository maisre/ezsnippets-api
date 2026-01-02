import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';

const getRedisConfig = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: null,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  lazyConnect: false,
});

export const redisProviders: Provider[] = [
  {
    provide: REDIS_PUBLISHER,
    useFactory: (): Redis => new Redis(getRedisConfig()),
  },
  {
    provide: REDIS_SUBSCRIBER,
    useFactory: (): Redis => new Redis(getRedisConfig()),
  },
];

