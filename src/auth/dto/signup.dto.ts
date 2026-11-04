import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SignupDto {
  // Trimmed and lower-cased before validation, so ' Foo@x.com' is fine.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(254)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  // bcrypt only reads the first 72 bytes; a cap also keeps hashing cheap.
  @MaxLength(128)
  password: string;

  // Optional, client-supplied attribution. Not validated here (ez-api has no
  // global ValidationPipe, and signup's doesn't whitelist);
  // sanitizeAcquisition() is what makes it safe.
  acquisition?: unknown;
}
