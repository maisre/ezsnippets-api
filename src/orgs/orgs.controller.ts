import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { JwtAuthGuard } from '../auth/jwt.strategy';
import { Org } from './interfaces/org.interface';

@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(@Request() req): Promise<Org[]> {
    return this.orgsService.findOrgsForUser(req.user.userId);
  }
}
