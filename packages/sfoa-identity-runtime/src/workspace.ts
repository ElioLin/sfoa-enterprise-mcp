import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { IdentityRuntimeError } from './errors.js';

const apiVersionSchema = z.string().regex(/^\d{2}\.0$/u, 'must be a Salesforce API version such as 65.0');
const metadataSeedSchema = z
  .object({
    type: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
    fullName: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value)),
  })
  .strict();

export type MetadataSeed = Readonly<z.infer<typeof metadataSeedSchema>>;

export type WorkspaceMetrics = Readonly<{
  created: number;
  cleaned: number;
  active: number;
  createdRoots: readonly string[];
}>;

export interface RequestWorkspace {
  readonly root: string;
  readonly manifestPath: string | undefined;
  resolveClientPath(candidate: string): string;
  countFiles(): Promise<number>;
  cleanup(): Promise<void>;
}

export type RequestWorkspaceFactoryOptions = Readonly<{
  baseRoot?: string;
  metadataSeed?: MetadataSeed;
}>;

export class RequestWorkspaceFactory {
  private readonly baseRoot: string;
  private readonly cleanupCwd: string;
  private readonly metadataSeed: MetadataSeed | undefined;
  private readonly activeRoots = new Set<string>();
  private readonly createdRoots: string[] = [];
  private cleaned = 0;

  public constructor(options: RequestWorkspaceFactoryOptions = {}) {
    this.baseRoot = path.resolve(options.baseRoot ?? path.join(tmpdir(), 'sfoa-mcp'));
    this.cleanupCwd = process.cwd();
    this.metadataSeed = options.metadataSeed ? Object.freeze(metadataSeedSchema.parse(options.metadataSeed)) : undefined;
  }

  public async create(correlationId: string, apiVersion: string): Promise<RequestWorkspace> {
    const parsedApiVersion = apiVersionSchema.parse(apiVersion);
    await mkdir(this.baseRoot, { recursive: true });
    let root: string | undefined;

    try {
      root = path.resolve(await mkdtemp(path.join(this.baseRoot, `${correlationId}-`)));
      this.assertWithinBase(root);
      this.activeRoots.add(root);
      this.createdRoots.push(root);

      const sourceRoot = path.join(root, 'force-app', 'main', 'default');
      const manifestDirectory = path.join(root, 'manifest');
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(manifestDirectory, { recursive: true });
      await writeFile(
        path.join(root, 'sfdx-project.json'),
        `${JSON.stringify(
          {
            packageDirectories: [{ path: 'force-app', default: true }],
            namespace: '',
            sourceApiVersion: parsedApiVersion,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );

      const manifestPath = this.metadataSeed ? path.join(manifestDirectory, 'package.xml') : undefined;
      if (manifestPath && this.metadataSeed) {
        await writeFile(manifestPath, createManifest(parsedApiVersion, this.metadataSeed), 'utf8');
      }

      let cleaned = false;
      const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        cleaned = true;
        await this.cleanupRoot(root as string);
      };

      return Object.freeze({
        root,
        manifestPath,
        resolveClientPath: (candidate: string) => this.resolveWithinWorkspace(root as string, candidate),
        countFiles: async () => countFiles(root as string),
        cleanup,
      });
    } catch (error) {
      if (root && this.activeRoots.has(root)) {
        await this.cleanupRoot(root).catch(() => undefined);
      }
      if (error instanceof IdentityRuntimeError) throw error;
      throw new IdentityRuntimeError(
        'MCP_REQUEST_WORKSPACE_FAILED',
        'The server could not create the isolated request workspace. Verify temporary-directory access.',
        { cause: error, correlationId },
      );
    }
  }

  public getMetrics(): WorkspaceMetrics {
    return Object.freeze({
      created: this.createdRoots.length,
      cleaned: this.cleaned,
      active: this.activeRoots.size,
      createdRoots: Object.freeze([...this.createdRoots]),
    });
  }

  private resolveWithinWorkspace(root: string, candidate: string): string {
    const resolved = path.resolve(root, candidate);
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved;
    throw new IdentityRuntimeError(
      'MCP_REQUEST_WORKSPACE_FAILED',
      'A Tool path resolved outside the request workspace and was rejected.',
    );
  }

  private assertWithinBase(root: string): void {
    const relative = path.relative(this.baseRoot, root);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new IdentityRuntimeError(
        'MCP_REQUEST_WORKSPACE_FAILED',
        'Refusing to use a request workspace outside the configured temporary boundary.',
      );
    }
  }

  private async cleanupRoot(root: string): Promise<void> {
    this.assertWithinBase(root);
    if (!this.activeRoots.has(root)) {
      throw new IdentityRuntimeError(
        'MCP_REQUEST_WORKSPACE_FAILED',
        'Refusing to clean a workspace that was not created by this request workspace factory.',
      );
    }
    const relativeCwd = path.relative(root, process.cwd());
    if (relativeCwd === '' || (!relativeCwd.startsWith('..') && !path.isAbsolute(relativeCwd))) {
      process.chdir(this.cleanupCwd);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    this.activeRoots.delete(root);
    this.cleaned += 1;
  }
}

async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    count += entry.isDirectory() ? await countFiles(entryPath) : 1;
  }
  return count;
}

function createManifest(apiVersion: string, seed: MetadataSeed): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <types>',
    `    <members>${escapeXml(seed.fullName)}</members>`,
    `    <name>${escapeXml(seed.type)}</name>`,
    '  </types>',
    `  <version>${escapeXml(apiVersion)}</version>`,
    '</Package>',
    '',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
