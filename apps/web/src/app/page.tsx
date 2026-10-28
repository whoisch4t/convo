import Link from 'next/link';
import { ButtonLink } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { IconEye, IconHash, IconLock, IconLogo, IconUsers, IconZap } from '@/components/icons';

const FEATURES = [
  {
    icon: IconZap,
    title: 'Live over WebSocket',
    body: 'Messages, edits and deletions appear instantly. Redis pub/sub fans them out across server instances.',
  },
  {
    icon: IconUsers,
    title: 'Presence and typing',
    body: 'See who is online and who is typing, accurate across tabs, devices and servers.',
  },
  {
    icon: IconEye,
    title: 'Read receipts and unread',
    body: 'Per-channel unread badges and “seen by” markers, driven by read pointers that only move forward.',
  },
  {
    icon: IconLock,
    title: 'Workspaces and permissions',
    body: 'Invite links, public and private channels, and owner / admin / member roles enforced by the API.',
  },
];

const PREVIEW = [
  { id: 'a', name: 'Ayşe Yılmaz', text: 'The gateway now fans out through Redis pub/sub.' },
  { id: 'b', name: 'Mert Demir', text: 'Tested with two API instances, messages flow between them.' },
  { id: 'c', name: 'Elif Kaya', text: 'Presence survives a crash too, entries expire after 90s.' },
];

export default function LandingPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <IconLogo />
          <span className="text-lg font-semibold tracking-tight">Convo</span>
        </Link>
        <ButtonLink href="/login" variant="ghost" size="sm">
          Sign in
        </ButtonLink>
      </header>

      <main className="grid flex-1 items-center gap-12 py-12 lg:grid-cols-2">
        <section>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Team chat that feels instant.
          </h1>
          <p className="mt-4 max-w-lg text-lg text-muted">
            Workspaces, channels and realtime messaging with presence, typing indicators and read receipts.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/register">Get started</ButtonLink>
            <ButtonLink href="/login" variant="secondary">
              Try the demo
            </ButtonLink>
          </div>

          <ul className="mt-12 grid gap-6 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <div className="mb-3 grid size-9 place-items-center rounded-lg bg-primary-soft text-primary">
                  <Icon className="size-[18px]" />
                </div>
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="mt-1 text-sm text-muted">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-hidden className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
            <IconHash className="size-4 text-muted" />
            <span className="font-semibold">engineering</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
              <span className="size-2 rounded-full bg-online" /> 2 online
            </span>
          </div>
          <ul className="flex flex-col gap-4 px-5 py-5">
            {PREVIEW.map((m, i) => (
              <li key={m.id} className="flex gap-3">
                <Avatar user={m} online={i !== 2} />
                <div>
                  <p className="text-sm font-semibold">
                    {m.name} <span className="ml-1 text-xs font-normal text-subtle">10:4{i}</span>
                  </p>
                  <p className="text-sm">{m.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="px-5 pb-2 text-xs text-muted">Seen by Ayşe and Mert</p>
          <p className="px-5 pb-4 text-xs text-muted italic">Elif is typing…</p>
        </section>
      </main>

      <footer className="py-6 text-xs text-subtle">
        Built with Next.js, Node.js, WebSocket, Redis and PostgreSQL.
      </footer>
    </div>
  );
}
