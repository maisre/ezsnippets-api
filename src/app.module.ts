import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PagesModule } from './pages/pages.module';
import { SnippetsModule } from './snippets/snippets.module';
import { PaymentsModule } from './payments/payments.module';
import { LayoutsModule } from './layouts/layouts.module';

@Module({
  imports: [
    AuthModule,
    UsersModule,
    PagesModule,
    SnippetsModule,
    PaymentsModule.forRootAsync(),
    LayoutsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
