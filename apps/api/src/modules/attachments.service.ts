import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { MAX_UPLOAD_BYTES, type Attachment } from '@convo/shared';
import { badRequest } from '../lib/errors';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { fileTooLarge, storage } from '../lib/storage';
import { requireChannelMember } from './access';

/** Uploads not sent with a message within this time are deleted. */
export const PENDING_UPLOAD_TTL_MS = 60 * 60_000;

/** Image types shown inline, each with a check of the file's first bytes. */
const INLINE_IMAGES: Record<string, (head: Buffer) => boolean> = {
  'image/png': (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  'image/gif': (h) => ['GIF87a', 'GIF89a'].includes(h.subarray(0, 6).toString('latin1')),
  'image/webp': (h) =>
    h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP',
};

export const isInlineImage = (mimeType: string) => mimeType in INLINE_IMAGES;

/**
 * Keeps the type the browser reported if it looks like a MIME type. Image types are kept only
 * when the bytes agree, so an HTML file renamed to .png is stored as a plain download.
 */
export function resolveMimeType(claimed: string | undefined, head: Buffer) {
  const type = claimed?.split(';')[0]?.trim().toLowerCase();
  if (!type || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type)) return 'application/octet-stream';
  const matches = INLINE_IMAGES[type];
  if (matches && !matches(head)) return 'application/octet-stream';
  return type;
}

/** Replaces path separators and control characters; the name is only ever shown and sent back as a header. */
const cleanFileName = (name: string) =>
  Array.from(name, (ch) => (ch < ' ' || ch === '\x7f' || ch === '/' || ch === '\\' ? '_' : ch))
    .join('')
    .trim() || 'file';

export const attachmentSelect = { id: true, name: true, mimeType: true, size: true } as const;

type AttachmentRow = { id: string; name: string; mimeType: string; size: number };
export const toAttachment = (a: AttachmentRow): Attachment => ({
  ...a,
  isImage: isInlineImage(a.mimeType),
  url: `/api/attachments/${a.id}`,
});

export async function uploadAttachment(
  userId: string,
  channelId: string,
  body: Readable,
  file: { name: string; type?: string; contentLength?: number },
) {
  await requireChannelMember(userId, channelId);
  if (file.contentLength !== undefined && file.contentLength > MAX_UPLOAD_BYTES) throw fileTooLarge(MAX_UPLOAD_BYTES);

  const storageKey = randomUUID();
  const stored = await storage.put(storageKey, body, MAX_UPLOAD_BYTES);
  try {
    if (stored.size === 0) throw badRequest('The file is empty');
    const row = await prisma.attachment.create({
      data: {
        channelId,
        uploaderId: userId,
        name: cleanFileName(file.name),
        mimeType: resolveMimeType(file.type, stored.head),
        size: stored.size,
        storageKey,
      },
      select: attachmentSelect,
    });
    return toAttachment(row);
  } catch (err) {
    await storage.delete(storageKey);
    throw err;
  }
}

/**
 * Deletes uploads that were never sent, then any stored file without a row: left behind by
 * deleted messages, channels or workspaces (cascades only reach the database) or by crashes.
 * Only touches files older than the pending window, so uploads in progress are safe.
 */
export async function sweepUploads(now = new Date()) {
  const cutoff = new Date(now.getTime() - PENDING_UPLOAD_TTL_MS);
  const { count: pendingRemoved } = await prisma.attachment.deleteMany({
    where: { messageId: null, createdAt: { lt: cutoff } },
  });

  const old = (await storage.list()).filter((f) => f.modifiedAt < cutoff);
  const known = new Set(
    (
      await prisma.attachment.findMany({
        where: { storageKey: { in: old.map((f) => f.key) } },
        select: { storageKey: true },
      })
    ).map((r) => r.storageKey),
  );
  const orphans = old.filter((f) => !known.has(f.key));
  await Promise.all(orphans.map((f) => storage.delete(f.key)));

  if (pendingRemoved || orphans.length) {
    logger.info({ pendingRemoved, filesRemoved: orphans.length }, 'Swept uploads');
  }
  return { pendingRemoved, filesRemoved: orphans.length };
}
