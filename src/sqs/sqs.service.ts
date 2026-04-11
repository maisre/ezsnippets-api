import { Injectable, Logger } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async sendMessage(queueUrl: string, body: Record<string, any>) {
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
    });

    try {
      const result = await this.client.send(command);
      this.logger.log(`Message sent to ${queueUrl}: ${result.MessageId}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to send message to ${queueUrl}: ${error}`);
      throw error;
    }
  }
}
