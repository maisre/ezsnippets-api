import { IsArray, IsOptional, IsString, IsObject } from 'class-validator';
import type { SubPage } from '../interfaces/page-content.interface';
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
  subPages?: SubPage[];

  @IsString()
  @IsOptional()
  projectId?: string;
}
