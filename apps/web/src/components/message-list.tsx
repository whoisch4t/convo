'use client';

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MESSAGE_MAX_LENGTH, type Message, type ReadPointer } from '@convo/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDay, formatFull, formatTime, joinNames, sameDay } from '@/lib/format';
import { Avatar } from './avatar';
import { IconPencil, IconTrash } from './icons';
import { upsertMessage } from './realtime-provider';
import { Button, Spinner } from './ui';

export interface OutgoingMessage {
  clientId: string;
  content: string;
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
}

const GROUP_WINDOW_MS = 5 * 60_000;

function MessageRow({
  message,
  compact,
  canEdit,
  canDelete,
}: {
  message: Message;
  compact: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = useMutation({
    mutationFn: (content: string) =>
      api<{ message: Message }>(`/messages/${message.id}`, { method: 'PATCH', body: { content } }),
    onSuccess: ({ message: updated }) => {
      upsertMessage(qc, updated);
      setEditing(false);
    },
  });
  const remove = useMutation({ mutationFn: () => api(`/messages/${message.id}`, { method: 'DELETE' }) });

  const onEditKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setEditing(false);
      setDraft(message.content);
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const content = draft.trim();
      if (content && content !== message.content) save.mutate(content);
      else setEditing(false);
    }
  };

  return (
    <div
      className={cn('group relative flex gap-3 px-5 hover:bg-surface-2/60', compact ? 'py-0.5' : 'mt-2 pt-1.5 pb-0.5')}
      data-testid="message"
    >
      <div className="w-9 shrink-0">
        {compact ? (
          <time
            dateTime={message.createdAt}
            title={formatFull(message.createdAt)}
            className="invisible block pt-0.5 text-right text-[10px] text-subtle group-hover:visible"
          >
            {formatTime(message.createdAt)}
          </time>
        ) : (
          <Avatar user={message.author} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <p className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{message.author.name}</span>
            <time dateTime={message.createdAt} title={formatFull(message.createdAt)} className="text-xs text-subtle">
              {formatTime(message.createdAt)}
            </time>
          </p>
        )}
        {editing ? (
          <div className="my-1">
            <textarea
              autoFocus
              value={draft}
              maxLength={MESSAGE_MAX_LENGTH}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              aria-label="Edit message"
              className="w-full resize-none rounded-lg border border-primary bg-surface px-3 py-2 text-sm focus:outline-none"
              rows={Math.min(6, draft.split('\n').length)}
            />
            <p className="text-xs text-muted">
              Enter to save · Esc to cancel {save.isPending && <Spinner className="ml-1 inline size-3" />}
              {save.isError && <span className="ml-2 text-danger">Could not save</span>}
            </p>
          </div>
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">
            {message.content}
            {message.editedAt && (
              <span className="ml-1 text-xs text-subtle" title={`Edited ${formatFull(message.editedAt)}`}>
                (edited)
              </span>
            )}
          </p>
        )}
      </div>

      {(canEdit || canDelete) && !editing && (
        <div className="absolute -top-3 right-4 hidden items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
          {confirmDelete ? (
            <>
              <span className="px-2 text-xs text-muted">Delete?</span>
              <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              {canEdit && (
                <button
                  onClick={() => setEditing(true)}
                  className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                  aria-label="Edit message"
                >
                  <IconPencil />
                </button>
              )}
              {canDelete && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-danger"
                  aria-label="Delete message"
                >
                  <IconTrash />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Divider({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <div className={cn('my-3 flex items-center gap-3 px-5 text-xs font-medium', accent ? 'text-danger' : 'text-muted')}>
      <span className={cn('h-px flex-1', accent ? 'bg-danger/50' : 'bg-border')} />
      {label}
      <span className={cn('h-px flex-1', accent ? 'bg-danger/50' : 'bg-border')} />
    </div>
  );
}

export function MessageList({
  messages,
  outgoing,
  readPointers,
  meId,
  canModerate,
  names,
  hasMore,
  loadingOlder,
  onLoadOlder,
  unreadAfter,
  onRetry,
}: {
  messages: Message[];
  outgoing: OutgoingMessage[];
  readPointers: ReadPointer[];
  meId: string;
  canModerate: boolean;
  names: Map<string, string>;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Messages from others after this time get a "New messages" divider. */
  unreadAfter: string | null;
  onRetry: (clientId: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  const heightBeforeOlder = useRef<number | null>(null);

  // Load older messages when the top sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !loadingOlder && scroller.current) {
          heightBeforeOlder.current = scroller.current.scrollHeight - scroller.current.scrollTop;
          onLoadOlder();
        }
      },
      { root: scroller.current, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingOlder, onLoadOlder]);

  // Older messages were prepended: keep the same messages under the user's eyes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && heightBeforeOlder.current !== null) {
      el.scrollTop = el.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    }
  }, [firstId]);

  // New message at the bottom: follow it if the user was already at the bottom or sent it.
  const lastIsMine = messages.at(-1)?.author.id === meId;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom.current || lastIsMine || outgoing.length > 0) {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [lastId, lastIsMine, outgoing.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom.current) setShowJump(false);
  };

  const last = messages.at(-1);
  const seenBy = last
    ? readPointers
        .filter((p) => p.userId !== meId && p.userId !== last.author.id && p.at >= last.createdAt)
        .map((p) => names.get(p.userId))
        .filter((n): n is string => Boolean(n))
    : [];
  const firstUnread = unreadAfter
    ? messages.find((m) => m.createdAt > unreadAfter && m.author.id !== meId)?.id
    : undefined;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="scroll-thin h-full overflow-y-auto pb-2"
        role="log"
        aria-label="Messages"
        aria-live="polite"
      >
        <div ref={sentinel} />
        {hasMore ? (
          <div className="flex justify-center py-4 text-muted">{loadingOlder && <Spinner />}</div>
        ) : (
          <p className="px-5 pt-8 pb-2 text-sm text-muted">This is the very beginning of the channel.</p>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
          const isFirstUnread = m.id === firstUnread;
          const compact =
            !!prev &&
            !newDay &&
            !isFirstUnread &&
            prev.author.id === m.author.id &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
          return (
            <div key={m.id}>
              {newDay && <Divider label={formatDay(m.createdAt)} />}
              {isFirstUnread && <Divider label="New messages" accent />}
              <MessageRow
                message={m}
                compact={compact}
                canEdit={m.author.id === meId}
                canDelete={m.author.id === meId || canModerate}
              />
            </div>
          );
        })}

        {outgoing.map((o) => (
          <div key={o.clientId} className="flex gap-3 px-5 py-0.5" data-testid="outgoing">
            <div className="w-9 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm break-words whitespace-pre-wrap', o.status === 'sending' && 'text-muted')}>
                {o.content}
              </p>
              {o.status === 'sending' ? (
                <p className="text-xs text-subtle">Sending…</p>
              ) : (
                <p className="text-xs text-danger">
                  {o.error ?? 'Not sent.'}{' '}
                  <button className="font-medium underline" onClick={() => onRetry(o.clientId)}>
                    Retry
                  </button>
                </p>
              )}
            </div>
          </div>
        ))}

        {seenBy.length > 0 && (
          <p className="px-5 pt-1 text-right text-xs text-subtle" data-testid="seen-by">
            Seen by {joinNames(seenBy, 3)}
          </p>
        )}
      </div>

      {showJump && (
        <button
          onClick={() => {
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
            setShowJump(false);
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-fg shadow-lg"
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}
