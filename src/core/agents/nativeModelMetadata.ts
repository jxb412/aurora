import fs from 'node:fs';
import path from 'node:path';
import { codexConfigPath } from '../codex.js';

const MAX_CACHE_BYTES = 12 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 512 * 1024;
const secretField = /^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|tokens|account[_-]?id|email|password|__proto__|constructor|prototype)$/i;
const modelFields = new Set([
  'slug', 'display_name', 'description', 'base_instructions', 'model_messages', 'default_reasoning_level',
  'supported_reasoning_levels', 'shell_type', 'visibility', 'supported_in_api', 'priority', 'support_verbosity',
  'default_verbosity', 'apply_patch_tool_type', 'web_search_tool_type', 'truncation_policy', 'context_window',
  'max_context_window', 'effective_context_window_percent', 'experimental_supported_tools', 'input_modalities',
  'supports_parallel_tool_calls', 'supports_reasoning_summaries', 'supports_reasoning_summary_parameter',
  'default_reasoning_summary', 'supports_search_tool', 'supports_tool_search', 'supports_image_detail_original',
  'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions',
  'model_specialty', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort', 'multi_agent_tools_in_code_mode',
  'node_repl_disabled', 'node_repl_auto_review_required', 'supports_reasoning_effort_updates',
]);
const messageFields = new Set([
  'instructions_template', 'instructions_variables', 'apps', 'plugins', 'content_filter_guidance',
  'persistent_instructions', 'tools', 'approvals', 'collaboration_modes', 'auto_review', 'permissions',
  'multi_agent', 'token_budget', 'guardian_v2', 'confirmation_policies',
]);
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const booleanFields = [
  'supports_parallel_tool_calls', 'supports_reasoning_summaries', 'supports_reasoning_summary_parameter',
  'supports_search_tool', 'supports_tool_search', 'supports_image_detail_original', 'include_skills_usage_instructions',
  'include_plugin_usage_instructions', 'include_apps_usage_instructions', 'multi_agent_tools_in_code_mode',
  'node_repl_disabled', 'node_repl_auto_review_required', 'supports_reasoning_effort_updates',
];
const optionalStringFields = [
  'description', 'base_instructions', 'default_verbosity', 'apply_patch_tool_type', 'web_search_tool_type',
  'default_reasoning_summary', 'model_specialty', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort',
];
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Copy model metadata only. Credentials and account envelopes never enter the generated catalog. */
function metadataValue(value: any, depth = 0): any {
  if (depth > 12) throw new Error('模型元数据嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => metadataValue(item, depth + 1));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !secretField.test(key))
    .map(([key, item]) => [key, metadataValue(item, depth + 1)]));
  throw new Error('模型元数据类型无效');
}

export function nativeModelId(id: string): string {
  return id.replace(/^(?:openai|official)\//, '');
}

/** An incomplete template must use the client's existing fallback, never an invented empty prompt. */
export function validatedNativeModel(value: unknown): Record<string, any> | undefined {
  if (!isObject(value)) return undefined;
  try {
    if (typeof value.slug !== 'string' || !value.slug || value.slug.length > 400 || /[\s\u0000-\u001f]/.test(value.slug)
      || typeof value.display_name !== 'string' || typeof value.shell_type !== 'string'
      || !['default', 'local', 'shell_command', 'unified_exec', 'disabled'].includes(value.shell_type)
      || !['list', 'hide'].includes(value.visibility) || typeof value.supported_in_api !== 'boolean'
      || !Number.isSafeInteger(value.priority) || typeof value.support_verbosity !== 'boolean'
      || !isObject(value.truncation_policy) || !['tokens', 'bytes'].includes(value.truncation_policy.mode)
      || !Number.isSafeInteger(value.truncation_policy.limit) || value.truncation_policy.limit <= 0
      || !Array.isArray(value.experimental_supported_tools) || value.experimental_supported_tools.some(item => typeof item !== 'string')
      || !Array.isArray(value.supported_reasoning_levels)
      || value.supported_reasoning_levels.some(item => !isObject(item) || !efforts.has(item.effort) || typeof item.description !== 'string')
      || (value.default_reasoning_level != null && !efforts.has(value.default_reasoning_level))) return undefined;
    const base = typeof value.base_instructions === 'string' && value.base_instructions.trim();
    const template = typeof value.model_messages?.instructions_template === 'string' && value.model_messages.instructions_template.trim();
    if (!base && !template) return undefined;
    // Native clients prefer a present template, including an empty one, over base_instructions.
    if (typeof value.model_messages?.instructions_template === 'string' && !template) return undefined;
    if (booleanFields.some(name => value[name] !== undefined && typeof value[name] !== 'boolean')
      || optionalStringFields.some(name => value[name] != null && typeof value[name] !== 'string')) return undefined;
    if (value.model_messages != null && !isObject(value.model_messages)) return undefined;
    if (isObject(value.model_messages)) {
      for (const name of ['instructions_template', 'content_filter_guidance', 'persistent_instructions']) {
        if (value.model_messages[name] != null && typeof value.model_messages[name] !== 'string') return undefined;
      }
      for (const name of messageFields) {
        if (['instructions_template', 'content_filter_guidance', 'persistent_instructions'].includes(name)) continue;
        if (value.model_messages[name] != null && !isObject(value.model_messages[name])) return undefined;
      }
    }
    if (value.input_modalities !== undefined && (!Array.isArray(value.input_modalities)
      || !value.input_modalities.includes('text') || value.input_modalities.some(item => !['text', 'image'].includes(item)))) return undefined;
    for (const name of ['context_window', 'max_context_window']) {
      if (value[name] != null && (!Number.isSafeInteger(value[name]) || value[name] <= 0)) return undefined;
    }
    if (value.effective_context_window_percent != null && (!Number.isSafeInteger(value.effective_context_window_percent)
      || value.effective_context_window_percent < 1 || value.effective_context_window_percent > 100)) return undefined;
    const result = Object.fromEntries(Object.entries(value).filter(([key]) => modelFields.has(key)).map(([key, item]) => [key, metadataValue(item)]));
    if (isObject(result.model_messages)) result.model_messages = Object.fromEntries(Object.entries(result.model_messages).filter(([key]) => messageFields.has(key)));
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_TEMPLATE_BYTES) return undefined;
    return result;
  } catch { return undefined; }
}

/** Optional local metadata discovery only; no auth.json, account data, network, or writes. */
export function readNativeModelMetadata(): Record<string, any>[] {
  try {
    const file = path.join(path.dirname(codexConfigPath()), 'models_cache.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CACHE_BYTES) return [];
    const cache = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(cache?.models) || cache.models.length > 1000) return [];
    return cache.models.flatMap((value: unknown) => { const model = validatedNativeModel(value); return model ? [model] : []; });
  } catch { return []; }
}
