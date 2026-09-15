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

  /**
   * Custom URL segment. Send an empty string to clear it. Validated in
   * LayoutsService.update via common/slug-rules.
   */
  @IsString()
  @IsOptional()
  slug?: string | null;

  @IsString()
  @IsOptional()
  siteName?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
