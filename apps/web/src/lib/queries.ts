import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import type { Channel, MessagePage, NotificationList, User, Workspace, WorkspaceMember } from '@convo/shared';
import { api } from './api';

export const keys = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  channels: (workspaceId: string) => ['channels', workspaceId] as const,
  members: (workspaceId: string) => ['members', workspaceId] as const,
  channelMembers: (channelId: string) => ['channel-members', channelId] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  notifications: (workspaceId: string) => ['notifications', workspaceId] as const,
};

export const useNotifications = (workspaceId: string) =>
  useQuery({
    queryKey: keys.notifications(workspaceId),
    queryFn: () => api<NotificationList>('/notifications', { query: { workspaceId } }),
  });

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: () => api<{ user: User }>('/auth/me').then((r) => r.user) });

export const useWorkspaces = () =>
  useQuery({
    queryKey: keys.workspaces,
    queryFn: () => api<{ items: Workspace[] }>('/workspaces').then((r) => r.items),
  });

export const useWorkspace = (id: string) =>
  useQuery({
    queryKey: keys.workspace(id),
    queryFn: () => api<{ workspace: Workspace }>(`/workspaces/${id}`).then((r) => r.workspace),
  });

export const useChannels = (workspaceId: string) =>
  useQuery({
    queryKey: keys.channels(workspaceId),
    queryFn: () => api<{ items: Channel[] }>(`/workspaces/${workspaceId}/channels`).then((r) => r.items),
  });

export const useMembers = (workspaceId: string) =>
  useQuery({
    queryKey: keys.members(workspaceId),
    queryFn: () => api<{ items: WorkspaceMember[] }>(`/workspaces/${workspaceId}/members`).then((r) => r.items),
    staleTime: 60_000,
  });

export const useChannelMembers = (channelId: string) =>
  useQuery({
    queryKey: keys.channelMembers(channelId),
    queryFn: () =>
      api<{ items: { user: { id: string; name: string } }[] }>(`/channels/${channelId}/members`).then((r) =>
        r.items.map((m) => m.user),
      ),
  });

export type MessagesData = InfiniteData<MessagePage, string | undefined>;

/**
 * Message history as an infinite query. pages[0] is the newest page; live messages are
 * appended to it, and older pages are added as the user scrolls up.
 */
export const useMessages = (channelId: string) =>
  useInfiniteQuery({
    queryKey: keys.messages(channelId),
    queryFn: ({ pageParam }) =>
      api<MessagePage>(`/channels/${channelId}/messages`, { query: { before: pageParam, limit: 50 } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.items[0]?.id : undefined),
    // Live updates keep it fresh; refetching would reset scroll position.
    staleTime: Infinity,
  });
