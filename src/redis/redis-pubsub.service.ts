import {
  Injectable,
  Inject,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_PUBLISHER, REDIS_SUBSCRIBER } from './redis.constants';

type MessageHandler<T = unknown> = (message: T, channel: string) => void;

@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private readonly handlers = new Map<string, MessageHandler[]>();

  constructor(
    @Inject(REDIS_PUBLISHER) private readonly publisher: Redis,
    @Inject(REDIS_SUBSCRIBER) private readonly subscriber: Redis,
  ) {
    this.initializeSubscriber();
  }

  private initializeSubscriber(): void {
    this.subscriber.on('message', (channel: string, message: string) => {
      const handlers = this.handlers.get(channel);
      if (!handlers?.length) return;

      try {
        const parsed = JSON.parse(message);
        handlers.forEach((handler) => handler(parsed, channel));
      } catch (error) {
        this.logger.error(`Failed to parse message on channel ${channel}:`, error);
      }
    });

    this.subscriber.on('error', (error) => {
      this.logger.error('Redis subscriber error:', error);
    });

    this.publisher.on('error', (error) => {
      this.logger.error('Redis publisher error:', error);
    });
  }

  async publish<T>(channel: string, message: T): Promise<number> {
    const serialized = JSON.stringify(message);
    return this.publisher.publish(channel, serialized);
  }

  async subscribe<T = unknown>(
    channel: string,
    handler: MessageHandler<T>,
  ): Promise<void> {
    const existingHandlers = this.handlers.get(channel);

    if (existingHandlers) {
      existingHandlers.push(handler as MessageHandler);
    } else {
      this.handlers.set(channel, [handler as MessageHandler]);
      await this.subscriber.subscribe(channel);
      this.logger.log(`Subscribed to channel: ${channel}`);
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    await this.subscriber.unsubscribe(channel);
    this.logger.log(`Unsubscribed from channel: ${channel}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing Redis connections...');

    const channels = Array.from(this.handlers.keys());
    if (channels.length > 0) {
      await this.subscriber.unsubscribe(...channels);
    }
    this.handlers.clear();

    await Promise.all([
      this.publisher.quit(),
      this.subscriber.quit(),
    ]);

    this.logger.log('Redis connections closed');
  }
}

