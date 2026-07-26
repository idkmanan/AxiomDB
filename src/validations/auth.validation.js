import { z } from 'zod';

export const signupSchema = z.object({
  name: z.string().trim().min(2).max(225),
  email: z.email().toLowerCase().trim().max(255),
  password: z.string().min(6).max(128),
  role: z.enum(['user', 'admin']).default('user')
});

export const signinSchema = z.object({
  email: z.email().toLowerCase().trim(),
  password: z.string().min(1)
});