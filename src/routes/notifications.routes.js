import express from 'express';
import { z } from 'zod';
import { parseOr400 } from '#utils/http-validate.js';
import { authenticate } from '#middleware/auth.middleware.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';
import { listNotifications, markNotificationRead } from '#services/notifications.service.js';
import config from '#config/env.js';

const router = express.Router();

// Same ordering rule as the other routers: authenticate first, then the limiter, so `req.user`
// exists and the per-role ceiling means something.
router.use(authenticate);
router.use(rateLimit('authenticated'));

const listQuerySchema = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.pagination.maxLimit)
    .default(config.pagination.defaultLimit),
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const idSchema = z.strictObject({
  id: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .refine((n) => n >= 1 && n <= Number.MAX_SAFE_INTEGER),
});

router.get('/', async (req, res, next) => {
  try {
    const query = parseOr400(listQuerySchema, req.query, res, req, 'list notifications');
    if (!query) return;

    // Always the caller's own. There is no admin view here on purpose: reading someone else's
    // notifications is a different feature with a different justification, and the safest version
    // of a feature nobody asked for is the one that does not exist.
    const result = await listNotifications({
      userId: req.user.id,
      limit: query.limit,
      before: query.before,
      unreadOnly: query.unread === true,
    });

    res.json({ message: 'Successfully retrieved notifications', ...result });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const params = parseOr400(idSchema, req.params, res, req, 'mark notification read');
    if (!params) return;

    const notification = await markNotificationRead({ id: params.id, userId: req.user.id });
    res.json({ message: 'Notification marked read', notification });
  } catch (e) {
    next(e);
  }
});

export default router;
