import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-native-model-metadata-'));
const priorHome = process.env.AURORA_CLIENT_HOME;
const home = path.join(scratch, 'client');
process.env.AURORA_CLIENT_HOME = home;
const cache = path.join(home, '.codex', 'models_cache.json');
fs.mkdirSync(path.dirname(cache), { recursive: true });
const native = (slug, overrides = {}) => ({ slug, display_name: slug, base_instructions: `Native ${slug} coding instructions.`,
  model_messages: { instructions_template: 'Native {personality} coding instructions.', instructions_variables: { personality: { default: 'default', friendly: 'friendly' } } },
  shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
  supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }, { effort: 'xhigh', description: 'Extra high' }],
  default_reasoning_level: 'medium', input_modalities: ['text', 'image'], context_window: 272000, ...overrides });
const provider = { id: 'fixture-provider', name: 'Fixture', enabled: true, baseUrl: 'http://127.0.0.1:1/v1',
  apiKeys: [{ enabled: true, key: 'fixture-provider-key' }], models: [{ id: 'gpt-5.4', contextWindow: 272000 }] };
let passed = 0;
const check = (name, run) => { run(); passed++; console.log('PASS', name); };
const originalRead = fs.readFileSync, originalStat = fs.lstatSync;
const guard = file => { assert(!/(?:^|[/\\])auth\.json$/.test(String(file)), 'API model discovery must never read account credentials'); };
try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: "export * from './src/core/agents/modelCatalog.ts'; export * from './src/core/agents/nativeModelMetadata.ts';",
    resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  fs.readFileSync = function(file, ...args) { guard(file); return originalRead.call(this, file, ...args); };
  fs.lstatSync = function(file, ...args) { guard(file); return originalStat.call(this, file, ...args); };
  check('missing or invalid native cache uses compatibility fallback without credentials', () => {
    assert.deepEqual(api.readNativeModelMetadata(), []);
    assert.equal(api.buildGatewayModelCatalog(provider), undefined);
    fs.writeFileSync(cache, '{invalid'); assert.equal(api.buildGatewayModelCatalog(provider), undefined);
    fs.writeFileSync(cache, JSON.stringify({ models: [native('gpt-5.4', { base_instructions: '', model_messages: null })] }));
    assert.equal(api.buildGatewayModelCatalog(provider), undefined);
  });
  check('exact native template retains coding instructions and unspecified image capability', () => {
    const template = native('gpt-5.4');
    fs.writeFileSync(cache, JSON.stringify({ access_token: 'never-copy-account-token', models: [template] }));
    const actual = api.buildGatewayModelCatalog(provider);
    assert(actual);
    assert.equal(actual.models[0].base_instructions, template.base_instructions);
    assert.deepEqual(actual.models[0].model_messages, template.model_messages);
    assert.deepEqual(actual.models[0].input_modalities, ['text', 'image']);
    assert.deepEqual(actual.models[0].supported_reasoning_levels, template.supported_reasoning_levels);
    assert.equal(actual.models[0].auto_compact_token_limit, 244800);
    assert(!JSON.stringify(actual).includes('never-copy-account-token'));
  });
  check('explicit vision and reasoning overrides are preserved without guessing model capabilities', () => {
    const actual = api.buildGatewayModelCatalog({ ...provider, models: [{ id: 'custom-model', contextWindow: 128000,
      capabilities: { vision: false, thinking: false } }] }, [native('custom-model')]);
    assert.deepEqual(actual.models[0].input_modalities, ['text']);
    assert.deepEqual(actual.models[0].supported_reasoning_levels, []);
    assert.equal(actual.models[0].default_reasoning_level, null);
    assert.equal(actual.models[0].auto_compact_token_limit, 115200);
    const unknown = api.buildGatewayModelCatalog({ ...provider, models: [{ id: 'gpt-future' }] }, []);
    assert.equal(unknown, undefined);
    const ultra = api.buildGatewayModelCatalog(provider, [native('gpt-5.4', {
      supported_reasoning_levels: [{ effort: 'ultra', description: 'Native Ultra' }], default_reasoning_level: 'ultra',
    })]);
    assert.equal(ultra.models[0].default_reasoning_level, 'ultra');
    assert.deepEqual(ultra.models[0].supported_reasoning_levels, [{ effort: 'ultra', description: 'Native Ultra' }]);
  });
  check('missing, ambiguous, and malformed model templates use fallback for the entire catalog', () => {
    assert.equal(api.buildGatewayModelCatalog({ ...provider, models: [...provider.models, { id: 'unknown-model' }] }, [native('gpt-5.4')]), undefined);
    assert.equal(api.buildGatewayModelCatalog(provider, [native('gpt-5.4'), native('official/gpt-5.4')]), undefined);
    for (const invalid of [{ shell_type: 'invalid' }, { input_modalities: ['invalid'] }, { priority: '1' },
      { base_instructions: 42 }, { model_messages: { instructions_template: 42 } },
      { model_messages: { instructions_template: '' } }, { model_messages: { instructions_template: '   ' } },
      { supports_parallel_tool_calls: 'yes' }, { effective_context_window_percent: -1 },
      { supported_reasoning_levels: [{ effort: 'invalid', description: 'Invalid' }] }, { truncation_policy: { mode: 'invalid', limit: 10 } }]) {
      assert.equal(api.buildGatewayModelCatalog(provider, [native('gpt-5.4', invalid)]), undefined);
    }
  });
  check('native metadata strips credentials and account envelopes while retaining template variables', () => {
    const model = native('gpt-5.4', { api_key: 'never-copy-key', account_id: 'never-copy-account',
      model_messages: { instructions_template: 'Use {personality}.', instructions_variables: { personality: { default: 'native-default', access_token: 'never-copy-token' } }, arbitrary_account_data: { name: 'never-copy-extra' } } });
    const actual = api.buildGatewayModelCatalog(provider, [model]);
    assert.equal(actual.models[0].model_messages.instructions_variables.personality.default, 'native-default');
    assert(!JSON.stringify(actual).includes('never-copy'));
  });
  check('oversized cache and generated catalog fall back before configuration write limits', () => {
    fs.writeFileSync(cache, ' '.repeat(12 * 1024 * 1024 + 1)); assert.deepEqual(api.readNativeModelMetadata(), []);
    const models = Array.from({ length: 16 }, (_, i) => ({ id: `custom-${i}`, contextWindow: 128000 }));
    const templates = models.map(m => native(m.id, { base_instructions: 'Native instructions. '.repeat(15000) }));
    assert.equal(api.buildGatewayModelCatalog({ ...provider, models }, templates), undefined);
  });
  console.log(`Native model metadata: ${passed} isolated checks passed`);
} finally {
  fs.readFileSync = originalRead; fs.lstatSync = originalStat;
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir())); fs.rmSync(scratch, { recursive: true, force: true });
}
