import { BadRequestException } from '@nestjs/common';

/**
 * Scratch pad request bodies.
 *
 * Every field is an index, never a snippet body — the move itself happens
 * server-side against the stored document (see PagesService's scratch pad
 * block for why).
 *
 * ez-api has no global ValidationPipe, unlike ez-view, so these are checked by
 * the helper below rather than by class-validator decorators that would never
 * fire. Getting this wrong would mean `undefined` reaching an array splice and
 * surfacing as a 500 on what is really a malformed request.
 */
export class ParkSnippetDto {
  index: number;
}

export class RestoreSnippetDto {
  scratchIndex: number;
  /** Omitted means "append". */
  toIndex?: number;
}

export class ReorderScratchPadDto {
  from: number;
  to: number;
}

export class LayoutParkSnippetDto {
  subPageIndex: number;
  index: number;
}

export class LayoutRestoreSnippetDto {
  scratchIndex: number;
  subPageIndex: number;
  toIndex?: number;
}

/**
 * Require a body field to be a non-negative integer.
 *
 * Returns the value so call sites read as assignments. Rejects the JSON that
 * actually shows up in practice — a numeric string from a hand-rolled fetch, a
 * float from a bad calculation, or a missing field entirely.
 */
export function requireIndex(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(
      `"${field}" must be a non-negative integer.`,
    );
  }
  return value;
}

/** Same, but for an optional insertion point. */
export function optionalIndex(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireIndex(value, field);
}
