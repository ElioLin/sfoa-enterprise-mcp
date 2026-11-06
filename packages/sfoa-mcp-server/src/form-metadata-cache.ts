import { randomUUID } from 'node:crypto';
import type { PrecisionMetadata, PrecisionMetadataRequest } from '@sfoa/mcp-provider-sfoa-context';

type Entry = { owner: string; scope: string; expiresAt: number; bytes: number; metadata: PrecisionMetadata };

/** Bounded, server-local configuration reuse for one explicit refinement reference.
 * Contains no saved records, USER field values, draft, evaluated rules or credentials.
 * START and SUBMIT never read it; its references cannot authorize any operation.
 */
export class FormMetadataCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  public constructor(private readonly now: () => number = Date.now) {}

  public get(owner: string, request: PrecisionMetadataRequest): PrecisionMetadata | undefined {
    this.expire();
    if (request.phase !== 'REFINE' || !request.structuralContextRef) return undefined;
    const entry = this.entries.get(request.structuralContextRef);
    if (!entry || entry.owner !== owner || entry.scope !== scope(request)) return undefined;
    if (request.appDeveloperName && request.appDeveloperName !== entry.metadata.appDeveloperName
      && !entry.metadata.snapshot.apps.some((app) => app.developerName === request.appDeveloperName
        && app.fullName === entry.metadata.appDeveloperName)) return undefined;
    return { ...structuredClone(entry.metadata), cache: 'TASK_REUSE', apiCallCount: 0,
      evidence: { ...entry.metadata.evidence, cache: 'TASK_REUSE', freshness: 'REUSED_VERIFIED_STRUCTURE' },
      structuralContextRef: request.structuralContextRef };
  }

  public put(owner: string, request: PrecisionMetadataRequest, metadata: PrecisionMetadata): PrecisionMetadata {
    this.expire();
    const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
    if (bytes > 2_097_152) return { ...metadata, cache: 'FRESH' };
    while (this.entries.size >= 32 || this.bytes + bytes > 16_777_216) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
    const ref = randomUUID();
    this.entries.set(ref, { owner, scope: scope(request), expiresAt: this.now() + 600_000,
      bytes, metadata: structuredClone(metadata) });
    this.bytes += bytes;
    return { ...metadata, structuralContextRef: ref, cache: 'FRESH' };
  }

  public clear(): void { this.entries.clear(); this.bytes = 0; }
  private expire(): void {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(id);
  }
  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(id);
  }
}

function scope(request: PrecisionMetadataRequest): string {
  return JSON.stringify([request.organizationId.slice(0, 15), request.profileId.slice(0, 15),
    request.objectApiName, request.recordTypeId.slice(0, 15), request.action]);
}
