import logger from '#config/logger.js';
import { authenticateUser, createUser } from '#services/auth.service.js';
import { cookies } from '#utils/cookies.js';
import { formatValidationError } from '#utils/format.js';
import { jwttoken } from '#utils/jwt.js';
import { signinSchema, signupSchema } from '#validations/auth.validation.js';

export const signup = async (req, res, next) => {
  try{
    const validationResult = signupSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn('Validation error during signup', { errors: validationResult.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(validationResult.error) 
      });
    }

    const { name, email, password, role } = validationResult.data;
    const user = await createUser({ name, email, password, role });

    const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
    cookies.set(res, 'token', token);

    logger.info(`User signed up successfully: ${user.email}`);
    return res.status(201).json({ 
      message: 'User created successfully', 
      user: { id: user.id, name: user.name, email: user.email, role: user.role } 
    });
  } catch (e) {
    if (e.message === 'User already exists') {
      logger.warn(`Signup failed - user already exists: ${req.body.email}`);
      return res.status(409).json({ message: 'User with this email already exists' });
    }
    logger.error(`Error during signup: ${e}`);
    next(e);
  }
};

export const signin = async (req, res, next) => {
  try{
    const validationResult = signinSchema.safeParse(req.body);
    if (!validationResult.success) {
      logger.warn('Validation error during signin', { errors: validationResult.error.errors });
      return res.status(400).json({ 
        message: 'Validation failed', 
        errors: formatValidationError(validationResult.error) 
      });
    }

    const { email, password } = validationResult.data;
    const user = await authenticateUser(email, password);

    const token = jwttoken.sign({ id: user.id, email: user.email, role: user.role });
    cookies.set(res, 'token', token);

    logger.info(`User signed in successfully: ${user.email}`);
    return res.status(200).json({ 
      message: 'Sign in successful', 
      user: { id: user.id, name: user.name, email: user.email, role: user.role } 
    });
  } catch (e) {
    if (e.message === 'User not found' || e.message === 'Invalid password') {
      logger.warn(`Signin failed - ${e.message}: ${req.body.email}`);
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    logger.error(`Error during signin: ${e}`);
    next(e);
  }
};

export const signout = async (req, res, next) => {
  try{
    cookies.clear(res, 'token');
    logger.info('User signed out successfully');
    return res.status(200).json({ message: 'Sign out successful' });
  } catch (e) {
    logger.error(`Error during signout: ${e}`);
    next(e);
  }
};