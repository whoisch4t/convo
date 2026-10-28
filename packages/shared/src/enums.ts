// Keep in sync with apps/api/prisma/schema.prisma.

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles that can manage channels, members and other people's messages. */
export const MANAGER_ROLES: readonly WorkspaceRole[] = ['OWNER', 'ADMIN'];
