'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_UPLOAD_BYTES,
  MESSAGE_MAX_LENGTH,
  TYPING_THROTTLE_MS,
  type Attachment,
  type Channel,
  type UserSummary,
} from '@convo/shared';
import { ApiError, uploadFile } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { toWire, type MentionRef } from '@/lib/mentions';
import { Avatar } from './avatar';
import { IconFile, IconPaperclip, IconSend, IconX } from './icons';
import { useRealtime } from './realtime-provider';
import { Button, Spinner } from './ui';

interface PendingFile {
  key: string;
  file: File;
  previewUrl?: string;
  status: 'uploading' | 'done' | 'failed';
  attachment?: Attachment;
  error?: string;
}

const MAX_SUGGESTIONS = 6;

/** "@que" right before the caret, at the start of the text or after a space. */
function mentionQuery(value: string, caret: number) {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]{0,30})$/.exec(before);
  return match ? { text: match[1]!, start: caret - match[1]!.length - 1 } : null;
}

export function Composer({
  channel,
  candidates,
  meId,
  onSend,
}: {
  channel: Channel;
  /** People who can see the channel, offered after typing @. */
  candidates: UserSummary[];
  meId: string;
  onSend: (content: string, attachments: Attachment[]) => void;
}) {
  const { client } = useRealtime();
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionRef[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastTyping = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  // ---------- Mentions ----------

  const query = mentionQuery(value, caret);
  const suggestions = useMemo(() => {
    if (!query || query.start === dismissedAt) return [];
    const q = query.text.toLocaleLowerCase();
    return candidates.filter((u) => u.id !== meId && u.name.toLocaleLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  }, [candidates, dismissedAt, meId, query]);

  useEffect(() => setActive(0), [query?.text]);

  const pick = (user: UserSummary) => {
    if (!query) return;
    const inserted = `@${user.name} `;
    const next = value.slice(0, query.start) + inserted + value.slice(caret);
    const position = query.start + inserted.length;
    setValue(next);
    setCaret(position);
    setMentions((list) => [...list, { id: user.id, name: user.name }]);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(position, position));
  };

  // ---------- Files ----------

  const updateFile = (key: string, patch: Partial<PendingFile>) =>
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const addFiles = (list: FileList | File[]) => {
    const room = MAX_ATTACHMENTS_PER_MESSAGE - files.length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    const added: PendingFile[] = picked.map((file) => ({
      key: crypto.randomUUID(),
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      status: file.size > MAX_UPLOAD_BYTES ? 'failed' : 'uploading',
      error: file.size > MAX_UPLOAD_BYTES ? `Larger than ${formatBytes(MAX_UPLOAD_BYTES)}` : undefined,
    }));
    setFiles((current) => [...current, ...added]);
    for (const item of added) {
      if (item.status !== 'uploading') continue;
      uploadFile(channel.id, item.file)
        .then((attachment) => updateFile(item.key, { status: 'done', attachment }))
        .catch((err: unknown) =>
          updateFile(item.key, {
            status: 'failed',
            error: err instanceof ApiError ? err.message : 'Upload failed',
          }),
        );
    }
  };

  const removeFile = (key: string) =>
    setFiles((list) => {
      const item = list.find((f) => f.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return list.filter((f) => f.key !== key);
    });

  // Free preview URLs when the composer goes away.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    },
    [],
  );

  // ---------- Sending ----------

  const ready = files.filter((f) => f.status === 'done');
  const uploading = files.some((f) => f.status === 'uploading');
  const tooLong = value.length > MESSAGE_MAX_LENGTH;
  const canSend = (value.trim().length > 0 || ready.length > 0) && !uploading && !tooLong;

  const submit = () => {
    if (!canSend) return;
    onSend(
      toWire(value.trim(), mentions),
      ready.map((f) => f.attachment!),
    );
    for (const f of files) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setValue('');
    setMentions([]);
    setFiles([]);
    lastTyping.current = 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(suggestions[active]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(query!.start);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onChange = (next: string, position: number) => {
    setValue(next);
    setCaret(position);
    const now = Date.now();
    if (next.trim() && now - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = now;
      client.send({ type: 'typing', channelId: channel.id });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
  };

  // Grow with the content, up to a limit.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="px-4 pb-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'relative rounded-xl border border-border bg-surface p-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
          dragging && 'border-primary ring-2 ring-primary/20',
        )}
      >
        {suggestions.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention someone"
            className="absolute bottom-full left-2 z-20 mb-2 w-64 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
          >
            {suggestions.map((user, i) => (
              <li
                key={user.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(user);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm',
                  i === active && 'bg-primary-soft text-primary',
                )}
              >
                <Avatar user={user} size="sm" />
                <span className="truncate">{user.name}</span>
              </li>
            ))}
          </ul>
        )}

        {files.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
            {files.map((f) => (
              <li
                key={f.key}
                className={cn(
                  'relative flex max-w-56 items-center gap-2 rounded-lg border border-border bg-surface-2 p-1.5 pr-7 text-xs',
                  f.status === 'failed' && 'border-danger/60',
                )}
              >
                {f.previewUrl ? (
                  // Local blob preview of a file that is not uploaded yet.
                  <img src={f.previewUrl} alt="" className="size-9 shrink-0 rounded object-cover" />
                ) : (
                  <IconFile className="size-6 shrink-0 text-primary" />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{f.file.name}</span>
                  <span className={cn('flex items-center gap-1 text-muted', f.status === 'failed' && 'text-danger')}>
                    {f.status === 'uploading' && <Spinner className="size-3" />}
                    {f.status === 'failed' ? f.error : formatBytes(f.file.size)}
                  </span>
                </span>
                <button
                  onClick={() => removeFile(f.key)}
                  className="absolute top-1 right-1 grid size-5 place-items-center rounded text-muted hover:bg-surface hover:text-fg"
                  aria-label={`Remove ${f.file.name}`}
                >
                  <IconX className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            aria-label="Attach files"
            title={`Attach files (up to ${MAX_ATTACHMENTS_PER_MESSAGE}, ${formatBytes(MAX_UPLOAD_BYTES)} each)`}
          >
            <IconPaperclip className="size-5" />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={textarea}
            value={value}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder={`Message #${channel.name}`}
            aria-label={`Message #${channel.name}`}
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={suggestions.length > 0 ? `${listId}-${active}` : undefined}
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm placeholder:text-subtle focus:outline-none"
          />
          <Button size="sm" onClick={submit} disabled={!canSend} aria-label="Send message">
            <IconSend />
          </Button>
        </div>
      </div>
      <p className={cn('mt-1 px-1 text-[11px] text-subtle', tooLong && 'text-danger')}>
        {value.length > MESSAGE_MAX_LENGTH - 500
          ? `${value.length} / ${MESSAGE_MAX_LENGTH}`
          : 'Enter to send · Shift + Enter for a new line · @ to mention'}
      </p>
    </div>
  );
}
