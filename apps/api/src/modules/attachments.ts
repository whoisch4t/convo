import { Router } from 'express';
import { notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { storage } from '../lib/storage';
import { currentUserId } from '../middleware/auth';
import { requireChannelAccess } from './access';
import { attachmentSelect, isInlineImage } from './attachments.service';

export const attachmentsRouter = Router();

/** RFC 6266 header with an ASCII fallback and the real name in UTF-8. */
function contentDisposition(type: 'inline' | 'attachment', name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

attachmentsRouter.get('/:id', async (req, res) => {
  const userId = currentUserId(req);
  const file = await prisma.attachment.findUnique({
    where: { id: req.params.id },
    select: { ...attachmentSelect, channelId: true, uploaderId: true, messageId: true, storageKey: true },
  });
  if (!file) throw notFound('File');
  // Until it is sent, only the uploader can see a file. After that, whoever can see the channel.
  if (file.messageId === null) {
    if (file.uploaderId !== userId) throw notFound('File');
  } else {
    await requireChannelAccess(userId, file.channelId);
  }

  // Only verified raster images render in the browser. Everything else is a download of opaque
  // bytes, and the sandbox CSP stops it from running scripts even if opened directly.
  const inline = isInlineImage(file.mimeType);
  res.setHeader('Content-Type', inline ? file.mimeType : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', file.name));
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // Files never change, so the browser can keep them. "private" keeps shared caches out.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');

  const stream = storage.get(file.storageKey);
  stream.on('error', (err) => {
    logger.error({ err, attachmentId: file.id }, 'Could not read stored file');
    if (res.headersSent) return res.destroy();
    for (const h of ['Content-Type', 'Content-Disposition', 'Content-Length', 'Cache-Control']) res.removeHeader(h);
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
  });
  stream.pipe(res);
});
