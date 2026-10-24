import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class SignupDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  // Optional, client-supplied attribution. Not validated here (ez-api has no
  // ValidationPipe); sanitizeAcquisition() is what makes it safe.
  acquisition?: unknown;
}
