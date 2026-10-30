import type { ReactNode } from 'react';
import { MENTION_PATTERN, type Attachment } from '@convo/shared';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { IconFile } from './icons';

/** Message text with <@id> shown as @Name. Mentions of the current user stand out. */
export function MessageText({ content, names, meId }: { content: string; names: Map<string, string>; meId: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const id = match[1]!;
    if (match.index > last) parts.push(content.slice(last, match.index));
    parts.push(
      <span
        key={match.index}
        className={cn(
          'rounded px-0.5 font-medium',
          id === meId ? 'bg-mention text-warning' : 'bg-primary-soft text-primary',
        )}
      >
        @{names.get(id) ?? 'unknown user'}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return <>{parts}</>;
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.isImage);
  const files = attachments.filter((a) => !a.isImage);
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <a key={a.id} href={a.url} target="_blank" rel="noopener" title={a.name}>
              {/* A plain <img>: the file sits behind auth cookies, so next/image cannot fetch it to optimise. */}
              <img
                src={a.url}
                alt={a.name}
                loading="lazy"
                className="max-h-72 max-w-full rounded-lg border border-border bg-surface-2 object-contain sm:max-w-sm"
              />
            </a>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a
          key={a.id}
          href={a.url}
          download={a.name}
          className="flex max-w-sm items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 hover:bg-surface-2"
        >
          <IconFile className="size-6 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{a.name}</span>
            <span className="text-xs text-muted">{formatBytes(a.size)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
