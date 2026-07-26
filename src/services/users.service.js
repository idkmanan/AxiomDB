import { db } from '#config/database.js';
import logger from '#config/logger.js';
import { eq } from 'drizzle-orm';
import { users } from '#models/user.model.js';

export const getAllUsers = async () => {
  try {
    return await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      created_at: users.created_at,
      updated_at: users.updated_at
    }).from(users);
  } catch(e) {
    logger.error('Error getting users', e);
    throw e;
  }
};

export const getUserById = async (id) => {
  try {
    const result = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      created_at: users.created_at,
      updated_at: users.updated_at
    }).from(users).where(eq(users.id, id)).limit(1);
        
    return result[0] || null;
  } catch(e) {
    logger.error(`Error getting user by id: ${id}`, e);
    throw e;
  }
};

export const updateUser = async (id, updates) => {
  try {
    const existingUser = await getUserById(id);
    if (!existingUser) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    const updateData = {
      ...updates,
      updated_at: new Date()
    };

    const result = await db.update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        created_at: users.created_at,
        updated_at: users.updated_at
      });

    return result[0];
  } catch(e) {
    logger.error(`Error updating user: ${id}`, e);
    throw e;
  }
};

export const deleteUser = async (id) => {
  try {
    const existingUser = await getUserById(id);
    if (!existingUser) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    await db.delete(users).where(eq(users.id, id));
    return { success: true, message: 'User deleted successfully' };
  } catch(e) {
    logger.error(`Error deleting user: ${id}`, e);
    throw e;
  }
};