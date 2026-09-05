import logger from '#config/logger.js';
import { authenticateUser, createUser } from '#services/auth.service.js';
import { cookies } from '#utils/cookies.js';
import { formatValidationError, validationIssues } from '#utils/format.js';
import { jwttoken } from '#utils/jwt.js';
import { signinSchema, signupSchema } from '#validations/auth.validation.js';

export const signup = async (req, res, next) => {
  try {
    const validationResult = signupSchema.safeParse(req.body);
    if (!validationResult.success) {
      // `.issues`, not `.errors` — the latter is undefined in Zod 4, so this line
      // used to log nothing useful. See the note in src/utils/format.js.
      logger.warn('Validation error during signup', {
        requestId: req.id,
        issues: validationIssues(validationResult.error),
      });
      return res.status(400).json({
        message: 'Validation failed',
        errors: formatValidationError(validationResult.error),
      });
    }

    // No `role`, and the schema will not accept one. The v0 line was:
    //   const { name, email, password, role } = validationResult.data;
    // and that single extra binding is what made the whole RBAC layer bypassable.
    const { name, email, password } = validationResult.data;
    const user = await createUser({ name, email, password });

    const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
    cookies.set(res, 'token', token);

    logger.info('User signed up', { requestId: req.id, userId: user.id });
    return res.status(201).json({
      message: 'User created successfully',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e) {
    // No message-string matching here any more. The service throws AppError with
    // a status and src/middleware/error.middleware.js renders it. v0 compared
    // `e.message === 'User already exists'`, which coupled the HTTP status of an
    // operation to the exact wording of a string in another file — rewording a
    // log message would have silently turned a 409 into a 500.
    return next(e);
  }
};

export const signin = async (req, res, next) => {
  try {
    const validationResult = signinSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn('Validation error during signin', {
        requestId: req.id,
        issues: validationIssues(validationResult.error),
      });
      return res.status(400).json({
        message: 'Validation failed',
        errors: formatValidationError(validationResult.error),
      });
    }

    const { email, password } = validationResult.data;
    const user = await authenticateUser(email, password);

    const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
    cookies.set(res, 'token', token);

    logger.info('User signed in', { requestId: req.id, userId: user.id });
    return res.status(200).json({
      message: 'Sign in successful',
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e) {
    return next(e);
  }
};

export const signout = async (req, res, next) => {
  try {
    cookies.clear(res, 'token');
    // Honest log line: this clears a cookie and nothing more. The JWT stays valid
    // until it expires — there is no server-side session to end and no denylist to
    // add it to. Phase 4 adds a JTI denylist in Redis, and only then does sign-out
    // become revocation. Calling this "sign out" in a README today overstates it.
    logger.info('Session cookie cleared; bearer token remains valid until expiry', {
      requestId: req.id,
      userId: req.user?.id,
    });
    return res.status(200).json({ message: 'Sign out successful' });
  } catch (e) {
    return next(e);
  }
};
