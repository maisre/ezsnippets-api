import {
  IsArray,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsObject,
} from 'class-validator';
import type { SubPage } from '../interfaces/page-content.interface';
import type { SnippetAbstract } from '../../pages/interfaces/snippet-abstract.interface';

export class CreateLayoutDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsObject()
  @IsOptional()
  nav?: SnippetAbstract;

  @IsObject()
  @IsOptional()
  footer?: SnippetAbstract;

  @IsArray()
  @IsOptional()
  pageContent?: SubPage[];

  @IsString()
  @IsOptional()
  projectId?: string;
}
