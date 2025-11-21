import { IsArray, IsOptional, IsString, IsObject } from 'class-validator';
import type { PageContent } from '../interfaces/page-content.interface';
import type { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export class UpdateLayoutDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  nav?: SnippetAbstract;

  @IsObject()
  @IsOptional()
  footer?: SnippetAbstract;

  @IsArray()
  @IsOptional()
  pageContent?: PageContent[];

  @IsString()
  @IsOptional()
  projectId?: string;
}
