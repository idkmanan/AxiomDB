import express from 'express';
import {
  fetchAllUsers,
  getUserById,
  updateUser,
  deleteUser,
} from '#controllers/users.controller.js';
import { authenticate, authorize } from '#middleware/auth.middleware.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';

const router = express.Router();

// ORDER IS THE FIX. authenticate first, then the limiter.
//
// v0 mounted its security middleware at app level (src/app.js:20), ahead of every
// router. That middleware read `req.user?.role` to pick a per-role limit — but
// `req.user` is only set by `authenticate`, which runs here, later. So `role` was
// permanently `'guest'` and admins, users and anonymous callers all received the
// same guest bucket. The role switch in that file had never once taken a branch
// other than the default.
//
// Mounted after `authenticate`, the limiter sees a real `req.user` and keys on
// user id rather than IP, which is what makes a per-role limit mean anything.
router.use(authenticate);
router.use(rateLimit('authenticated'));

router.get('/', authorize('admin'), fetchAllUsers);
router.get('/:id', getUserById);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

export default router;
