import {
  Body,
  Controller,
  Headers,
  Post,
  RawBody,
  Request,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckoutSession(
    @Request() req,
    @Body() body: { priceId: string },
  ) {
    return this.paymentService.createCheckoutSession(
      req.user.activeOrg,
      body.priceId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel-subscription')
  async cancelSubscription(@Request() req) {
    return this.paymentService.cancelSubscription(req.user.activeOrg);
  }

  @Post('webhook')
  async handleWebhook(
    @Headers('paddle-signature') signature: string,
    @RawBody() payload: Buffer,
  ) {
    return this.paymentService.handleWebhook(signature, payload);
  }
}
