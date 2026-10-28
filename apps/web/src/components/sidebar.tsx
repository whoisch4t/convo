'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import type { Channel, User, Workspace } from '@convo/shared';
import { cn } from '@/lib/cn';
import { useChannels, useMembers } from '@/lib/queries';
import { signOut } from '@/lib/session';
import { Avatar } from './avatar';
import { IconChevronDown, IconHash, IconLock, IconLogout, IconPlus, IconSearch, IconUsers } from './icons';
import { CreateChannelModal, InviteModal, SearchModal } from './modals';
import { useRealtime } from './realtime-provider';

const STATUS_LABEL = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
} as const;

function ChannelLink({ channel, active }: { channel: Channel; active: boolean }) {
  const unread = channel.isMember && channel.unreadCount > 0 && !active;
  const Icon = channel.isPrivate ? IconLock : IconHash;
  return (
    <Link
      href={`/w/${channel.workspaceId}/c/${channel.id}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-primary-soft font-medium text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
        unread && 'font-semibold text-fg',
      )}
    >
      <Icon className="size-4 shrink-0 opacity-70" />
      <span className="truncate">{channel.name}</span>
      {unread && (
        <span
          className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[11px] leading-none font-semibold text-primary-fg"
          aria-label={`${channel.unreadCount} unread`}
        >
          {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
        </span>
      )}
    </Link>
  );
}

function SectionTitle({ children, action }: { children: string; action?: React.ReactNode }) {
  return (
    <div className="mt-5 mb-1 flex items-center justify-between px-2">
      <h2 className="text-xs font-semibold tracking-wide text-subtle uppercase">{children}</h2>
      {action}
    </div>
  );
}

export function Sidebar({ workspace, me }: { workspace: Workspace; me: User }) {
  const { channelId } = useParams<{ channelId?: string }>();
  const { status, online } = useRealtime();
  const channels = useChannels(workspace.id);
  const members = useMembers(workspace.id);
  const [modal, setModal] = useState<'channel' | 'invite' | 'search' | null>(null);

  const joined = channels.data?.filter((c) => c.isMember) ?? [];
  const others = channels.data?.filter((c) => !c.isMember) ?? [];
  const people = [...(members.data ?? [])].sort(
    (a, b) => Number(online.has(b.user.id)) - Number(online.has(a.user.id)) || a.user.name.localeCompare(b.user.name),
  );

  return (
    <aside className="flex h-full flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-4 py-3">
        <Link
          href="/workspaces"
          className="flex items-center gap-1 rounded-md font-semibold hover:text-primary"
          title="Switch workspace"
        >
          <span className="truncate">{workspace.name}</span>
          <IconChevronDown className="size-4 shrink-0 text-muted" />
        </Link>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted" role="status" aria-live="polite">
          <span
            className={cn(
              'size-2 rounded-full',
              status === 'open' ? 'bg-online' : status === 'offline' ? 'bg-danger' : 'animate-pulse bg-warning',
            )}
          />
          {STATUS_LABEL[status]}
        </p>
      </div>

      <div className="px-2 pt-3">
        <button
          onClick={() => setModal('search')}
          className="flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-subtle hover:bg-surface-2"
        >
          <IconSearch /> Search messages
        </button>
      </div>

      <nav className="scroll-thin flex-1 overflow-y-auto px-2 pb-4" aria-label="Channels">
        <SectionTitle
          action={
            <button
              onClick={() => setModal('channel')}
              className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Create channel"
            >
              <IconPlus />
            </button>
          }
        >
          Channels
        </SectionTitle>
        {joined.map((c) => (
          <ChannelLink key={c.id} channel={c} active={c.id === channelId} />
        ))}

        {others.length > 0 && (
          <>
            <SectionTitle>More channels</SectionTitle>
            {others.map((c) => (
              <ChannelLink key={c.id} channel={c} active={c.id === channelId} />
            ))}
          </>
        )}

        <SectionTitle
          action={
            <button
              onClick={() => setModal('invite')}
              className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
              aria-label="Invite people"
            >
              <IconUsers />
            </button>
          }
        >
          {`People · ${online.size} online`}
        </SectionTitle>
        <ul>
          {people.map(({ user, role }) => (
            <li key={user.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
              <Avatar user={user} size="sm" online={online.has(user.id)} />
              <span className={cn('truncate', !online.has(user.id) && 'text-muted')}>
                {user.name}
                {user.id === me.id && <span className="text-subtle"> (you)</span>}
              </span>
              {role !== 'MEMBER' && <span className="ml-auto text-[10px] text-subtle uppercase">{role}</span>}
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        <Avatar user={me} size="sm" online={status === 'open'} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{me.name}</span>
        <button
          onClick={() => void signOut()}
          className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
          aria-label="Sign out"
          title="Sign out"
        >
          <IconLogout />
        </button>
      </div>

      <CreateChannelModal workspaceId={workspace.id} open={modal === 'channel'} onClose={() => setModal(null)} />
      <InviteModal workspace={workspace} open={modal === 'invite'} onClose={() => setModal(null)} />
      <SearchModal workspaceId={workspace.id} open={modal === 'search'} onClose={() => setModal(null)} />
    </aside>
  );
}
