import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { AuroraStore } from '../store/index.js';
import type { Provider, ProviderModel } from '../store/types.js';
import { codexConfigPath } from '../codex.js';
import { applyContextDefaults, defaultAutoCompactTokenLimit, isValidContextWindow } from '../modelContext.js';
import { atomicWrite, readText } from './configFiles.js';

export const CODEX_MODEL_CATALOG_FILE = 'codex-model-catalog.json';
const OWNER = 'yunqiao-api-gateway-v1';
export interface GatewayModelCatalog {
  models: Record<string, any>[];
  yunqiao: { kind: typeof OWNER; providerId: string };
}

export function isCodexTextModel(model: ProviderModel): boolean {
  return !!model.id && model.id.length <= 400 && !/[\s\u0000-\u001f]/.test(model.id)
    && !/(?:^|[-_./:])(?:image|audio|realtime|tts|transcribe|transcription|embedding|embeddings|whisper|speech|moderation|rerank|reranker|classifier|safety)(?:[-_./:]|$)/i.test(model.id)
    && !/(?:^|\/)(?:dall-e|sora|stable-diffusion|flux)(?:[-_.:/]|$)/i.test(model.id);
}

export function gatewayProviderAvailable(provider: Provider): boolean {
  if (!provider.enabled || provider.official) return false;
  try {
    const url = new URL(provider.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return provider.apiKeys.some(key => key.enabled && !!key.key)
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export function normalizeReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return REASONING_EFFORT_ORDER.filter(effort => value.includes(effort));
}

export function reasoningLevels(model: ProviderModel): string[] {
  if (model.capabilities?.thinking === false || model.thinkingField === 'none') return [];
  const explicit = normalizeReasoningEfforts(model.supportedReasoningEfforts);
  if (explicit !== undefined) return explicit;
  const id = model.id.toLowerCase().replace(/^openai\//, '');
  if (/^gpt-5(?:\.[2-9]\d*|\.[1-9]\d{1,})(?:[-.]|$)/.test(id) || /^gpt-5\.1-codex-max(?:[-.]|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^gpt-5(?:[-.]|$)/.test(id)) return ['minimal', 'low', 'medium', 'high'];
  if (/^o[134](?:[-.]|$)/.test(id) || model.capabilities?.thinking || model.thinkingField === 'reasoning_effort') return ['low', 'medium', 'high'];
  return [];
}

/** 仅依据供应商元数据生成，不读取官方身份、模型缓存或会话。 */
export function buildGatewayModelCatalog(provider: Provider): GatewayModelCatalog {
  const seen = new Set<string>();
  const models = gatewayProviderAvailable(provider) ? provider.models.filter(isCodexTextModel).flatMap(model => {
    const slug = `${provider.id}/${model.id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    const context = applyContextDefaults(model).contextWindow;
    const window = isValidContextWindow(context) ? context : 32768;
    const levels = reasoningLevels(model);
    return [{ slug, display_name: model.displayName || model.id, description: `${provider.name} / ${model.id}`,
      base_instructions: '', model_messages: null, priority: seen.size, visibility: 'list', supported_in_api: true,
      default_reasoning_level: levels.includes('medium') ? 'medium' : levels[0] ?? null,
      supported_reasoning_levels: levels.map(effort => ({ effort, description: effort })),
      additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
      supports_parallel_tool_calls: false, supports_reasoning_summaries: false, support_verbosity: false,
      experimental_supported_tools: [], supports_search_tool: false, supports_tool_search: false,
      input_modalities: model.capabilities?.vision === true ? ['text', 'image'] : ['text'],
      context_window: window, max_context_window: isValidContextWindow(context) ? context : null,
      effective_context_window_percent: 95, auto_compact_token_limit: defaultAutoCompactTokenLimit(window),
      prefer_websockets: false, shell_type: 'shell_command', truncation_policy: { mode: 'tokens', limit: 10000 } }];
  }) : [];
  return { models, yunqiao: { kind: OWNER, providerId: provider.id } };
}

/** 只刷新已挂载且带所有权标记的 API 网关目录；外部目录和直连配置不动。 */
export function refreshGatewayModelCatalog(store: AuroraStore): void {
  const configFile = codexConfigPath(), configBefore = readText(configFile);
  if (!configBefore) return;
  const root: any = parse(configBefore.replace(/^\uFEFF/, ''));
  const profile = typeof root.profile === 'string' ? root.profiles?.[root.profile] : undefined;
  const file = path.join(store.dir, CODEX_MODEL_CATALOG_FILE);
  if ((profile?.model_provider ?? root.model_provider) !== 'yunqiao'
    || (profile?.model_catalog_json ?? root.model_catalog_json) !== file) return;
  const states = store.listAgents();
  const agent = [states['chatgpt-desktop'], states['codex-desktop'], states['codex-cli']]
    .find(value => value?.connected && value.mode === 'gateway' && value.authMode !== 'coexist');
  if (!agent?.providerId) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * 1024 * 1024) throw new Error('模型目录无法安全读取');
  const before = readText(file), previous = JSON.parse(before);
  if (previous?.yunqiao?.kind !== OWNER || previous.yunqiao.providerId !== agent.providerId) return;
  const providers = store.listProviders(), providerRevision = store.providers.revision(providers);
  const provider = providers.find(value => value.id === agent.providerId);
  const catalog: GatewayModelCatalog = provider ? buildGatewayModelCatalog(provider)
    : { models: [], yunqiao: { kind: OWNER, providerId: agent.providerId } };
  const after = JSON.stringify(catalog, null, 2);
  if (after === before) return;
  if (readText(configFile) !== configBefore || store.providers.revision(providers) !== providerRevision) throw new Error('配置或供应商目录已变化，请重新刷新');
  atomicWrite(file, after, { existed: true, content: before });
}
