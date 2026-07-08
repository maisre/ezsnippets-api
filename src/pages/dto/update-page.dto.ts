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

  @IsIn(['lorem', 'generic', 'customized'])
  @IsOptional()
  textVariant?: 'lorem' | 'generic' | 'customized';

  @IsArray()
  @IsOptional()
  snippets?: SnippetAbstract[];
}
