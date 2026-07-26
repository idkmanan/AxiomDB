import logger from '#config/logger.js';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import {db} from '#config/database.js';
import {users} from '#models/user.model.js';

export const hashPassword = async (password) => {
  try{
    return await bcrypt.hash(password, 10);
  } catch(e) {
    logger.error(`Error hashing the password: ${e}`);
    throw new Error('Error hashing');
  }
};

export const comparePassword = async (password, hash) => {
  try{
    return await bcrypt.compare(password, hash);
  } catch(e) {
    logger.error(`Error comparing the password: ${e}`);
    throw new Error('Error comparing password');
  }
};

export const authenticateUser = async (email, password) => {
  try{
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if(!user) throw new Error('User not found');

    const valid = await comparePassword(password, user.password);
    if(!valid) throw new Error('Invalid password');

    logger.info(`User authenticated successfully: ${email}`);
    return user;
  } catch(e){
    logger.error(`Error authenticating the user: ${e}`);
    throw e;
  }
};

export const createUser = async ({name, password, email, role='user'}) => {
  try{
    const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if(existingUser.length > 0) throw new Error('User already exists');
    const password_hash = await hashPassword(password);
    const [newUser] = await db.insert(users).values({name,email,password:password_hash,role}).returning({id: users.id, name: users.name, email: users.email, role: users.role, created_at: users.created_at});
    logger.info(`User ${newUser.email} created successfully`);
    return newUser;
  } catch(e){
    logger.error(`Error creating the user: ${e}`);
    throw e;
  }
};