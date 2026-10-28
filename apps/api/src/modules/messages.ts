import { Router } from 'express';
import { messageCreateSchema } from '@convo/shared';
import { currentUserId } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { deleteMessage, updateMessage } from './messages.service';

export const messagesRouter = Router();

messagesRouter.patch('/:id', async (req, res) => {
  const { content } = parse(messageCreateSchema, req.body);
  res.json({ message: await updateMessage(currentUserId(req), req.params.id, content) });
});

messagesRouter.delete('/:id', async (req, res) => {
  await deleteMessage(currentUserId(req), req.params.id);
  res.status(204).end();
});
