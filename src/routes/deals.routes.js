import express from 'express';
import {
  listDeals,
  getSummary,
  getDeal,
  createDeal,
  updateDeal,
  advanceStage,
  deleteDeal,
} from '#controllers/deals.controller.js';
import { authenticate } from '#middleware/auth.middleware.js';
import { rateLimit } from '#middleware/rate-limit.middleware.js';
import { idempotency } from '#middleware/idempotency.middleware.js';

const router = express.Router();

// Same ordering rule as src/routes/users.routes.js, for the same reason: the limiter
// runs AFTER `authenticate` so `req.user` exists and the per-role ceiling means
// something. Mounted before it, every caller silently shares the guest bucket — which
// is what v0 did for its entire life.
router.use(authenticate);
router.use(rateLimit('authenticated'));

// STATIC PATHS BEFORE PARAMETERISED ONES. Express matches in registration order, so
// `/summary` declared after `/:id` would be captured by `/:id`, fail the digits-only id
// regex and answer 400 — a routing mistake that presents as a validation error, which is
// among the more confusing ways to spend an afternoon.
router.get('/summary', getSummary);

router.get('/', listDeals);

// The one endpoint here that CREATES something, and therefore the one where a retry is
// dangerous: a lost response makes a client resend, and without a key the server has no way to
// know it is the same request. See src/middleware/idempotency.middleware.js — it is a no-op
// unless the caller sends `Idempotency-Key`, so this breaks no existing client.
//
// PUT and DELETE do not need it: PUT carries a version, so a replay hits a 409, and DELETE is
// naturally idempotent (the second one is a 404, which is the truth). `POST /:id/stage` is
// deliberately non-idempotent — advancing twice is two different outcomes and the second is a
// 409 — so a key there would hide a real conflict behind a replay.
router.post('/', idempotency(), createDeal);

router.get('/:id', getDeal);
router.put('/:id', updateDeal);
router.delete('/:id', deleteDeal);

// A transition is an operation, not an assignment — see the note on `advanceStageSchema`.
// POST rather than PATCH because it is not idempotent: advancing twice is two different
// outcomes, and the second one is a 409.
router.post('/:id/stage', advanceStage);

export default router;
