// ---------------------------------------------------------------------------
// Validation error formatting.
//
// A SMALL BUG WITH A WIDE BLAST RADIUS, fixed in Phase 1.
//
// Six call sites logged `validationResult.error.errors`:
//
//   src/controllers/auth.controller.js:12, :44
//   src/controllers/users.controller.js:30, :60, :69, :110
//
// Zod 4 renamed that property to `.issues`. `.errors` is simply absent, verified
// against the installed version:
//
//   $ node -e "…z.object({a:z.string()}).safeParse({}).error.errors…"
//   has .issues: true
//   has .errors: UNDEFINED     (zod 4.4.3)
//
// So every one of those lines logged `{ errors: undefined }`. The log recorded
// that a request failed validation and nothing about why — which is the single
// most useful thing to know when a client reports that your API rejects its
// payload. `formatValidationError` already used `.issues` and so kept working,
// which is why nobody noticed: the HTTP response was correct and only the log was
// blind.
//
// Both helpers below take the ZodError itself so the property name lives in one
// place and a future Zod rename is a one-line change.
// ---------------------------------------------------------------------------

/** Human-readable single line, safe to return to the client. */
export const formatValidationError = (error) => {
  if (!error || !Array.isArray(error.issues)) return 'Validation failed';
  return error.issues.map((i) => i.message).join(', ');
};

/**
 * Structured issues for the log. Field paths are included because "Invalid
 * input" without a path is unactionable, and the received VALUE is deliberately
 * excluded — a failed sign-up logs the rejected password otherwise.
 */
export const validationIssues = (error) => {
  if (!error || !Array.isArray(error.issues)) return [];
  return error.issues.map((i) => ({
    path: Array.isArray(i.path) ? i.path.join('.') : String(i.path ?? ''),
    code: i.code,
    message: i.message,
  }));
};
