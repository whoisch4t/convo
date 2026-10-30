const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
export const formatFull = (iso: string) => fullFormat.format(new Date(iso));

export function formatDay(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return dayFormat.format(date);
}

export const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Ayşe", "Ayşe and Mert", "Ayşe, Mert and 2 others" */
export function joinNames(names: string[], max = 2) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
