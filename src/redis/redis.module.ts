import { Global, Module, OnModuleDestroy, Inject } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-yet';
import Redis from 'ioredis';
import { redisProviders } from './redis.providers';
import { RedisPubSubService } from './redis-pubsub.service';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: async () => ({
        store: await redisStore({
          socket: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379', 10),
          },
          password: process.env.REDIS_PASSWORD || undefined,
          database: parseInt(process.env.REDIS_DB || '0', 10),
          ttl: parseInt(process.env.CACHE_TTL || '300', 10) * 1000, // Convert to ms
        }),
      }),
    }),
  ],
  providers: [...redisProviders, RedisPubSubService],
  exports: [
    CacheModule,
    ...redisProviders,
    RedisPubSubService,
    REDIS_PUBLISHER,
    REDIS_SUBSCRIBER,
  ],
})
export class RedisModule implements OnModuleDestroy {
  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Connections are closed via RedisPubSubService.onModuleDestroy
    // This hook ensures module-level cleanup if needed
  }
}

