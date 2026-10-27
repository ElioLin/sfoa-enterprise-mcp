/** Read-only configuration projection. Never prints credentials, headers or prompt bodies. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function projectOpenClawConfig(config) {
  const defaults = config.agents?.defaults ?? {};
  const entries = config.agents?.list ?? Object.entries(config.agents?.entries ?? {}).map(([id, value]) => ({ id, ...value }));
  const models = value => typeof value === 'string' ? { primary: value } : {
    primary: value?.primary ?? null, fallbacks: Array.isArray(value?.fallbacks) ? value.fallbacks : [],
  };
  return { evidence: 'CONFIG_FILE_ONLY; process visibility, Skill read and model context require Run evidence',
    defaultModel: models(defaults.model), defaultWorkspace: defaults.workspace ?? null,
    agents: entries.map(agent => ({ id: agent.id, model: models(agent.model ?? defaults.model), workspace: agent.workspace ?? defaults.workspace ?? null,
      skills: agent.skills ?? null, hasInlineSystemPrompt: typeof agent.systemPrompt === 'string' })),
    skillEntries: Object.entries(config.skills?.entries ?? {}).map(([name, value]) => ({ name, enabled: value.enabled !== false })),
    extraSkillDirectories: config.skills?.load?.extraDirs ?? [],
    mcpServerNames: Object.keys(config.mcp?.servers ?? config.mcpServers ?? {}),
    plugins: Object.entries(config.plugins?.entries ?? {}).map(([name, value]) => ({ name, enabled: value.enabled !== false })),
    media: Object.fromEntries(['audio', 'image', 'video'].map(kind => [kind, { enabled: config.tools?.media?.[kind]?.enabled ?? null,
      models: (config.tools?.media?.[kind]?.models ?? []).map(model => ({ provider: model.provider ?? null, model: model.model ?? null, type: model.type ?? null })) }])),
    globalMediaModels: (config.tools?.media?.models ?? []).map(model => ({ provider: model.provider ?? null, model: model.model ?? null, capabilities: model.capabilities ?? null })),
    documentExtraction: { explicitToolConfiguration: Boolean(config.tools?.document || config.tools?.pdf),
      note: 'Built-in/plugin auto-detection may still apply; configuration absence does not prove extraction unavailable.', requiresActualExtractionResult: true } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--config');
  if (at < 0 || !process.argv[at + 1]) {
    console.log(JSON.stringify({ status: 'NOT_RUN', missing: 'actual running OpenClaw configuration path; use --config <path>' }));
    process.exitCode = 1;
  } else {
    const config = JSON.parse(await readFile(process.argv[at + 1], 'utf8'));
    console.log(JSON.stringify(projectOpenClawConfig(config), null, 2));
  }
}
