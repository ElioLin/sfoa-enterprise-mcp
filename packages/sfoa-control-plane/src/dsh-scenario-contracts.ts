import { z } from 'zod';
import type { DshScenarioAttachmentMeta, DshStandardScenarioRecord } from './contracts.js';

/**
 * DSH Standard Scenarios wire contract (DSH-01).
 *
 * These schemas are the only way a value enters the service from HTTP. They are strict about the
 * identifiers the server indexes on (`scenarioId`, `attachmentId`), generous about the plugin's
 * own payload, and explicit about which fields a client may NOT set: `version` and `revision` are
 * rejected as unknown keys rather than silently ignored, so a client that tries to control them
 * finds out at development time instead of wondering why its value never appears.
 */

/**
 * The plugin's own id. Bounded and URL-safe so it can live in a path segment unchanged.
 * `permission` is reserved for `GET /api/dsh/scenarios/permission`; allowing it as an id would
 * make that scenario unreachable.
 */
export const dshScenarioIdSchema = z.string().trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
  .refine((value) => value !== 'permission', 'scenarioId "permission" is reserved');
export const dshAttachmentIdSchema = z.string().trim().regex(/^att_[a-f0-9]{32}$/u);

export const dshScenarioTitleSchema = z.string().trim().min(1).max(128);
export const dshScenarioCategorySchema = z.string().trim().min(1).max(64);
export const dshScenarioDescriptionSchema = z.string().trim().min(1).max(4_000);

/**
 * The business system a scenario belongs to (DSH-01.1).
 *
 * The DSH plugin has required this on every scenario card since 1.7.0 — it decides which workspace
 * the user lands in, so it is used as a directory name. The plugin has shipped it inside
 * `scenarioPayload.businessSystem` since 1.8.0 (its payload is a passthrough document), which is
 * why the server stored it but could not query it. This schema is the first-class form of that
 * value: 1-32 characters after trimming, and never a character a path segment cannot carry, so a
 * value that passes here is safe to use as a workspace directory on the client.
 */
