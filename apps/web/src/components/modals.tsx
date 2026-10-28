'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  channelCreateSchema,
  type Channel,
  type ChannelCreateInput,
  type SearchResult,
  type Workspace,
} from '@convo/shared';
import { api, ApiError } from '@/lib/api';
import { formatFull } from '@/lib/format';
import { keys, useChannelMembers, useMembers } from '@/lib/queries';
import { Avatar } from './avatar';
import { IconCheck, IconHash, IconSearch } from './icons';
import { Button, Field, FormError, Input, Modal, Spinner } from './ui';

export function CreateChannelModal({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const form = useForm<ChannelCreateInput>({
    resolver: zodResolver(channelCreateSchema),
    defaultValues: { name: '', topic: '', isPrivate: false },
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (values: ChannelCreateInput) =>
      api<{ channel: Channel }>(`/workspaces/${workspaceId}/channels`, { method: 'POST', body: values }),
    onSuccess: ({ channel }) => {
      void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });
      form.reset();
      onClose();
      router.push(`/w/${workspaceId}/c/${channel.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.details.length) {
        for (const [path, message] of Object.entries(err.fieldErrors)) {
          form.setError(path as keyof ChannelCreateInput, { message });
        }
      } else setError('Could not create the channel.');
    },
  });

  return (
    <Modal open={open} onClose={onClose} title="Create a channel">
      <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Name" error={form.formState.errors.name?.message} hint="Lowercase, no spaces. e.g. design-review">
          {(p) => <Input {...p} autoFocus placeholder="design-review" {...form.register('name')} />}
        </Field>
        <Field label="Topic" optional error={form.formState.errors.topic?.message}>
          {(p) => <Input {...p} placeholder="What is this channel about?" {...form.register('topic')} />}
        </Field>
        <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--color-primary)]"
            {...form.register('isPrivate')}
          />
          <span>
            <span className="font-medium">Make private</span>
            <span className="block text-muted">Only people you add can see it.</span>
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function InviteModal({
  workspace,
  open,
  onClose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const rotate = useMutation({
    mutationFn: () => api<{ inviteCode: string }>(`/workspaces/${workspace.id}/invite-code`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.workspace(workspace.id) }),
  });

  const copy = async () => {
    if (!workspace.inviteCode) return;
    await navigator.clipboard.writeText(workspace.inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal open={open} onClose={onClose} title={`Invite people to ${workspace.name}`}>
      {workspace.inviteCode ? (
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-muted">Share this code. People enter it on their Workspaces page to join.</p>
          <div className="flex gap-2">
            <Input readOnly value={workspace.inviteCode} aria-label="Invite code" className="font-mono" />
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? <IconCheck /> : null}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-muted">Generating a new code stops the old one from working.</p>
            <Button variant="danger" size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()}>
              New code
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">Ask a workspace owner or admin for the invite code.</p>
      )}
    </Modal>
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Highlights each match of `query` in `text`. */
function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let i = lower.indexOf(needle); i !== -1 && needle; i = lower.indexOf(needle, from)) {
    parts.push(
      text.slice(from, i),
      <mark key={i} className="rounded bg-mention px-0.5 text-fg">
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    from = i + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function SearchModal({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: ['search', workspaceId, query],
    queryFn: () => api<{ items: SearchResult[] }>(`/workspaces/${workspaceId}/search`, { query: { q: query } }),
    enabled: open && query.length >= 2,
  });

  return (
    <Modal open={open} onClose={onClose} title="Search messages" wide>
      <div className="relative">
        <IconSearch className="absolute top-3 left-3 size-4 text-subtle" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search in channels you can see…"
          className="pl-9"
          aria-label="Search"
        />
      </div>
      <div className="mt-4 min-h-24">
        {query.length < 2 ? (
          <p className="py-6 text-center text-sm text-muted">Type at least 2 characters.</p>
        ) : results.isPending ? (
          <div className="flex justify-center py-6 text-muted">
            <Spinner />
          </div>
        ) : results.data?.items.length ? (
          <ul className="divide-y divide-border">
            {results.data.items.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/w/${workspaceId}/c/${m.channel.id}`}
                  onClick={onClose}
                  className="flex gap-3 rounded-lg px-2 py-3 hover:bg-surface-2"
                >
                  <Avatar user={m.author} size="sm" />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      <span className="font-semibold text-fg">{m.author.name}</span>
                      <span className="inline-flex items-center">
                        <IconHash className="size-3" />
                        {m.channel.name}
                      </span>
                      <span>{formatFull(m.createdAt)}</span>
                    </p>
                    <p className="mt-0.5 text-sm break-words">
                      <Highlight text={m.content} query={query} />
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-muted">No messages match “{query}”.</p>
        )}
      </div>
    </Modal>
  );
}

export function AddPeopleModal({
  workspaceId,
  channel,
  open,
  onClose,
}: {
  workspaceId: string;
  channel: { id: string; name: string };
  open: boolean;
  onClose: () => void;
}) {
  const members = useMembers(workspaceId);
  const inChannel = useChannelMembers(channel.id);
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: (userId: string) => api(`/channels/${channel.id}/members`, { method: 'POST', body: { userId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.channelMembers(channel.id) });
      void qc.invalidateQueries({ queryKey: keys.channels(workspaceId) });
    },
  });
  const present = new Set(inChannel.data?.map((u) => u.id));
  const candidates = members.data?.filter((m) => !present.has(m.user.id)) ?? [];

  return (
    <Modal open={open} onClose={onClose} title={`Add people to #${channel.name}`}>
      {candidates.length === 0 ? (
        <p className="py-4 text-sm text-muted">Everyone in the workspace is already here.</p>
      ) : (
        <ul className="divide-y divide-border">
          {candidates.map(({ user }) => (
            <li key={user.id} className="flex items-center gap-3 py-2.5">
              <Avatar user={user} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{user.name}</span>
                <span className="block truncate text-xs text-muted">{user.email}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                loading={add.isPending && add.variables === user.id}
                onClick={() => add.mutate(user.id)}
              >
                Add
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
