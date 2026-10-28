// Shapes returned by the REST API and pushed over the WebSocket (dates are ISO strings).
import type { WorkspaceRole } from './enums';

export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export type UserSummary = Pick<User, 'id' | 'name'>;

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  role: WorkspaceRole;
  /** Only included for owners and admins. */
  inviteCode?: string;
}

export interface WorkspaceMember {
  user: UserSummary & { email: string };
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  topic: string;
  isPrivate: boolean;
  createdAt: string;
  /** Whether the current user has joined this channel. */
  isMember: boolean;
  /** Messages from others after the current user's read pointer. 0 when not a member. */
  unreadCount: number;
  memberCount: number;
}

export interface Message {
  id: string;
  channelId: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  author: UserSummary;
}

/** A member has read everything up to and including `messageId`. */
export interface ReadPointer {
  userId: string;
  messageId: string;
  /** createdAt of that message, so clients can compare it with any other message. */
  at: string;
}

export interface MessagePage {
  items: Message[];
  /** True when older messages exist. */
  hasMore: boolean;
  /** Where every channel member has read up to, for read receipts. */
  readPointers: ReadPointer[];
}

export interface SearchResult extends Message {
  channel: { id: string; name: string };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}
