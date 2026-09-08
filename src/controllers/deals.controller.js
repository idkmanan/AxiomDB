// ---------------------------------------------------------------------------
// Deals HTTP layer.
//
// AUTHORIZATION MODEL, stated once here because it also decides which index the
// common case uses:
//
//   * A caller sees their own deals. `owner_id` is FORCED to `req.user.id` for
//     non-admins, so the hot list query is always the owner-filtered one and
//     `deals_owner_created_id_idx` is the index that matters in production. An admin
//     may list across owners, and may filter by `owner_id`.
//   * Someone else's deal answers 404, not 403. A 403 confirms the row exists, which
//     turns an id into an oracle for enumerating another account's pipeline. The same
//     reasoning as the identical 401 for "no such user" and "wrong password" in
//     src/services/auth.service.js.
//   * `owner_id` is never read from a request body. That is finding F-23 (the `role`
//     escalation) applied to a different field: a value the server owns must be set by
//     the server.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { parseOr400 } from '#utils/http-validate.js';
import {
  listDeals as listDealsService,
  listDealsPage,
  getDealById,
  createDeal as createDealService,
  updateDeal as updateDealService,
  advanceDealStage,
  deleteDeal as deleteDealService,
  estimateDealCount,
  pipelineSummary,
} from '#services/deals.service.js';
import {
  dealIdSchema,
  listDealsQuerySchema,
  createDealSchema,
  updateDealSchema,
  advanceStageSchema,
} from '#validations/deals.validation.js';

const isAdmin = (req) => req.user?.role === 'admin';

/** A weak ETag over the version column — see the note in `updateDeal`. */
const etagFor = (deal) => `W/"${deal.version}"`;

/**
 * GET /api/deals
 *
 * One endpoint, two pagination strategies, chosen by which parameter arrived. That is
 * unusual and deliberate: the OFFSET path is the measurement baseline (see
 * `listDealsPage`), and it has to be reachable through the same middleware, the same
 * serialisation and the same k6 script as the keyset path, or the comparison measures
 * the difference between two endpoints instead of two strategies.
 */
export const listDeals = async (req, res, next) => {
  try {
    const query = parseOr400(listDealsQuerySchema, req.query, res, req, 'list deals query');
    if (!query) return;

    // Non-admins are pinned to their own deals regardless of what they asked for. Note
    // the order: the override happens AFTER validation, so a non-admin passing
    // `owner_id=1` is not rejected, it is simply scoped — an authorization decision,
    // not a validation error.
    const ownerId = isAdmin(req) ? query.owner_id : req.user.id;

    const usesOffset = query.offset !== undefined;
    const result = usesOffset
      ? await listDealsPage({
          limit: query.limit,
          offset: query.offset,
          ownerId,
          stage: query.stage,
        })
      : await listDealsService({
          limit: query.limit,
          cursor: query.cursor,
          ownerId,
          stage: query.stage,
        });

    res.json({
      message: 'Successfully retrieved deals',
      deals: result.deals,
      pagination: result.pagination,
      count: result.pagination.returned,
    });
  } catch (e) {
    next(e);
  }
};

/**
 * GET /api/deals/summary — open pipeline by stage, plus the estimated table size.
 *
 * Mounted BEFORE `/:id` in the router. Express matches in registration order, so with
 * the reverse order `/summary` would be swallowed by `/:id`, fail the digits-only id
 * regex, and answer 400 — a routing bug that presents as a validation bug.
 */
export const getSummary = async (req, res, next) => {
  try {
    const [byStage, estimatedTotal] = await Promise.all([pipelineSummary(), estimateDealCount()]);
    res.json({
      message: 'Successfully retrieved pipeline summary',
      open_by_stage: byStage,
      // Named `_estimated` in the payload, because it is. See finding F-45.
      total_estimated: estimatedTotal,
    });
  } catch (e) {
    next(e);
  }
};

export const getDeal = async (req, res, next) => {
  try {
    const params = parseOr400(dealIdSchema, req.params, res, req, 'get deal by id');
    if (!params) return;

    const deal = await getDealById(params.id);
    // 404 for "not yours" as well as "not there" — see the header note.
    if (!deal || (!isAdmin(req) && deal.owner_id !== req.user.id)) {
      return res.status(404).json({ message: 'Deal not found', requestId: req.id });
    }

    // The version a client needs for its next update, in the place HTTP already has for
    // it. Weak (`W/`) because two responses with the same version are semantically
    // equivalent but not byte-identical — `updated_at` moves on an unrelated field
    // change. Claiming a strong validator would be a lie a caching proxy might act on.
    res.set('ETag', etagFor(deal));
    res.json({ message: 'Successfully retrieved deal', deal });
  } catch (e) {
    next(e);
  }
};

