'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  joinWorkspaceSchema,
  workspaceCreateSchema,
  type JoinWorkspaceInput,
  type Workspace,
  type WorkspaceCreateInput,
} from '@convo/shared';
import { api, ApiError } from '@/lib/api';
import { keys, useMe, useWorkspaces } from '@/lib/queries';
import { Button, Card, ErrorBlock, Field, Input, LoadingBlock } from '@/components/ui';
import { IconLogo, IconLogout } from '@/components/icons';
import { signOut } from '@/lib/session';

function CreateWorkspaceForm({ onDone }: { onDone: (w: Workspace) => void }) {
  const form = useForm<WorkspaceCreateInput>({ resolver: zodResolver(workspaceCreateSchema) });
  const create = useMutation({
    mutationFn: (values: WorkspaceCreateInput) =>
      api<{ workspace: Workspace }>('/workspaces', { method: 'POST', body: values }),
    onSuccess: ({ workspace }) => onDone(workspace),
    onError: (err) => form.setError('name', { message: err instanceof ApiError ? err.message : 'Could not create' }),
  });
  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="flex flex-col gap-3" noValidate>
      <Field label="Workspace name" error={form.formState.errors.name?.message}>
        {(p) => <Input {...p} placeholder="e.g. Acme Inc." {...form.register('name')} />}
      </Field>
      <Button type="submit" loading={create.isPending}>
        Create workspace
      </Button>
    </form>
  );
}

function JoinWorkspaceForm({ onDone }: { onDone: (w: Workspace) => void }) {
  const form = useForm<JoinWorkspaceInput>({ resolver: zodResolver(joinWorkspaceSchema) });
  const join = useMutation({
    mutationFn: (values: JoinWorkspaceInput) =>
      api<{ workspace: Workspace }>('/workspaces/join', { method: 'POST', body: values }),
    onSuccess: ({ workspace }) => onDone(workspace),
    onError: (err) =>
      form.setError('inviteCode', {
        message: err instanceof ApiError ? (err.fieldErrors.inviteCode ?? err.message) : 'Could not join',
      }),
  });
  return (
    <form onSubmit={form.handleSubmit((v) => join.mutate(v))} className="flex flex-col gap-3" noValidate>
      <Field label="Invite code" error={form.formState.errors.inviteCode?.message} hint="Ask a workspace admin for it">
        {(p) => <Input {...p} placeholder="e.g. 3fK9xQ2mPa1L" autoComplete="off" {...form.register('inviteCode')} />}
      </Field>
      <Button type="submit" variant="secondary" loading={join.isPending}>
        Join workspace
      </Button>
    </form>
  );
}

export default function WorkspacesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const workspaces = useWorkspaces();
  const [mode, setMode] = useState<'create' | 'join'>('create');

  const open = (w: Workspace) => {
    void qc.invalidateQueries({ queryKey: keys.workspaces });
    router.push(`/w/${w.id}`);
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <IconLogo />
          <span className="text-lg font-semibold">Convo</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>
          <IconLogout /> Sign out
        </Button>
      </header>

      <h1 className="text-2xl font-semibold tracking-tight">
        {me.data ? `Welcome, ${me.data.name.split(' ')[0]}` : 'Your workspaces'}
      </h1>
      <p className="mt-1 text-sm text-muted">Pick a workspace, start a new one or join with an invite code.</p>

      <Card className="mt-6">
        {workspaces.isPending ? (
          <LoadingBlock label="Loading workspaces…" />
        ) : workspaces.isError ? (
          <ErrorBlock
            message="Could not load workspaces."
            onRetry={() => void workspaces.refetch()}
            retryLabel="Retry"
          />
        ) : workspaces.data.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">You are not in any workspace yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {workspaces.data.map((w) => (
              <li key={w.id}>
                <Link href={`/w/${w.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2">
                  <span className="grid size-9 place-items-center rounded-lg bg-primary-soft font-semibold text-primary">
                    {w.name[0]?.toLocaleUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{w.name}</span>
                    <span className="block text-xs text-muted capitalize">{w.role.toLowerCase()}</span>
                  </span>
                  <span className="text-sm text-primary">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6 p-5">
        <div className="mb-4 flex gap-1 rounded-lg bg-surface-2 p-1" role="tablist">
          {(['create', 'join'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium ${mode === m ? 'bg-surface shadow-sm' : 'text-muted'}`}
            >
              {m === 'create' ? 'Create new' : 'Join with code'}
            </button>
          ))}
        </div>
        {mode === 'create' ? <CreateWorkspaceForm onDone={open} /> : <JoinWorkspaceForm onDone={open} />}
      </Card>
    </div>
  );
}
