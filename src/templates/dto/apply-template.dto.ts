import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ApplyTemplateDto {
  /**
   * `append` adds the template's snippets after what's already there;
   * `replace` swaps the whole list. Defaults to append, which is the
   * non-destructive choice — a user who meant replace can clear first, but a
   * user who loses their work to a mis-click can't undo it.
   */
  @IsIn(['append', 'replace'])
  @IsOptional()
  mode?: 'append' | 'replace';

  /**
   * Layouts only: which subpage a partial/page template lands in. Omitted for
   * a layout-kind template, which replaces nav, footer and subpages wholesale.
   */
  @IsInt()
  @Min(0)
  @IsOptional()
  subPageIndex?: number;
}

export class CreateFromTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  siteName?: string;

  @IsString()
  @IsOptional()
  description?: string;
}
