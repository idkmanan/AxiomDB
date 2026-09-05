import { z } from 'zod';

// ---------------------------------------------------------------------------
// THE PRIVILEGE ESCALATION (fixed here).
//
// v0 line 7 was:
//
//   role: z.enum(['user', 'admin']).default('user')
//
// on the SIGN-UP schema, and src/controllers/auth.controller.js:19 destructured
// `role` straight out of the validated body into `createUser`. So:
//
//   curl -X POST /api/auth/sign-up -d '{"…","role":"admin"}'
//
// returned an admin JWT to an anonymous caller. That token satisfied
// `authorize('admin')` at src/routes/users.routes.js:15, which was the only guard
// on the list-all-users endpoint. The entire RBAC layer was bypassable with one
// extra JSON field — and nothing in the code looked wrong. A Zod enum with a safe
// default reads like careful input validation, which is exactly why this is the
// most instructive defect in the repository.
//
// The fix is not "validate the role harder". Privilege is not user input, so it
// does not belong in a request schema at all: src/services/auth.service.js now
// assigns the role and ignores anything a caller passes.
//
// `strictObject` is the second half of the fix. A plain object schema strips
// unknown keys silently, which would leave the change looking like a no-op that a
// later refactor could quietly undo. Strict mode rejects the request with a 400
// naming the offending key, so an escalation attempt is loud, logged, and
// straightforward to assert on in a test.
// ---------------------------------------------------------------------------
export const signupSchema = z.strictObject({
  name: z.string().trim().min(2).max(225),
  email: z.email().toLowerCase().trim().max(255),
  password: z.string().min(6).max(128),
});

export const signinSchema = z.strictObject({
  email: z.email().toLowerCase().trim(),
  password: z.string().min(1),
});
