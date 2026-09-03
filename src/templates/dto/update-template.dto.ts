import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Only the labelling is editable. Changing the snippets of a saved template
 * would silently change what everyone on the org gets next time they use it —
 * saving a new one is clearer and costs nothing.
 */
export class UpdateTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  type?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
