import { MENTION_PATTERN, mentionToken } from '@convo/shared';

export interface MentionRef {
  id: string;
  name: string;
}

/** Stored text (<@id>) to what the user edits (@Name), plus the mentions it contained. */
export function toEditable(content: string, names: Map<string, string>) {
  const mentions: MentionRef[] = [];
  const text = content.replace(MENTION_PATTERN, (_match, id: string) => {
    const name = names.get(id) ?? 'unknown';
    mentions.push({ id, name });
    return `@${name}`;
  });
  return { text, mentions };
}

/**
 * Turns @Name back into <@id> for every mention picked from the list. Longer names go first so
 * "@Ayşe Yılmaz" is not cut short by a member called "Ayşe".
 */
export function toWire(text: string, mentions: MentionRef[]) {
  const unique = [...new Map(mentions.map((m) => [m.id, m])).values()];
  unique.sort((a, b) => b.name.length - a.name.length);
  return unique.reduce((out, m) => out.split(`@${m.name}`).join(mentionToken(m.id)), text);
}
