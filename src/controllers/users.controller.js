import logger from '#config/logger.js';
import { formatValidationError } from '#utils/format.js';
import { 
  getAllUsers, 
  getUserById as getUserByIdService, 
  updateUser as updateUserService, 
  deleteUser as deleteUserService
} from '#services/users.service.js';
import { userIdSchema, updateUserSchema } from '#validations/users.validation.js';

export const fetchAllUsers = async (req, res, next) => {
  try {
    logger.info('Getting all the users');
    const allUsers = await getAllUsers();
    res.json({
      message: 'Successfully retrieved users...',
      users: allUsers,
      count: allUsers.length
    });
  }catch(e){
    logger.error(e);
    next(e);
  }
};

export const getUserById = async (req, res, next) => {
  try {
    const validationResult = userIdSchema.safeParse(req.params);
    if (!validationResult.success) {
      logger.warn('Validation error getting user by ID', { errors: validationResult.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(validationResult.error) 
      });
    }

    const { id } = validationResult.data;
    logger.info(`Getting user by ID: ${id}`);
    const user = await getUserByIdService(id);
        
    if (!user) {
      logger.warn(`User not found: ${id}`);
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      message: 'Successfully retrieved user',
      user
    });
  } catch(e) {
    logger.error(e);
    next(e);
  }
};

export const updateUser = async (req, res, next) => {
  try {
    const paramsValidation = userIdSchema.safeParse(req.params);
    if (!paramsValidation.success) {
      logger.warn('Validation error updating user - invalid ID', { errors: paramsValidation.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(paramsValidation.error) 
      });
    }

    const bodyValidation = updateUserSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      logger.warn('Validation error updating user', { errors: bodyValidation.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(bodyValidation.error) 
      });
    }

    const { id } = paramsValidation.data;
    const updates = bodyValidation.data;

    logger.info(`Updating user: ${id} by user: ${req.user.id} (role: ${req.user.role})`);

    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      logger.warn(`Unauthorized update attempt: user ${req.user.id} tried to update user ${id}`);
      return res.status(403).json({ error: 'Forbidden', message: 'You can only update your own profile' });
    }

    if (updates.role && req.user.role !== 'admin') {
      logger.warn(`Unauthorized role change attempt: user ${req.user.id} tried to change role`);
      return res.status(403).json({ error: 'Forbidden', message: 'Only admins can change user roles' });
    }

    const updatedUser = await updateUserService(id, updates);
    res.json({
      message: 'User updated successfully',
      user: updatedUser
    });
  } catch(e) {
    if (e.message === 'User not found') {
      logger.warn(`Update failed - user not found: ${req.params.id}`);
      return res.status(404).json({ message: 'User not found' });
    }
    logger.error(e);
    next(e);
  }
};

export const deleteUser = async (req, res, next) => {
  try {
    const validationResult = userIdSchema.safeParse(req.params);
    if (!validationResult.success) {
      logger.warn('Validation error deleting user - invalid ID', { errors: validationResult.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(validationResult.error) 
      });
    }

    const { id } = validationResult.data;
    logger.info(`Deleting user: ${id} by user: ${req.user.id} (role: ${req.user.role})`);

    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      logger.warn(`Unauthorized delete attempt: user ${req.user.id} tried to delete user ${id}`);
      return res.status(403).json({ error: 'Forbidden', message: 'You can only delete your own account' });
    }

    await deleteUserService(id);
    res.json({
      message: 'User deleted successfully'
    });
  } catch(e) {
    if (e.message === 'User not found') {
      logger.warn(`Delete failed - user not found: ${req.params.id}`);
      return res.status(404).json({ message: 'User not found' });
    }
    logger.error(e);
    next(e);
  }
};