import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PagesModule } from './pages/pages.module';
import { SnippetsModule } from './snippets/snippets.module';

@Module({
  imports: [AuthModule, UsersModule, PagesModule, SnippetsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
