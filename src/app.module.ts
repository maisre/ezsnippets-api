import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PagesController } from './pages/pages.controller';
import { SnippetsModule } from './snippets/snippets.module';

@Module({
  imports: [AuthModule, UsersModule, SnippetsModule],
  controllers: [AppController, PagesController],
  providers: [AppService],
})
export class AppModule {}
