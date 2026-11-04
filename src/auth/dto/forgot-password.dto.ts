import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
  // Trimmed and lower-cased before validation, so ' Foo@x.com' is fine.
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
