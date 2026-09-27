import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { FavoriteSnippet } from './interfaces/org.interface';

const OWNER_ONLY_FIELDS = [
  'paddleCustomerId',
  'cardBrand',
  'cardLast4',
  'cardExpMonth',
  'cardExpYear',
];

@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  // Every workspace the caller belongs to, each tagged with their `role` in it
  // and `active` for the one their token is scoped to. Billing fields are
  // owner-only: a team member has no business seeing the owner's card.
  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Request() req): Promise<Record<string, unknown>[]> {
    const orgs = await this.orgsService.findOrgsForUser(req.user.userId);
    return orgs.map((org) => {
      const json = org.toJSON() as Record<string, unknown>;
      const role = org.members.find(
        (m) => String(m.user) === req.user.userId,
      )?.role;
      if (role !== 'owner') {
        for (const field of OWNER_ONLY_FIELDS) delete json[field];
      }
      return {
        ...json,
        role,
        active: String(org._id) === String(req.user.activeOrg),
      };
    });
  }

  // Favorites hang off the caller's active org, the same way pages and layouts
  // do — the star is a property of the workspace, not of whoever clicked it.
  //
  // These literal routes must stay above any `@Get(':id')` added later, or Nest
  // matches 'favorites' as an org id and this becomes a confusing 404.

  @UseGuards(JwtAuthGuard)
  @Get('favorites')
  async listFavorites(
    @Request() req,
  ): Promise<{ favorites: FavoriteSnippet[] }> {
    const favorites = await this.orgsService.listFavorites(req.user.activeOrg);
    return { favorites };
  }

  // There is no global ValidationPipe in this service (ez-view has one, we
  // don't), so a DTO with class-validator decorators would be inert here and
  // the body arrives exactly as sent. Check it by hand.
  @UseGuards(JwtAuthGuard)
  @Post('favorites')
  async addFavorite(
    @Request() req,
    @Body() body: { snippetId?: string },
  ): Promise<{ favorites: FavoriteSnippet[] }> {
    const snippetId = body?.snippetId;
    if (typeof snippetId !== 'string' || !snippetId.trim()) {
      throw new BadRequestException('snippetId is required');
    }
    const favorites = await this.orgsService.addFavorite(
      req.user.activeOrg,
      req.user.userId,
      snippetId.trim(),
    );
    return { favorites };
  }

  // 200 with the new list rather than 204: the client re-renders the palette
  // from the response, and unstarring something that was already gone is a
  // success here, so there is nothing for it to infer from a bare status.
  @UseGuards(JwtAuthGuard)
  @Delete('favorites/:snippetId')
  async removeFavorite(
    @Param('snippetId') snippetId: string,
    @Request() req,
  ): Promise<{ favorites: FavoriteSnippet[] }> {
    const favorites = await this.orgsService.removeFavorite(
      req.user.activeOrg,
      snippetId,
    );
    return { favorites };
  }
}
