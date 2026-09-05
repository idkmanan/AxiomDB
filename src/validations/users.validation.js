import { z } from 'zod';
import config from '#config/env.js';

export const userIdSchema = z.strictObject({
  // A digits-only string, then coerced. The regex is doing real work: `parseInt`
  // accepts '12abc' as 12, and `Number('')` is 0, so a permissive parse turns a
  // malformed id into a valid-looking lookup. Bounded at the Postgres `serial`
  // maximum because the column is a 32-bit int — anything larger reaches the
  // database as an out-of-range error (SQLSTATE 22003) rather than a clean 400.
  id: z
    .string()
    .regex(/^\d+$/, { message: 'Invalid user ID format' })
    .transform(Number)
    .refine((n) => n >= 1 && n <= 2147483647, { message: 'User ID out of range' }),
});

/**
 * Query parameters for the paginated list endpoint.
 *
 * Every field is optional with a default, so `GET /api/users` keeps working — and
 * that matters for more than compatibility. The frozen v0 k6 script calls the
 * endpoint with no parameters, so the v0-vs-v1 comparison measures exactly the
 * change being claimed: same request, 1,001 rows before and one page after.
 *
 * The cap is the security-relevant part. Without `maxLimit`, `?limit=1000000`
 * reintroduces the unbounded query as a user-controlled denial of service — an
 * endpoint whose cost is set by the caller. That is a more common bug than the
 * missing LIMIT it replaces, because the pagination looks present.
 */
export const listUsersQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.pagination.maxLimit, {
      message: `limit may not exceed ${config.pagination.maxLimit}`,
    })
    .default(config.pagination.defaultLimit),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const updateUserSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(255).optional(),
    email: z.email().toLowerCase().trim().max(255).optional(),
    // `role` IS accepted here, unlike on signup, because this route is
    // authenticated and src/controllers/users.controller.js rejects a role change
    // from a non-admin before the service is called. The distinction is the whole
    // lesson of the escalation bug: the problem was never that `role` appeared in
    // a schema, it was that it appeared in an UNAUTHENTICATED one.
    role: z.enum(['user', 'admin']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });
