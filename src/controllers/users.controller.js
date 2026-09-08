import logger from '#config/logger.js';
import { parseOr400 } from '#utils/http-validate.js';
import {
  getAllUsers,
  getUserById as getUserByIdService,
  updateUser as updateUserService,
  deleteUser as deleteUserService,
} from '#services/users.service.js';
import {
  userIdSchema,
  updateUserSchema,
  listUsersQuerySchema,
} from '#validations/users.validation.js';

export const fetchAllUsers = async (req, res, next) => {
  try {
    const query = parseOr400(listUsersQuerySchema, req.query, res, req, 'list users query');
    if (!query) return;

    const { users, pagination } = await getAllUsers(query);

    res.json({
      message: 'Successfully retrieved users',
      users,
      pagination,
      // `count` retained as the number of rows in THIS response, which is what it
      // meant in v0 — there it happened to equal the table size because the query
      // was unbounded. Kept so an existing client is not silently broken, with
      // `pagination.total` as the field that now means what `count` used to.
      count: pagination.returned,
    });
  } catch (e) {
    next(e);
  }
};

export const getUserById = async (req, res, next) => {
  try {
    const params = parseOr400(userIdSchema, req.params, res, req, 'get user by id');
    if (!params) return;

    const user = await getUserByIdService(params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found', requestId: req.id });
    }

    res.json({ message: 'Successfully retrieved user', user });
  } catch (e) {
    next(e);
  }
};

export const updateUser = async (req, res, next) => {
  try {
    const params = parseOr400(userIdSchema, req.params, res, req, 'update user id');
    if (!params) return;
    const updates = parseOr400(updateUserSchema, req.body, res, req, 'update user body');
    if (!updates) return;

    // Ownership check. `params.id` is already a Number (the schema transforms it),
    // so this is a plain === rather than v0's `req.user.id !== parseInt(id)` —
    // a comparison that was correct but only because parseInt was reapplied at
    // every call site, which is the kind of thing that survives until one site
    // forgets.
    if (req.user.role !== 'admin' && req.user.id !== params.id) {
      logger.warn('Unauthorized update attempt', {
        requestId: req.id,
        actorId: req.user.id,
        targetId: params.id,
      });
      return res
        .status(403)
        .json({ error: 'Forbidden', message: 'You can only update your own profile' });
    }

    // Privilege escalation, second door. `role` is a permitted field on this
    // schema, so without this check any authenticated user could promote
    // themselves by updating their own profile — the same escalation as the signup
    // bug, reached through a route that legitimately accepts the field.
    if (updates.role && req.user.role !== 'admin') {
      logger.warn('Unauthorized role change attempt', {
        requestId: req.id,
        actorId: req.user.id,
        targetId: params.id,
      });
      return res
        .status(403)
        .json({ error: 'Forbidden', message: 'Only admins can change user roles' });
    }

    const updatedUser = await updateUserService(params.id, updates);
    res.json({ message: 'User updated successfully', user: updatedUser });
  } catch (e) {
    // 'User not found' is an AppError with statusCode 404 from the service, so the
    // global error handler renders it. v0 matched on the message string here.
    next(e);
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    const params = parseOr400(userIdSchema, req.params, res, req, 'delete user id');
    if (!params) return;

    if (req.user.role !== 'admin' && req.user.id !== params.id) {
      logger.warn('Unauthorized delete attempt', {
        requestId: req.id,
        actorId: req.user.id,
        targetId: params.id,
      });
      return res
        .status(403)
        .json({ error: 'Forbidden', message: 'You can only delete your own account' });
    }

    await deleteUserService(params.id);
    res.json({ message: 'User deleted successfully' });
  } catch (e) {
    next(e);
  }
};
