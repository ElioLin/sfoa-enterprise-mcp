import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_AGENT_ARTIFACT_MARKER,
  renderDifyInstruction,
  renderSafetyReference,
  renderWorkflowReference,
  renderWorkBuddySkill,
  renderWorkBuddySystemPrompt,
} from '../dist/index.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, '../../..');
const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : undefined;
const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 && process.argv[rootIndex + 1]
  ? resolve(process.argv[rootIndex + 1])
  : defaultRoot;

if (!mode) {
  process.stderr.write('Usage: node scripts/sync-generated.mjs --write|--check [--root <directory>]\n');
  process.exitCode = 2;
} else {
  const artifacts = new Map([
    ['.codebuddy/skills/sfoa-salesforce-assistant/SKILL.md', normalize(renderWorkBuddySkill())],
    ['.codebuddy/skills/sfoa-salesforce-assistant/references/tool-workflows.md', generated(renderWorkflowReference())],
    ['.codebuddy/skills/sfoa-salesforce-assistant/references/safety-boundaries.md', generated(renderSafetyReference())],
    ['docs/agent/DIFY_AGENT_INSTRUCTION.md', generated(renderDifyInstruction())],
    ['docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md', generated(renderWorkBuddySystemPrompt())],
  ]);

  if (mode === 'write') {
    for (const [relativePath, content] of artifacts) {
      const target = resolve(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    process.stdout.write(`Synchronized ${artifacts.size} Agent artifacts.\n`);
  } else {
    const drift = [];
    for (const [relativePath, expected] of artifacts) {
      const target = resolve(root, relativePath);
      const actual = await readFile(target, 'utf8').catch(() => undefined);
      if (actual !== expected) drift.push(relativePath);
    }
    if (drift.length > 0) {
      process.stderr.write(`Agent artifact drift detected:\n${drift.map((path) => `- ${path}`).join('\n')}\nRun yarn agent:sync.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Agent artifact check PASS (${artifacts.size} files).\n`);
    }
  }
}

function generated(content) {
  return normalize(`${GENERATED_AGENT_ARTIFACT_MARKER}\n\n${content}`);
}

function normalize(content) {
  return `${content.trimEnd()}\n`;
}
