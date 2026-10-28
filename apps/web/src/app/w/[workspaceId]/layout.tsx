'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { use, useEffect, useState, type ReactNode } from 'react';
import { RealtimeProvider } from '@/components/realtime-provider';
import { Sidebar } from '@/components/sidebar';
import { ErrorBlock, LoadingBlock } from '@/components/ui';
import { IconMenu } from '@/components/icons';
import { ApiError } from '@/lib/api';
import { useMe, useWorkspace } from '@/lib/queries';
import { cn } from '@/lib/cn';

export default function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>;
  children: ReactNode;
}) {
  const { workspaceId } = use(params);
  const me = useMe();
  const workspace = useWorkspace(workspaceId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile sidebar after navigating.
  useEffect(() => setSidebarOpen(false), [pathname]);

  if (workspace.isError) {
    const notFound = workspace.error instanceof ApiError && workspace.error.status === 404;
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2">
        <ErrorBlock
          message={
            notFound ? 'This workspace does not exist or you are not a member.' : 'Could not load this workspace.'
          }
        />
        <Link href="/workspaces" className="text-sm font-medium text-primary hover:underline">
          Back to your workspaces
        </Link>
      </div>
    );
  }
  if (!me.data || !workspace.data) return <LoadingBlock label="Loading workspace…" />;

  return (
    <RealtimeProvider workspaceId={workspaceId} userId={me.data.id}>
      <div className="flex h-dvh overflow-hidden">
        {/* Sidebar: fixed drawer on small screens, column on large ones. */}
        <div
          className={cn(
            'fixed inset-y-0 left-0 z-40 w-72 -translate-x-full transition-transform lg:static lg:translate-x-0',
            sidebarOpen && 'translate-x-0',
          )}
        >
          <Sidebar workspace={workspace.data} me={me.data} />
        </div>
        {sidebarOpen && (
          <button
            className="fixed inset-0 z-30 bg-black/40 lg:hidden"
            aria-label="Close menu"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Sits over the left of the channel header, which leaves room for it on small screens. */}
          <button
            className="absolute top-2.5 left-2 z-10 grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-2 lg:hidden"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <IconMenu className="size-5" />
          </button>
          {children}
        </main>
      </div>
    </RealtimeProvider>
  );
}
