// ---------------------------------------------------------------------------
// Request validation for the deals endpoints.
//
// The rule this file exists to enforce, learned the expensive way in Phase 1: a field
// the server owns must not be accepted from the body. `role` at signup was a
// privilege escalation (finding F-23) not because the field was writable but because
// it was writable BY THE CALLER. The equivalents here are `owner_id` (the authenticated
// user, never the body — otherwise any user can create deals attributed to anyone) and
// `version` (a server fact; the client may only assert which version it read).
// ---------------------------------------------------------------------------
import { z } from 'zod';
import config from '#config/env.js';
import { DEAL_STAGES, TERMINAL_STAGES } from '#models/deal.model.js';

const OPEN_STAGES = DEAL_STAGES.filter((s) => !TERMINAL_STAGES.includes(s));

// `bigserial` is 64-bit, but JSON numbers are IEEE-754 doubles, so ids above 2^53-1
// cannot round-trip through a JS client without silently changing value. Bounding at
// MAX_SAFE_INTEGER keeps the API honest about what it can represent; the column has
// room for more than this application will ever need.
const MAX_DEAL_ID = Number.MAX_SAFE_INTEGER;

export const dealIdSchema = z.strictObject({
  id: z
    .string()
    .regex(/^\d+$/, { message: 'Invalid deal ID format' })
    .transform(Number)
    .refine((n) => n >= 1 && n <= MAX_DEAL_ID, { message: 'Deal ID out of range' }),
});

/**
 * List query.
 *
 * `cursor` and `offset` are mutually exclusive, and rejecting the combination is worth
 * the four lines: silently preferring one would make the endpoint's behaviour depend on
 * an undocumented precedence rule, and the two strategies produce different pages from
 * the same data. A caller that sends both has a bug, and saying so is more useful than
 * guessing.
 *
 * The offset ceiling is 100,000 — low enough to bound the worst-case scan, high enough
 * that the before/after comparison has something to measure. Deep OFFSET is the cost
 * being demonstrated, so the endpoint has to permit some of it while refusing to be an
 * unbounded caller-controlled scan (the defect class Phase 1 introduced with an
 * uncapped `limit`).
 */
export const listDealsQuerySchema = z
  .strictObject({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(config.pagination.maxLimit, {
        message: `limit may not exceed ${config.pagination.maxLimit}`,
      })
      .default(config.pagination.defaultLimit),
    cursor: z.string().min(1).max(128).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
    stage: z.enum(DEAL_STAGES).optional(),
    owner_id: z.coerce.number().int().min(1).max(2147483647).optional(),
  })
  .refine((q) => !(q.cursor !== undefined && q.offset !== undefined), {
    message: 'Use either cursor or offset, not both',
    path: ['cursor'],
  });

export const createDealSchema = z.strictObject({
  title: z.string().trim().min(2).max(200),
  company: z.string().trim().min(1).max(200),
  // Minor units, integer only. Accepting 19.99 here would invite a float through the
  // one boundary the schema exists to protect — see the money note in
  // src/models/deal.model.js.
  amount_cents: z.coerce
    .number()
    .int({ message: 'amount_cents must be an integer number of cents' })
    .min(0)
    .max(1e15),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO 4217 code' })
    .default('USD'),
  // A deal may be created in any OPEN stage — importing a pipeline mid-flight is a real
  // use case. It may not be created closed: the CHECK constraint requires a closing
  // timestamp for a terminal stage, and inventing one for a deal that was never open is
  // a fabricated audit trail.
  stage: z.enum(OPEN_STAGES).optional(),
});

/**
 * Update body. `version` is required here and not optional-with-a-default, because a
 * default would silently turn a client that forgot it into a last-writer-wins client —
 * which is the exact bug optimistic concurrency exists to prevent.
 *
 * It may also arrive as an `If-Match` header; see src/controllers/deals.controller.js.
 */
export const updateDealSchema = z
  .strictObject({
    title: z.string().trim().min(2).max(200).optional(),
    company: z.string().trim().min(1).max(200).optional(),
    amount_cents: z.coerce.number().int().min(0).max(1e15).optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    version: z.coerce.number().int().min(1).optional(),
  })
  .refine((body) => Object.keys(body).some((k) => k !== 'version'), {
    message: 'At least one field must be provided for update',
  });

/**
 * Stage transition. A separate endpoint rather than a writable `stage` field, because a
 * transition is an operation with rules, not an assignment — and modelling it as a
 * field invites a client to set `closed_won` from `sourced` and forces the server to
 * reject a request that looked legal in the schema.
 */
export const advanceStageSchema = z.strictObject({
  to: z.enum(DEAL_STAGES),
});