export const createDeal = async (req, res, next) => {
  try {
    const body = parseOr400(createDealSchema, req.body, res, req, 'create deal');
    if (!body) return;

    const deal = await createDealService({
      // Never from the body.
      ownerId: req.user.id,
      title: body.title,
      company: body.company,
      amountCents: body.amount_cents,
      currency: body.currency,
      stage: body.stage,
    });

    res.status(201).set('ETag', etagFor(deal)).json({ message: 'Deal created', deal });
  } catch (e) {
    next(e);
  }
};

/**
 * Read the asserted version from `If-Match` or from the body.
 *
 * TWO SOURCES, ONE MEANING, and an explicit error when they disagree. `If-Match` is the
 * HTTP-native way to express "only if you are still at the version I read" and it is
 * what a caching proxy understands; a `version` field in the body is what most JSON
 * clients actually send. Supporting both costs these ten lines. Silently preferring one
 * would make the endpoint's behaviour depend on an undocumented precedence rule, which
 * is the same objection as accepting `cursor` and `offset` together.
 */
function resolveExpectedVersion(req, body) {
  const header = req.get('If-Match');
  const fromHeader = header ? Number(/^(?:W\/)?"?(\d+)"?$/.exec(header.trim())?.[1]) : undefined;
  const fromBody = body.version;

  if (header !== undefined && header !== null && !Number.isInteger(fromHeader)) {
    return { error: 'If-Match must be an entity tag containing the version, e.g. W/"7"' };
  }
  if (Number.isInteger(fromHeader) && Number.isInteger(fromBody) && fromHeader !== fromBody) {
    return { error: 'If-Match and body version disagree' };
  }
  return { version: Number.isInteger(fromHeader) ? fromHeader : fromBody };
}

export const updateDeal = async (req, res, next) => {
  try {
    const params = parseOr400(dealIdSchema, req.params, res, req, 'update deal id');
    if (!params) return;
    const body = parseOr400(updateDealSchema, req.body, res, req, 'update deal body');
    if (!body) return;

    const { version, error } = resolveExpectedVersion(req, body);
    if (error) {
      return res.status(400).json({ message: 'Validation failed', errors: { version: error } });
    }

    // `version` is a precondition, not a field to write. Stripped here so the service
    // cannot accidentally persist it as a column the client controls.
    const { version: _asserted, ...fields } = body;

    const deal = await updateDealService(params.id, fields, {
      expectedVersion: version,
      // Admins may update any deal; everyone else is scoped to their own. Passing
      // `undefined` means "no ownership predicate", which is why this is not
      // `req.user.id` with an `isAdmin` branch inside the service — the service should
      // not know what an admin is.
      ownerId: isAdmin(req) ? undefined : req.user.id,
    });

    res.set('ETag', etagFor(deal)).json({ message: 'Deal updated', deal });
  } catch (e) {
    // A 409 from the service carries `currentVersion`; surface it so a client can
    // re-apply without a second GET. The global handler cannot do this — it deliberately
    // knows nothing about domain fields.
    if (e?.statusCode === 409 && e.currentVersion !== undefined) {
      logger.info('Responding 409 with the current version', {
        requestId: req.id,
        dealId: req.params.id,
        currentVersion: e.currentVersion,
      });
      return res.status(409).json({
        error: 'Conflict',
        message: e.message,
        code: e.code,
        currentVersion: e.currentVersion,
        requestId: req.id,
      });
    }
    next(e);
  }
};

export const advanceStage = async (req, res, next) => {
  try {
    const params = parseOr400(dealIdSchema, req.params, res, req, 'advance stage id');
    if (!params) return;
    const body = parseOr400(advanceStageSchema, req.body, res, req, 'advance stage body');
    if (!body) return;

    const deal = await advanceDealStage(params.id, body.to, {
      ownerId: isAdmin(req) ? undefined : req.user.id,
    });

    res.set('ETag', etagFor(deal)).json({ message: `Deal advanced to ${body.to}`, deal });
  } catch (e) {
    if (e?.code === 'ILLEGAL_STAGE_TRANSITION') {
      return res.status(409).json({
        error: 'Conflict',
        message: e.message,
        code: e.code,
        currentStage: e.currentStage,
        allowedStages: e.allowedStages,
        requestId: req.id,
      });
    }
    next(e);
  }
};

export const deleteDeal = async (req, res, next) => {
  try {
    const params = parseOr400(dealIdSchema, req.params, res, req, 'delete deal id');
    if (!params) return;

    await deleteDealService(params.id, { ownerId: isAdmin(req) ? undefined : req.user.id });
    res.json({ message: 'Deal deleted successfully' });
  } catch (e) {
    next(e);
  }
};
