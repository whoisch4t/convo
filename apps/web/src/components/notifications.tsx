'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppNotification, NotificationList } from '@convo/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatFull, formatTime, sameDay } from '@/lib/format';
import { keys, useMe, useMembers, useNotifications } from '@/lib/queries';
import { Avatar } from './avatar';
import { IconBell } from './icons';
import { MessageText } from './message-content';
import { Spinner } from './ui';

/** Bell with the unread mention count and a panel listing recent mentions in this workspace. */
export function NotificationBell({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const members = useMembers(workspaceId);
  const notifications = useNotifications(workspaceId);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const names = useMemo(() => new Map(members.data?.map((m) => [m.user.id, m.user.name])), [members.data]);

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api('/notifications/read', { method: 'POST', body: { workspaceId, ids } }),
    onMutate: (ids) => {
      // Update right away; the server confirms with a notification.read event.
      qc.setQueryData<NotificationList>(keys.notifications(workspaceId), (data) => {
        if (!data) return data;
        const now = new Date().toISOString();
        const hit = (n: AppNotification) => n.readAt === null && (!ids || ids.includes(n.id));
        const cleared = data.items.filter(hit).length;
        return {
          items: data.items.map((n) => (hit(n) ? { ...n, readAt: now } : n)),
          unreadCount: ids ? Math.max(0, data.unreadCount - cleared) : 0,
        };
      });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = notifications.data?.unreadCount ?? 0;
  const items = notifications.data?.items ?? [];

  const openNotification = (n: AppNotification) => {
    if (n.readAt === null) markRead.mutate([n.id]);
    setOpen(false);
    router.push(`/w/${workspaceId}/c/${n.channel.id}`);
  };

  return (
    <div ref={root} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
        aria-label={unread > 0 ? `Mentions, ${unread} unread` : 'Mentions'}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <IconBell className="size-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Mentions"
          className="absolute top-full left-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <h2 className="text-sm font-semibold">Mentions</h2>
            {unread > 0 && (
              <button
                onClick={() => markRead.mutate(undefined)}
                className="text-xs font-medium text-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
          </div>
          <div className="scroll-thin max-h-96 overflow-y-auto">
            {notifications.isPending ? (
              <div className="flex justify-center p-6 text-muted">
                <Spinner />
              </div>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                No mentions yet. When someone @mentions you, it shows up here.
              </p>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openNotification(n)}
                      className={cn(
                        'flex w-full gap-3 px-4 py-3 text-left hover:bg-surface-2',
                        n.readAt === null && 'bg-primary-soft/50',
                      )}
                    >
                      <Avatar user={n.actor} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">
                          <span className="font-semibold">{n.actor.name}</span>
                          <span className="text-muted"> in </span>
                          <span className="font-medium">#{n.channel.name}</span>
                        </span>
                        <span className="line-clamp-2 text-sm break-words text-muted">
                          <MessageText content={n.message.content} names={names} meId={me.data?.id ?? ''} />
                        </span>
                        <time dateTime={n.createdAt} title={formatFull(n.createdAt)} className="text-xs text-subtle">
                          {sameDay(n.createdAt, new Date().toISOString())
                            ? formatTime(n.createdAt)
                            : formatFull(n.createdAt)}
                        </time>
                      </span>
                      {n.readAt === null && (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
