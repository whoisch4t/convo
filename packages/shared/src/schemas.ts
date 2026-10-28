import { z } from 'zod';
import { WORKSPACE_ROLES } from './enums';

const id = z.string().min(1).max(64);

// ---------- Auth ----------

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  email: z.email('Enter a valid email').trim().toLowerCase().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.email('Enter a valid email').trim().toLowerCase(),
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.input<typeof loginSchema>;

// ---------- Workspaces ----------

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name is required').max(60),
});
export type WorkspaceCreateInput = z.input<typeof workspaceCreateSchema>;

export const joinWorkspaceSchema = z.object({
  inviteCode: z.string().trim().min(1, 'Invite code is required').max(64),
});
export type JoinWorkspaceInput = z.input<typeof joinWorkspaceSchema>;

export const memberRoleSchema = z.object({ role: z.enum(WORKSPACE_ROLES) });

// ---------- Channels ----------

/** Lowercase, digits, dashes and underscores, like Slack channel names. */
export const channelNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\s+/g, '-'))
  .pipe(
    z
      .string()
      .min(1, 'Channel name is required')
      .max(40, 'Use at most 40 characters')
      .regex(/^[\p{L}\p{N}_-]+$/u, 'Use letters, numbers, dashes and underscores only'),
  );

export const channelCreateSchema = z.object({
  name: channelNameSchema,
  topic: z.string().trim().max(250).optional().default(''),
  isPrivate: z.boolean().default(false),
});
export type ChannelCreateInput = z.input<typeof channelCreateSchema>;

export const channelUpdateSchema = z.object({ name: channelNameSchema, topic: z.string().trim().max(250) }).partial();
export type ChannelUpdateInput = z.input<typeof channelUpdateSchema>;

export const channelAddMemberSchema = z.object({ userId: id });

// ---------- Messages ----------

export const MESSAGE_MAX_LENGTH = 4000;

export const messageContentSchema = z
  .string()
  .trim()
  .min(1, 'Message cannot be empty')
  .max(MESSAGE_MAX_LENGTH, `Messages can be at most ${MESSAGE_MAX_LENGTH} characters`);

export const messageCreateSchema = z.object({ content: messageContentSchema });
export type MessageCreateInput = z.input<typeof messageCreateSchema>;

export const messageListQuerySchema = z.object({
  /** Return messages older than this message id. */
  before: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const readSchema = z.object({ messageId: id });

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  channelId: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
