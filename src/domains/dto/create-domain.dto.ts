import { IsNotEmpty, IsString } from 'class-validator';

export class CreateDomainDto {
  /**
   * Raw customer input. Normalised and validated in DomainsService.create via
   * hostname-rules — they paste URLs, trailing dots and mixed case.
   */
  @IsString()
  @IsNotEmpty()
  hostname: string;
}
