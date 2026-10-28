'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MESSAGE_MAX_LENGTH, MANAGER_ROLES, TYPING_THROTTLE_MS, type Channel, type ServerEvent } from '@convo/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { joinNames } from '@/lib/format';
import { keys, useChannels, useMe, useMembers, useMessages, useWorkspace } from '@/lib/queries';
import { IconHash, IconLock, IconSend, IconUsers } from './icons';
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

function Composer({ channel, onSend }: { channel: Channel; onSend: (content: string) => void }) {
  const { client } = useRealtime();
  const [value, setValue] = useState('');
  const lastTyping = useRef(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const content = value.trim();
    if (!content || content.length > MESSAGE_MAX_LENGTH) return;
    onSend(content);
    setValue('');
    lastTyping.current = 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (next: string) => {
    setValue(next);
    const now = Date.now();
    if (next.trim() && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      client.send({ type: 'typing', channelId: channel.id });
    }
  };

  // Grow with the content, up to a limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const tooLong = value.length > MESSAGE_MAX_LENGTH;
  return (
    <div className="px-4 pb-4">
      <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={`Message #${channel.name}`}
          aria-label={`Message #${channel.name}`}
          className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm placeholder:text-subtle focus:outline-none"
        />
        <Button size="sm" onClick={submit} disabled={!value.trim() || tooLong} aria-label="Send message">
          <IconSend />
        </Button>
      </div>
      <p className={cn('mt-1 px-1 text-[11px] text-subtle', tooLong && 'text-danger')}>
        {value.length > MESSAGE_MAX_LENGTH - 500
          ? `${value.length} / ${MESSAGE_MAX_LENGTH}`
          : 'Enter to send · Shift + Enter for a new line'}
      </p>
    </div>
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
    (clientId: string, content: string) => {
      const sent = client.send({ type: 'message.send', channelId, content, clientId });
      if (!sent) return fail(clientId, 'You are offline.');
      ackTimers.current.set(
        clientId,
        window.setTimeout(() => fail(clientId, 'No response from the server.'), ACK_TIMEOUT_MS),
      );
    },
    [channelId, client, fail],
  );

  const send = (content: string) => {
    const clientId = crypto.randomUUID();
    setOutgoing((list) => [...list, { clientId, content, createdAt: new Date().toISOString(), status: 'sending' }]);
    transmit(clientId, content);
  };

  const retry = (clientId: string) => {
    const item = outgoing.find((o) => o.clientId === clientId);
    if (!item) return;
    setOutgoing((list) =>
      list.map((o) => (o.clientId === clientId ? { ...o, status: 'sending', error: undefined } : o)),
    );
    transmit(clientId, item.content);
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
        <Composer channel={channel} onSend={send} />
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