export const DSH_BUSINESS_SYSTEM_MAX_LENGTH = 32;
export const DSH_BUSINESS_SYSTEM_FORBIDDEN_CHARACTERS = '\\/:*?"<>|';
const DSH_BUSINESS_SYSTEM_FORBIDDEN_PATTERN = /[\\/:*?"<>|]/u;
export const dshBusinessSystemSchema = z.string().trim()
  .min(1)
  .max(DSH_BUSINESS_SYSTEM_MAX_LENGTH)
  .refine(
    (value) => !DSH_BUSINESS_SYSTEM_FORBIDDEN_PATTERN.test(value),
    `businessSystem must not contain any of ${DSH_BUSINESS_SYSTEM_FORBIDDEN_CHARACTERS}`,
  );

/** The workspace a scenario belongs to when neither the request nor its payload names one. */
export const DSH_SCENARIO_DEFAULT_BUSINESS_SYSTEM = 'CRM';

/**
 * Reads a usable business system out of an untrusted source, or `undefined`.
 *
 * Deliberately non-throwing: callers use it to *resolve* between the top-level field and the
 * plugin-owned payload, and an unusable payload hint must degrade to the next source rather than
 * fail a write that a 1.7.0/1.8.0 plugin sent long before this field existed.
 */
export function readDshBusinessSystem(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = dshBusinessSystemSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** `payload.businessSystem`, when the stored document carries a usable one. */
export function readDshPayloadBusinessSystem(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  return readDshBusinessSystem((payload as Record<string, unknown>).businessSystem);
}

export const DSH_SCENARIO_EDITABLE_STATUSES = ['PUBLISHED', 'ARCHIVED'] as const;
export const dshScenarioEditableStatusSchema = z.enum(DSH_SCENARIO_EDITABLE_STATUSES);

/**
 * The plugin-owned configuration document. The server only constrains what it must:
 * `pinnedSkills` is a bounded string list, the three named strings are bounded, and
 * `prePinnedContext` is an object. Everything else a newer plugin adds is preserved verbatim
 * (`passthrough`), because the server is a store, not a schema owner for the client UI.
 *
 * `passthrough` is load-bearing for `businessSystem`: the 1.8.0 plugin writes it here, and the
 * server keeps accepting payloads without it (1.7.0) and with keys it has never heard of.
 */
const dshPinnedSkillsSchema = z.array(z.string().trim().min(1).max(128)).max(50);
export const dshScenarioPayloadSchema = z.object({
  pinnedSkills: dshPinnedSkillsSchema.optional(),
  welcomeMessage: z.string().max(4_000).optional(),
  inputDraft: z.string().max(8_000).optional(),
  prePinnedContext: z.record(z.unknown()).optional(),
  /** Re-asserted by the server; accepted so a round-tripped payload stays valid. */
  sourceType: z.string().max(64).optional(),
  readonlyForNormalUser: z.boolean().optional(),
}).passthrough().refine(
  // Character-count pre-check only: it keeps an oversized body from reaching the service, which
  // then applies the byte-exact limit. No Node-only API is used here so this module stays safe to
  // import from the browser bundle.
  (value) => JSON.stringify(value).length <= 262_144,
  'scenarioPayload is too large',
);

export const dshScenarioCreateSchema = z.object({
  scenarioId: dshScenarioIdSchema,
  title: dshScenarioTitleSchema,
  category: dshScenarioCategorySchema.optional(),
  description: dshScenarioDescriptionSchema,
  /**
   * Optional on purpose. A 1.7.0 plugin has no such field and a 1.8.0 plugin only carries it inside
   * the payload; the server reads both and never requires the client to send this one.
   */
  businessSystem: dshBusinessSystemSchema.optional(),
  scenarioPayload: dshScenarioPayloadSchema,
  status: dshScenarioEditableStatusSchema.optional(),
}).strict();

/**
 * `PUT` is a patch of the mutable fields. `version` / `revision` are absent on purpose: a body
 * that carries them fails validation, which is how the "the server owns the version" rule is
 * communicated to a client that guessed otherwise.
 */
export const dshScenarioUpdateSchema = z.object({
  title: dshScenarioTitleSchema.optional(),
  category: dshScenarioCategorySchema.optional(),
  description: dshScenarioDescriptionSchema.optional(),
  businessSystem: dshBusinessSystemSchema.optional(),
  scenarioPayload: dshScenarioPayloadSchema.optional(),
  status: dshScenarioEditableStatusSchema.optional(),
}).strict().refine(
  (value) => Object.values(value).some((entry) => entry !== undefined),
  'At least one of title, category, description, businessSystem, scenarioPayload or status is required.',
);

export const dshScenarioListQuerySchema = z.object({
  /** Default true: the plugin needs the tombstones to uninstall scenarios it already copied. */
  includeDeleted: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  /** Admin-only view of archived scenarios; ignored for a caller without management rights. */
  includeArchived: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  /**
   * Exact match on the scenario's business system, case-insensitively. An empty value is the same
   * as an absent one so a cleared Console filter can still be expressed in the URL.
   */
  businessSystem: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    dshBusinessSystemSchema.optional(),
  ),
}).strict();

/**
 * Base64 upload, the transport that works from every plugin runtime (an Electron renderer, a
 * Node worker, a browser) without a multipart encoder. `sha256` is optional: when supplied it
 * must match, which lets a client prove the bytes it meant to send are the bytes that arrived.
 */
export const dshAttachmentUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255)
    .refine((value) => !/[\\/]/u.test(value), 'fileName must not contain a path separator')
    .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'fileName must not contain control characters'),
  mimeType: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u),
  contentBase64: z.string().min(1),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/u).optional(),
}).strict();

export type DshScenarioCreateBody = z.infer<typeof dshScenarioCreateSchema>;
export type DshScenarioUpdateBody = z.infer<typeof dshScenarioUpdateSchema>;
export type DshAttachmentUploadBody = z.infer<typeof dshAttachmentUploadSchema>;

/** The authorization envelope every DSH response carries, so the plugin can decide its UI from one read. */
export type DshScenarioAuthDto = Readonly<{
  authenticated: boolean;
  platformUserId: string | null;
  crmUsername: string | null;
  canManageStandardScenario: boolean;
}>;

export type DshScenarioListResponse = Readonly<{
  auth: DshScenarioAuthDto;
  scenarios: readonly DshStandardScenarioRecord[];
  deletedScenarioIds: readonly string[];
}>;

export type DshScenarioResponse = Readonly<{
  auth: DshScenarioAuthDto;
  scenario: DshStandardScenarioRecord;
}>;

export type DshAttachmentMutationResponse = Readonly<{
  auth: DshScenarioAuthDto;
  scenario: DshStandardScenarioRecord;
  attachment: DshScenarioAttachmentMeta;
}>;

export type DshDeletedScenarioResponse = Readonly<{
  auth: DshScenarioAuthDto;
  deleted: true;
  scenarioId: string;
  revision: number;
  deletedScenarioIds: readonly string[];
}>;
