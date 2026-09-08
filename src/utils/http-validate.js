// ---------------------------------------------------------------------------
// The repeated "parse or answer 400" shape, in one place.
//
// Extracted from src/controllers/users.controller.js, where it was a local helper. It
// moved here when the deals controller needed the same thing, and the reason to
// extract rather than copy is narrow: the 400 BODY SHAPE is a contract. Two copies
// drift, and a client that special-cases one endpoint's error format ends up
// special-casing both.
// ---------------------------------------------------------------------------
import logger from '#config/logger.js';
import { formatValidationError, validationIssues } from '#utils/format.js';

/**
 * Validate `input` against `schema`, or answer 400 and return null.
 *
 * Returning null rather than throwing keeps the controller's control flow visible: the
 * caller writes `if (!parsed) return;`, so it is obvious at the call site that the
 * response has already been sent. A thrown error would route through the global handler
 * and lose the per-field detail this assembles.
 */
export function parseOr400(schema, input, res, req, what) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  logger.warn(`Validation error: ${what}`, {
    requestId: req.id,
    issues: validationIssues(result.error),
  });
  res.status(400).json({
    message: 'Validation failed',
    errors: formatValidationError(result.error),
    requestId: req.id,
  });
  return null;
}

export default parseOr400;
