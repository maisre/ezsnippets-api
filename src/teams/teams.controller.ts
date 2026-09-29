import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { SESSION_COOKIE, sessionCookieOptions } from '../auth/session-cookie';
import { TeamsService } from './teams.service';

// No global ValidationPipe in this service — bodies arrive exactly as sent, and
// TeamsService validates every field it reads.
//
// Every route here is under /orgs/:id and none can shadow OrgsController's
// literal /orgs/favorites routes: the only one-segment route is DELETE, and
// OrgsController has no DELETE /orgs/favorites.
@Controller('orgs/:id')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Get('members')
  getTeam(@Param('id') orgId: string, @Request() req) {
    return this.teamsService.getTeam(orgId, req.user.userId);
  }

  @Patch('name')
  async rename(
    @Param('id') orgId: string,
    @Body() body: { name?: string },
    @Request() req,
  ) {
    const org = await this.teamsService.rename(orgId, req.user.userId, body?.name);
    return { name: org.name };
  }

  @Post('invites')
  invite(
    @Param('id') orgId: string,
    @Body() body: { email?: string; role?: string },
    @Request() req,
  ) {
    return this.teamsService.invite(orgId, req.user.userId, body?.email, body?.role);
  }

  @Delete('invites/:inviteId')
  @HttpCode(204)
  async revokeInvite(
    @Param('id') orgId: string,
    @Param('inviteId') inviteId: string,
    @Request() req,
  ) {
    await this.teamsService.revokeInvite(orgId, req.user.userId, inviteId);
  }

  @Patch('members/:userId')
  @HttpCode(204)
  async setRole(
    @Param('id') orgId: string,
    @Param('userId') userId: string,
    @Body() body: { role?: string },
    @Request() req,
  ) {
    await this.teamsService.setRole(orgId, req.user.userId, userId, body?.role);
  }

  @Post('transfer')
  @HttpCode(204)
  async transferOwnership(
    @Param('id') orgId: string,
    @Body() body: { userId?: string },
    @Request() req,
  ) {
    await this.teamsService.transferOwnership(orgId, req.user.userId, body?.userId);
  }

  @Delete('members/:userId')
  @HttpCode(204)
  async removeMember(
    @Param('id') orgId: string,
    @Param('userId') userId: string,
    @Request() req,
  ) {
    await this.teamsService.removeMember(orgId, req.user.userId, userId);
  }

  // Same token hand-back as leave: the caller's token names the deleted org.
  @Delete()
  async deleteTeam(
    @Param('id') orgId: string,
    @Body() body: { confirmName?: string },
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.teamsService.deleteTeam(
      orgId,
      req.user.userId,
      body?.confirmName,
    );
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }

  // The caller's token names this org, so it dies with their membership; hand
  // back one for their personal org and re-set the editor cookie to match.
  @Post('leave')
  async leave(
    @Param('id') orgId: string,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.teamsService.leave(orgId, req.user.userId);
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }
}

@Controller('invites/:token')
export class InvitesController {
  constructor(private readonly teamsService: TeamsService) {}

  // Public — the token is the credential.
  @Get()
  preview(@Param('token') token: string) {
    return this.teamsService.previewInvite(token);
  }

  @UseGuards(JwtAuthGuard)
  @Post('accept')
  async accept(
    @Param('token') token: string,
    @Request() req,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.teamsService.acceptInvite(
      token,
      req.user.userId,
      req.user.email,
    );
    res.cookie(SESSION_COOKIE, result.access_token, sessionCookieOptions());
    return result;
  }
}
