import { Router } from 'express';
import { signWsTicket } from '../lib/tokens';
import { currentUserId } from '../middleware/auth';

export const realtimeRouter = Router();

/** One-minute ticket for opening a WebSocket (see signWsTicket). */
realtimeRouter.post('/ticket', (req, res) => {
  res.json({ ticket: signWsTicket(currentUserId(req)) });
});
