import {
  Body,
  Controller,
  Get,
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
    @Body() body: { priceId: string; successUrl: string; cancelUrl: string },
  ) {
    return this.paymentService.createCheckoutSession(
      req.user.activeOrg,
      body.priceId,
      body.successUrl,
      body.cancelUrl,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('cancel-subscription')
  async cancelSubscription(@Request() req) {
    return this.paymentService.cancelSubscription(req.user.activeOrg);
  }

  @Post('webhook')
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @RawBody() payload: Buffer,
  ) {
    return this.paymentService.handleWebhook(signature, payload);
  }

  @Get('products')
  async getProducts() {
    return this.paymentService.getProducts();
  }

  @Get('customers')
  async getCustomers() {
    return this.paymentService.getCustomers();
  }

  @Post('create-payment-intent')
  async createPaymentIntent(
    @Body() body: { amount: number; currency: string },
  ) {
    const { amount, currency } = body;
    return this.paymentService.createPaymentIntent(amount, currency);
  }

  @Post('subscriptions')
  async createSubscription(
    @Body() body: { customerId: string; priceId: string },
  ) {
    const { customerId, priceId } = body;
    return this.paymentService.createSubscription(customerId, priceId);
  }

  @Post('customers')
  async createCustomer(@Body() body: { email: string; name: string }) {
    return this.paymentService.createCustomer(body.email, body.name);
  }

  @Post('products')
  async createProduct(
    @Body() body: { name: string; description: string; price: number },
  ) {
    return this.paymentService.createProduct(
      body.name,
      body.description,
      body.price,
    );
  }

  @Post('refunds')
  async refundPayment(@Body() body: { paymentIntentId: string }) {
    return this.paymentService.refundPayment(body.paymentIntentId);
  }

  @Post('payment-links')
  async createPaymentLink(@Body() body: { priceId: string }) {
    return this.paymentService.createPaymentLink(body.priceId);
  }

  @Get('balance')
  async getBalance() {
    return this.paymentService.getBalance();
  }
}
