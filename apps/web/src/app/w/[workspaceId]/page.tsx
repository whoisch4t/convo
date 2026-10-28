'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useChannels } from '@/lib/queries';
import { LoadingBlock } from '@/components/ui';

/** Opens #general (or the first joined channel). */
export default function WorkspaceHome({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  const router = useRouter();
  const channels = useChannels(workspaceId);

  useEffect(() => {
    if (!channels.data) return;
    const target =
      channels.data.find((c) => c.name === 'general' && c.isMember) ??
      channels.data.find((c) => c.isMember) ??
      channels.data[0];
    if (target) router.replace(`/w/${workspaceId}/c/${target.id}`);
  }, [channels.data, router, workspaceId]);

  return <LoadingBlock label="Opening channel…" />;
}
