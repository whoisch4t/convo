/** Mentions are stored in message text as <@userId> and shown as @Name by the client. */
export const MENTION_PATTERN = /<@([A-Za-z0-9_-]{1,64})>/g;

export const mentionToken = (userId: string) => `<@${userId}>`;

export function mentionedUserIds(content: string): string[] {
  return [...new Set(Array.from(content.matchAll(MENTION_PATTERN), (m) => m[1]!))];
}
