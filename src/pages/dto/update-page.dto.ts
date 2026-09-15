import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export class UpdatePageDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  siteName?: string;

  @IsString()
  @IsOptional()
  description?: string;

  /**
   * Custom URL segment. Send an empty string to clear it. Normalised and
   * checked against the reserved list in PagesService.update via slug-rules;
   * accepted loosely here so the customer gets a useful message rather than a
   * bare 400 from class-validator.
   */
  @IsString()
  @IsOptional()
  slug?: string | null;

  @IsIn(['lorem', 'generic', 'customized'])
  @IsOptional()
  textVariant?: 'lorem' | 'generic' | 'customized';

  @IsArray()
  @IsOptional()
  snippets?: SnippetAbstract[];
}
