import {
  Body,
  Controller,
  Headers,
  HttpCode,
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

  // Bills an org the caller owns — see createCheckoutSession for which one.
  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckoutSession(
    @Request() req,
    @Body() body: { priceId: string },
  ) {
    return this.paymentService.createCheckoutSession(
      req.user.userId,
      req.user.email,
      body?.priceId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('upgrade/preview')
  async previewUpgrade(@Request() req, @Body() body: { priceId: string }) {
    return this.paymentService.previewUpgrade(req.user.userId, body?.priceId);
  }

  // Moves the caller's personal subscription onto a new team org.
  @UseGuards(JwtAuthGuard)
  @Post('upgrade')
  async upgrade(@Request() req, @Body() body: { priceId: string }) {
    return this.paymentService.upgradeToTeam(
      req.user.userId,
      req.user.email,
      body?.priceId,
    );
  }

  // Owner-only — enforced in the service, which has the org membership.
  @UseGuards(JwtAuthGuard)
  @Post('portal-session')
  async createPortalSession(@Request() req) {
    return this.paymentService.createPortalSession(
      req.user.activeOrg,
      req.user.userId,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel-subscription')
  async cancelSubscription(@Request() req) {
    return this.paymentService.cancelSubscription(
      req.user.activeOrg,
      req.user.userId,
    );
  }

  // Paddle documents expecting a 200; Nest would otherwise return 201 for a
  // POST. Any 2xx may well be accepted, but there's no reason to find out.
  @HttpCode(200)
  @Post('webhook')
  async handleWebhook(
    @Headers('paddle-signature') signature: string,
    @RawBody() payload: Buffer,
  ) {
    return this.paymentService.handleWebhook(signature, payload);
  }
}
