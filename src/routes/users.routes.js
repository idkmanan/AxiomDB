import { 
  fetchAllUsers, 
  getUserById, 
  updateUser, 
  deleteUser 
} from '#controllers/users.controller.js';
import { authenticate, authorize } from '#middleware/auth.middleware.js';
import express from 'express';

const router = express.Router();

router.use(authenticate);

router.get('/', authorize('admin'), fetchAllUsers);
router.get('/:id', getUserById);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

export default router;