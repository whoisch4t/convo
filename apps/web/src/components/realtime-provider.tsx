'use client';

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  TYPING_TTL_MS,
  type Channel,
  type Message,
  type NotificationList,
  type ServerEvent,
  type UserSummary,
} from '@convo/shared';
import { RealtimeClient, type ConnectionStatus } from '@/lib/realtime';
import { keys, type MessagesData } from '@/lib/queries';

interface TypingEntry {
  user: UserSummary;
  expiresAt: number;
}

interface RealtimeContextValue {
  client: RealtimeClient;
  status: ConnectionStatus;
  online: Set<string>;
  /** channelId -> people typing there (never includes the current user). */
  typing: Map<string, TypingEntry[]>;
  /** The channel on screen; its new messages are not counted as unread. */
  setActiveChannel: (channelId: string | null) => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return ctx;
}

// ---------- Cache helpers ----------

export function upsertMessage(qc: QueryClient, message: Message) {
  qc.setQueryData<MessagesData>(keys.messages(message.channelId), (data) => {
    if (!data) return data;
    const exists = data.pages.some((p) => p.items.some((m) => m.id === message.id));
    const pages = data.pages.map((page, i) => {
      if (exists) return { ...page, items: page.items.map((m) => (m.id === message.id ? message : m)) };
      return i === 0 ? { ...page, items: [...page.items, message] } : page;
    });
    return { ...data, pages };
  });
}

function removeMessage(qc: QueryClient, channelId: string, messageId: string) {
  qc.setQueryData<MessagesData>(
    keys.messages(channelId),
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((p) => ({ ...p, items: p.items.filter((m) => m.id !== messageId) })),
      },
  );
}

function updateChannel(qc: QueryClient, workspaceId: string, channelId: string, patch: (c: Channel) => Channel) {
  qc.setQueryData<Channel[]>(keys.channels(workspaceId), (list) =>
    list?.map((c) => (c.id === channelId ? patch(c) : c)),
  );
}

// ---------- Provider ----------

export function RealtimeProvider({
  workspaceId,
  userId,
  children,
}: {
  workspaceId: string;
  userId: string;
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [client] = useState(() => new RealtimeClient());
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [typing, setTyping] = useState<Map<string, TypingEntry[]>>(new Map());
  const activeChannel = useRef<string | null>(null);

  const status = useSyncExternalStore(
    (cb) => client.onStatus(cb),
    () => client.status,
    () => 'connecting' as ConnectionStatus,
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  useEffect(() => {
    client.subscribeWorkspace(workspaceId);
  }, [client, workspaceId]);

  // Anything could have happened while disconnected: refetch what is on screen.
  useEffect(
    () =>
      client.onReconnect(() => {
        void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });
        void qc.invalidateQueries({ queryKey: keys.members(workspaceId) });
        void qc.invalidateQueries({ queryKey: keys.notifications(workspaceId) });
        if (activeChannel.current) void qc.resetQueries({ queryKey: keys.messages(activeChannel.current) });
      }),
    [client, qc, workspaceId],
  );

  // Expire typing indicators.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTyping((current) => {
        const now = Date.now();
        let changed = false;
        const next = new Map<string, TypingEntry[]>();
        for (const [channelId, entries] of current) {
          const live = entries.filter((e) => e.expiresAt > now);
          if (live.length !== entries.length) changed = true;
          if (live.length) next.set(channelId, live);
        }
        return changed ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stopTyping = (channelId: string, typingUserId: string) =>
      setTyping((current) => {
        const entries = current.get(channelId);
        if (!entries?.some((e) => e.user.id === typingUserId)) return current;
        const next = new Map(current);
        next.set(
          channelId,
          entries.filter((e) => e.user.id !== typingUserId),
        );
        return next;
      });

    return client.on((event: ServerEvent) => {
      switch (event.type) {
        case 'message.created': {
          const { message } = event;
          upsertMessage(qc, message);
          stopTyping(message.channelId, message.author.id);
          if (message.author.id !== userId && activeChannel.current !== message.channelId) {
            updateChannel(qc, workspaceId, message.channelId, (c) =>
              c.isMember ? { ...c, unreadCount: c.unreadCount + 1 } : c,
            );
          }
          break;
        }
        case 'message.updated':
          upsertMessage(qc, event.message);
          break;
        case 'message.deleted':
          removeMessage(qc, event.channelId, event.messageId);
          break;
        case 'read': {
          const { channelId, type: _t, ...pointer } = event;
          qc.setQueryData<MessagesData>(keys.messages(channelId), (data) => {
            if (!data?.pages[0]) return data;
            const [first, ...rest] = data.pages;
            const readPointers = [...first.readPointers.filter((p) => p.userId !== pointer.userId), pointer];
            return { ...data, pages: [{ ...first, readPointers }, ...rest] };
          });
          // Reading in another tab clears the badge here too.
          if (pointer.userId === userId) updateChannel(qc, workspaceId, channelId, (c) => ({ ...c, unreadCount: 0 }));
          break;
        }
        case 'typing': {
          if (event.user.id === userId) break;
          setTyping((current) => {
            const next = new Map(current);
            const others = (current.get(event.channelId) ?? []).filter((e) => e.user.id !== event.user.id);
            next.set(event.channelId, [...others, { user: event.user, expiresAt: Date.now() + TYPING_TTL_MS }]);
            return next;
          });
          break;
        }
        case 'presence.snapshot':
          if (event.workspaceId === workspaceId) setOnline(new Set(event.online));
          break;
        case 'presence':
          if (event.workspaceId !== workspaceId) break;
          setOnline((current) => {
            const next = new Set(current);
            if (event.status === 'online') next.add(event.userId);
            else next.delete(event.userId);
            return next;
          });
          break;
        case 'channel.created':
        case 'channel.updated':
        case 'channel.deleted':
        case 'channel.access':
        case 'channel.member.joined':
        case 'channel.member.left':
          void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });
          if ('channelId' in event) void qc.invalidateQueries({ queryKey: keys.channelMembers(event.channelId) });
          if (event.type === 'channel.deleted' && activeChannel.current === event.channelId) {
            router.replace(`/w/${workspaceId}`);
          }
          if (event.type === 'channel.access' && !event.granted && activeChannel.current === event.channelId) {
            void qc.resetQueries({ queryKey: keys.messages(event.channelId) });
          }
          break;
        case 'notification.created': {
          const { notification } = event;
          if (notification.workspaceId !== workspaceId) break;
          qc.setQueryData<NotificationList>(
            keys.notifications(workspaceId),
            (data) =>
              data && {
                items: [notification, ...data.items.filter((n) => n.id !== notification.id)],
                unreadCount: data.unreadCount + 1,
              },
          );
          break;
        }
        case 'notification.read':
          // The ids may include notifications outside the loaded page, so ask for the real count.
          void qc.invalidateQueries({ queryKey: keys.notifications(workspaceId) });
          break;
        case 'workspace.member.joined':
        case 'workspace.member.left':
          void qc.invalidateQueries({ queryKey: keys.members(workspaceId) });
          if (event.type === 'workspace.member.left' && event.userId === userId && event.workspaceId === workspaceId) {
            void qc.invalidateQueries({ queryKey: keys.workspaces });
            router.replace('/workspaces');
          }
          break;
      }
    });
  }, [client, qc, router, userId, workspaceId]);

  const value: RealtimeContextValue = {
    client,
    status,
    online,
    typing,
    setActiveChannel: (channelId) => {
      activeChannel.current = channelId;
      client.focusChannel(channelId);
    },
  };

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
