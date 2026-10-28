import { cn } from '@/lib/cn';

// Hues picked to stay readable with white initials in both themes.
const HUES = [12, 38, 152, 190, 215, 255, 285, 330];

function hueFor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toLocaleUpperCase();
}

export function Avatar({
  user,
  size = 'md',
  online,
  className,
}: {
  user: { id: string; name: string };
  size?: 'xs' | 'sm' | 'md';
  /** undefined hides the presence dot. */
  online?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      <span
        className={cn(
          'grid place-items-center rounded-lg font-semibold text-white select-none',
          size === 'xs' && 'size-5 rounded-md text-[9px]',
          size === 'sm' && 'size-6 text-[10px]',
          size === 'md' && 'size-9 text-xs',
        )}
        style={{ background: `oklch(0.58 0.13 ${hueFor(user.id)})` }}
        aria-hidden
      >
        {initials(user.name)}
      </span>
      {online !== undefined && (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 rounded-full border-2 border-surface',
            size === 'md' ? 'size-3' : 'size-2.5',
            online ? 'bg-online' : 'bg-subtle',
          )}
          aria-label={online ? 'Online' : 'Offline'}
          role="img"
        />
      )}
    </span>
  );
}
