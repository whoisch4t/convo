import { Router } from 'express';
import { notificationListQuerySchema, notificationReadSchema } from '@convo/shared';
import { currentUserId } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { requireWorkspaceMember } from './access';
import { listNotifications, markNotificationsRead } from './notifications.service';

export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const { workspaceId, limit } = parse(notificationListQuerySchema, req.query);
  res.json(await listNotifications(currentUserId(req), workspaceId, limit));
});

notificationsRouter.post('/read', async (req, res) => {
  const userId = currentUserId(req);
  const { workspaceId, ids } = parse(notificationReadSchema, req.body);
  await requireWorkspaceMember(userId, workspaceId);
  const read = await markNotificationsRead(userId, { workspaceId, ...(ids && { id: { in: ids } }) });
  res.json({ ids: read });
});
