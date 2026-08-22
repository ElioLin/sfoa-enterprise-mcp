import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEMP_PREFIX = 'sfoa-p0-closure-';

export type MetadataWorkspace = {
  root: string;
  manifestPath: string;
  countRetrievedFiles(): Promise<number>;
  cleanup(): Promise<void>;
};

export async function createMetadataWorkspace(
  apiVersion: string,
  metadataType: string,
  fullName: string,
): Promise<MetadataWorkspace> {
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const sourceRoot = path.join(root, 'force-app', 'main', 'default');
  const manifestDirectory = path.join(root, 'manifest');
  const manifestPath = path.join(manifestDirectory, 'package.xml');

  await mkdir(sourceRoot, { recursive: true });
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    path.join(root, 'sfdx-project.json'),
    `${JSON.stringify(
      {
        packageDirectories: [{ path: 'force-app', default: true }],
        namespace: '',
        sourceApiVersion: apiVersion,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    manifestPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
      '  <types>',
      `    <members>${escapeXml(fullName)}</members>`,
      `    <name>${escapeXml(metadataType)}</name>`,
      '  </types>',
      `  <version>${escapeXml(apiVersion)}</version>`,
      '</Package>',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    root,
    manifestPath,
    countRetrievedFiles: async () => countFiles(sourceRoot),
    cleanup: async () => safeCleanup(root),
  };
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

async function safeCleanup(root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(tmpdir());
  if (path.dirname(resolvedRoot) !== resolvedTemp || !path.basename(resolvedRoot).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing to remove a path outside the P0-Closure temporary workspace boundary.');
  }
  await rm(resolvedRoot, { recursive: true, force: true });
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
