import { IsArray, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { SnippetAbstract } from '../interfaces/snippet-abstract.interface';

export class UpdatePageDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsArray()
  @IsOptional()
  snippets?: SnippetAbstract[];
}
