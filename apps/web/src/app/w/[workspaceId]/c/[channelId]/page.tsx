'use client';

import { use } from 'react';
import { ChannelView } from '@/components/channel-view';

export default function ChannelPage({ params }: { params: Promise<{ workspaceId: string; channelId: string }> }) {
  const { workspaceId, channelId } = use(params);
  // Keyed so each channel starts with fresh local state (drafts, scroll position).
  return <ChannelView key={channelId} workspaceId={workspaceId} channelId={channelId} />;
}
