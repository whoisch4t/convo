/**
 * WebSocket protocol. Every frame is one JSON object with a `type`.
 * Client frames are validated with Zod on the server; server frames are typed only.
 */
import { z } from 'zod';
import { attachmentIdsSchema, messageTextSchema } from './schemas';
import type { AppNotification, Channel, Message, ReadPointer, UserSummary } from './types';

const id = z.string().min(1).max(64);

export const clientEventSchema = z.discriminatedUnion('type', [
  /** Start receiving events for a workspace: presence plus every channel the user has joined. */
  z.object({ type: z.literal('workspace.subscribe'), workspaceId: id }),
  /** Also receive events for a channel the user is viewing but has not joined (public channels). */
  z.object({ type: z.literal('channel.focus'), channelId: id.nullable() }),
  z.object({
    type: z.literal('message.send'),
    channelId: id,
    content: messageTextSchema.default(''),
    /** Files uploaded beforehand with POST /api/channels/:id/attachments. */
    attachmentIds: attachmentIdsSchema,
    /** Echoed back in the ack so the client can match it with its optimistic message. */
    clientId: z.string().min(1).max(64),
  }),
  z.object({ type: z.literal('typing'), channelId: id }),
  z.object({ type: z.literal('read'), channelId: id, messageId: id }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type ClientEventInput = z.input<typeof clientEventSchema>;

export type PresenceStatus = 'online' | 'offline';

export type ServerEvent =
  | { type: 'hello'; userId: string; connectionId: string }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string; clientId?: string }
  | { type: 'message.ack'; clientId: string; message: Message }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'message.deleted'; channelId: string; messageId: string }
  | { type: 'typing'; channelId: string; user: UserSummary }
  | ({ type: 'read'; channelId: string } & ReadPointer)
  | { type: 'presence'; workspaceId: string; userId: string; status: PresenceStatus }
  | { type: 'presence.snapshot'; workspaceId: string; online: string[] }
  | { type: 'channel.created'; channel: Omit<Channel, 'isMember' | 'unreadCount'> }
  | { type: 'channel.updated'; channel: Omit<Channel, 'isMember' | 'unreadCount'> }
  | { type: 'channel.deleted'; workspaceId: string; channelId: string }
  | { type: 'channel.member.joined'; channelId: string; user: UserSummary }
  | { type: 'channel.member.left'; channelId: string; userId: string }
  /** Sent to one user when they were added to (or removed from) a channel. */
  | { type: 'channel.access'; workspaceId: string; channelId: string; granted: boolean }
  | { type: 'workspace.member.joined'; workspaceId: string; user: UserSummary }
  | { type: 'workspace.member.left'; workspaceId: string; userId: string }
  /** Sent to the mentioned user only. */
  | { type: 'notification.created'; notification: AppNotification }
  /** Keeps the bell in sync across the user's tabs. */
  | { type: 'notification.read'; ids: string[] };

/** How long a typing indicator stays visible without a new typing event. */
export const TYPING_TTL_MS = 5000;
/** Clients should not send typing events more often than this. */
export const TYPING_THROTTLE_MS = 2000;
