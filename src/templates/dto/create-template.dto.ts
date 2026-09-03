import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { TemplateKind } from '../interfaces/template.interface';

export class SubPageTemplateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  snippetIds?: string[];
}

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsIn(['partial', 'page', 'layout'])
  kind: TemplateKind;

  @IsString()
  @IsOptional()
  type?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  /** kind: 'partial' | 'page' */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  snippetIds?: string[];

  /** kind: 'layout' — bare snippet ids, matching how layouts store them. */
  @IsString()
  @IsOptional()
  nav?: string;

  @IsString()
  @IsOptional()
  footer?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SubPageTemplateDto)
  subPages?: SubPageTemplateDto[];
}
