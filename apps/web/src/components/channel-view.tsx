'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MANAGER_ROLES, type Attachment, type Channel, type ServerEvent } from '@convo/shared';
import { api } from '@/lib/api';
import { joinNames } from '@/lib/format';
import { keys, useChannelMembers, useChannels, useMe, useMembers, useMessages, useWorkspace } from '@/lib/queries';
import { Composer } from './composer';
import { IconHash, IconLock, IconUsers } from './icons';
import { MessageList, type OutgoingMessage } from './message-list';
import { AddPeopleModal } from './modals';
import { upsertMessage, useRealtime } from './realtime-provider';
import { Button, ErrorBlock, LoadingBlock } from './ui';

const ACK_TIMEOUT_MS = 10_000;

function TypingIndicator({ channelId }: { channelId: string }) {
  const { typing } = useRealtime();
  const names = (typing.get(channelId) ?? []).map((e) => e.user.name.split(' ')[0]!);
  return (
    <p className="h-5 px-5 text-xs text-muted italic" aria-live="polite">
      {names.length === 1 && `${names[0]} is typing…`}
      {names.length > 1 && `${joinNames(names)} are typing…`}
    </p>
  );
}

export function ChannelView({ workspaceId, channelId }: { workspaceId: string; channelId: string }) {
  const qc = useQueryClient();
  const { client, setActiveChannel } = useRealtime();
  const me = useMe();
  const workspace = useWorkspace(workspaceId);
  const channels = useChannels(workspaceId);
  const members = useMembers(workspaceId);
  const messages = useMessages(channelId);
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  const [unreadAfter, setUnreadAfter] = useState<string | null | undefined>(undefined);
  const [addPeople, setAddPeople] = useState(false);
  const ackTimers = useRef(new Map<string, number>());

  const channel = channels.data?.find((c) => c.id === channelId);
  const meId = me.data?.id ?? '';

  useEffect(() => {
    setActiveChannel(channelId);
    return () => setActiveChannel(null);
  }, [channelId, setActiveChannel]);

  const items = useMemo(
    () => (messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.items) : []),
    [messages.data],
  );
  const readPointers = messages.data?.pages[0]?.readPointers ?? [];

  // Remember where I had read up to when the channel opened, for the "New messages" divider.
  useEffect(() => {
    if (unreadAfter !== undefined || !messages.data || !meId) return;
    const mine = messages.data.pages[0]?.readPointers.find((p) => p.userId === meId);
    setUnreadAfter(mine?.at ?? null);
  }, [messages.data, meId, unreadAfter]);

  // ---------- Sending with optimistic rows ----------

  const fail = useCallback((clientId: string, error?: string) => {
    window.clearTimeout(ackTimers.current.get(clientId));
    setOutgoing((list) => list.map((o) => (o.clientId === clientId ? { ...o, status: 'failed', error } : o)));
  }, []);

  const transmit = useCallback(
    (clientId: string, content: string, attachments: Attachment[]) => {
      const attachmentIds = attachments.map((a) => a.id);
      const sent = client.send({ type: 'message.send', channelId, content, attachmentIds, clientId });
      if (!sent) return fail(clientId, 'You are offline.');
      ackTimers.current.set(
        clientId,
        window.setTimeout(() => fail(clientId, 'No response from the server.'), ACK_TIMEOUT_MS),
      );
    },
    [channelId, client, fail],
  );

  const send = (content: string, attachments: Attachment[]) => {
    const clientId = crypto.randomUUID();
    setOutgoing((list) => [
      ...list,
      { clientId, content, attachments, createdAt: new Date().toISOString(), status: 'sending' },
    ]);
    transmit(clientId, content, attachments);
  };

  const retry = (clientId: string) => {
    const item = outgoing.find((o) => o.clientId === clientId);
    if (!item) return;
    setOutgoing((list) =>
      list.map((o) => (o.clientId === clientId ? { ...o, status: 'sending', error: undefined } : o)),
    );
    transmit(clientId, item.content, item.attachments);
  };

  useEffect(() => {
    const timers = ackTimers.current;
    const off = client.on((event: ServerEvent) => {
      if (event.type === 'message.ack') {
        window.clearTimeout(timers.get(event.clientId));
        timers.delete(event.clientId);
        upsertMessage(qc, event.message);
        setOutgoing((list) => list.filter((o) => o.clientId !== event.clientId));
      } else if (event.type === 'error' && event.clientId) {
        fail(event.clientId, event.message);
      }
    });
    return () => {
      off();
      for (const t of timers.values()) window.clearTimeout(t);
    };
  }, [client, qc, fail]);

  // ---------- Read pointer ----------

  const lastId = items.at(-1)?.id;
  const myPointer = readPointers.find((p) => p.userId === meId)?.messageId;
  useEffect(() => {
    if (!channel?.isMember || !lastId || lastId === myPointer) return;
    const markRead = () => {
      if (document.visibilityState !== 'visible') return;
      if (!client.send({ type: 'read', channelId, messageId: lastId })) {
        void api(`/channels/${channelId}/read`, { method: 'POST', body: { messageId: lastId } }).catch(() => {});
      }
      qc.setQueryData<Channel[]>(keys.channels(workspaceId), (list) =>
        list?.map((c) => (c.id === channelId ? { ...c, unreadCount: 0 } : c)),
      );
    };
    const timer = window.setTimeout(markRead, 400);
    document.addEventListener('visibilitychange', markRead);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', markRead);
    };
  }, [channel?.isMember, channelId, client, lastId, myPointer, qc, workspaceId]);

  // ---------- Membership ----------

  const join = useMutation({
    mutationFn: () => api(`/channels/${channelId}/join`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });
  const leave = useMutation({
    mutationFn: () => api(`/channels/${channelId}/leave`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) }),
  });

  const names = useMemo(() => new Map(members.data?.map((m) => [m.user.id, m.user.name])), [members.data]);
  // Mention suggestions: everyone who can see the channel.
  const channelMembers = useChannelMembers(channelId);
  const candidates = useMemo(
    () => (channel?.isPrivate ? (channelMembers.data ?? []) : (members.data ?? []).map((m) => m.user)),
    [channel?.isPrivate, channelMembers.data, members.data],
  );
  const canModerate = !!workspace.data && MANAGER_ROLES.includes(workspace.data.role);
  const loadOlder = useCallback(() => void messages.fetchNextPage(), [messages]);

  if (channels.isPending || me.isPending) return <LoadingBlock label="Loading channel…" />;
  if (!channel) return <ErrorBlock message="This channel does not exist or you do not have access to it." />;

  const Icon = channel.isPrivate ? IconLock : IconHash;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-[61px] items-center gap-3 border-b border-border py-3 pr-5 pl-13 lg:pl-5">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 font-semibold">
            <Icon className="size-4 text-muted" />
            <span className="truncate">{channel.name}</span>
          </h1>
          {channel.topic && <p className="truncate text-xs text-muted">{channel.topic}</p>}
        </div>
        <span className="hidden items-center gap-1 text-xs text-muted sm:flex" title="Members">
          <IconUsers /> {channel.memberCount}
        </span>
        {channel.isMember && channel.isPrivate && (
          <Button size="sm" variant="secondary" onClick={() => setAddPeople(true)}>
            Add people
          </Button>
        )}
        {channel.isMember && channel.name !== 'general' && (
          <Button size="sm" variant="ghost" loading={leave.isPending} onClick={() => leave.mutate()}>
            Leave
          </Button>
        )}
      </header>

      {messages.isPending ? (
        <LoadingBlock label="Loading messages…" />
      ) : messages.isError ? (
        <ErrorBlock message="Could not load messages." onRetry={() => void messages.refetch()} retryLabel="Retry" />
      ) : (
        <MessageList
          messages={items}
          outgoing={outgoing}
          readPointers={readPointers}
          meId={meId}
          canModerate={canModerate}
          names={names}
          hasMore={messages.hasNextPage}
          loadingOlder={messages.isFetchingNextPage}
          onLoadOlder={loadOlder}
          unreadAfter={unreadAfter ?? null}
          onRetry={retry}
        />
      )}

      <TypingIndicator channelId={channelId} />
      {channel.isMember ? (
        <Composer key={channel.id} channel={channel} candidates={candidates} meId={meId} onSend={send} />
      ) : (
        <div className="mx-4 mb-4 flex flex-col items-center gap-2 rounded-xl border border-border bg-surface-2 p-4 text-sm sm:flex-row sm:justify-between">
          <span className="text-muted">You are viewing #{channel.name}. Join to post messages.</span>
          <Button size="sm" loading={join.isPending} onClick={() => join.mutate()}>
            Join channel
          </Button>
        </div>
      )}

      <AddPeopleModal
        workspaceId={workspaceId}
        channel={channel}
        open={addPeople}
        onClose={() => setAddPeople(false)}
      />
    </div>
  );
}
