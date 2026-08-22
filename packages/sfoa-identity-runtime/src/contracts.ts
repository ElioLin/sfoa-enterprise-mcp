import { z } from 'zod';

export const CONNECTION_ROLES = ['USER', 'DIAGNOSTIC'] as const;
export type ConnectionRole = (typeof CONNECTION_ROLES)[number];

const identityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'must not contain control characters');

const routeSchema = z
  .object({
    platformUserId: z.string().trim().min(1).max(128),
    salesforceUsername: identityNameSchema,
    credentialProfile: z.string().trim().min(1).max(128),
    connectionRole: z.enum(CONNECTION_ROLES),
    aliases: z.array(identityNameSchema).max(16).default([]),
  })
  .strict();

export type SalesforceIdentityRoute = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  credentialProfile: string;
  connectionRole: ConnectionRole;
  aliases: readonly string[];
}>;

export function createSalesforceIdentityRoute(input: unknown): SalesforceIdentityRoute {
  const parsed = routeSchema.parse(input);
  return Object.freeze({
    ...parsed,
    aliases: Object.freeze([...parsed.aliases]),
  });
}

export function normalizeSalesforceIdentity(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function routeAllowsUsernameOrAlias(route: SalesforceIdentityRoute, value: string): boolean {
  const normalized = normalizeSalesforceIdentity(value);
  return [route.salesforceUsername, ...route.aliases].some(
    (allowed) => normalizeSalesforceIdentity(allowed) === normalized,
  );
}
