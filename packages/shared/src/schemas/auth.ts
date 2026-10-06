import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }));

/** Indian mobile: 10 digits starting 6–9, optional +91 / 0 prefix. Normalised to +91XXXXXXXXXX. */
export const indianPhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+91|0)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number')
  .transform((v) => `+91${v.slice(-10)}`);

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Include at least one letter and one number');

export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email: emailSchema,
  phone: indianPhoneSchema.optional(),
  password: passwordSchema,
  referralCode: z.string().trim().toUpperCase().max(32).optional(),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(128),
});
export type SignInInput = z.infer<typeof signInSchema>;

export const tokenSchema = z.object({ token: z.string().min(16).max(256) });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(256),
  password: passwordSchema,
});

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  hasPassword: boolean;
  preferredSize: string | null;
  referralCode: string;
}

export interface MeResponse {
  user: SessionUser | null;
}
