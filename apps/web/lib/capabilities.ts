import table from './capabilities.json';

/**
 * The web's reading of the one table of who does what. capabilities.json here is an exact copy of
 * apps/api/src/config/capabilities.json (the API's capabilities.test.ts fails if they differ), so a page is
 * shown to exactly the roles the API admits to its routes (spec docs/superpowers/specs/2026-10-08-roles-permissions-design.md).
 */
export type Capability = keyof typeof table.capabilities;

/** Whether a role holds a capability: a platform admin where the row says so. The API's holdsCapability, for the screen. */
export function roleHolds(role: string | undefined | null, cap: Capability): boolean {
  if (!role) return false;
  const row = table.capabilities[cap] as { roles: string[]; platform_admin: boolean };
  return role === 'super_admin' ? row.platform_admin : row.roles.includes(role);
}

export const CAPABILITIES = Object.keys(table.capabilities) as Capability[];
