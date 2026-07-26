import { z } from 'zod';

export const userIdSchema = z.object({
  id: z.string().regex(/^\d+$/, { message: 'Invalid user ID format' })
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  email: z.email().toLowerCase().trim().max(255).optional(),
  role: z.enum(['user', 'admin']).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update'
});