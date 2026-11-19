import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-api-model-catalog-'));
const priorHome = process.env.AURORA_CLIENT_HOME;
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS', name); };
try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: [
    "export * from './src/core/actions.ts';", "export * from './src/core/store/index.ts';",
    "export * from './src/core/agents/modelCatalog.ts';", "export * from './src/core/extensions/models.ts';",
    "export * from './src/core/cloud.ts';",
  ].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, configText = 'model_reasoning_effort = "xhigh"\nmodel_context_window = 123\nmodel_auto_compact_token_limit = 100\n') {
    const root = path.join(scratch, name), client = path.join(root, 'client');
    process.env.AURORA_CLIENT_HOME = client;
    const config = path.join(client, '.codex', 'config.toml');
    write(config, configText);
    const store = new api.AuroraStore(path.join(root, 'store'));
    store.saveSettings({ gatewayToken: 'fixture-gateway-secret', gatewayPort: 3425 });
    const provider = store.saveProvider({ name: '当前供应商', enabled: true, format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1',
      apiKeys: [{ id: 'key', key: 'fixture-provider-secret', enabled: true, weight: 1 }],
      models: [{ id: 'gpt-5.4', contextWindow: 272000 }, { id: 'custom-text', contextWindow: 64000 }, { id: 'custom-vision', capabilities: { vision: true } },
        { id: 'no-thinking', capabilities: { thinking: false } }, { id: 'gpt-image-1' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }] });
    store.saveProvider({ ...provider, id: undefined, name: '其他供应商', models: [{ id: 'not-current' }] });
    const deps = { store, dataDir: store.dir, gatewayUrl: () => 'http://127.0.0.1:3425', gatewayStatus: () => ({ running: true }),
      historyContext: { home: path.dirname(config), sqliteHome: path.dirname(config), blockingProcesses: async () => ['fixture-client-running'] } };
    const payload = { agentId: 'codex-cli', providerId: provider.id, model: 'gpt-5.4', authMode: 'api', mode: 'gateway' };
    const call = (action, patch = {}) => api.runAction(deps, action, { ...payload, ...patch });
    const catalog = path.join(store.dir, 'codex-model-catalog.json');
    const connect = async patch => { const preview = await call('agent.preview', patch); assert(preview.ok, preview.message); return call('agent.connect', { ...patch, revision: preview.revision }); };
    return { root, config, configText, catalog, store, provider, deps, payload, call, connect };
  }
  const noSecrets = value => { for (const secret of ['fixture-gateway-secret', 'fixture-provider-secret']) assert(!JSON.stringify(value).includes(secret)); };
  const guardOfficialFiles = async run => {
    const originalRead = fs.readFileSync, originalStat = fs.lstatSync; let attempts = 0;
    const guard = file => { if (typeof file === 'string' && /(?:auth\.json|models_cache\.json)$/.test(file)) { attempts++; throw new Error('API 模式不得读取官方身份或缓存'); } };
    fs.readFileSync = function(file, ...args) { guard(file); return originalRead.call(this, file, ...args); };
    fs.lstatSync = function(file, ...args) { guard(file); return originalStat.call(this, file, ...args); };
    try { const result = await run(); assert.equal(attempts, 0, 'API 模式不得尝试读取官方身份或缓存'); return result; }
    finally { fs.readFileSync = originalRead; fs.lstatSync = originalStat; }
  };
  await check('API 网关无需官方身份，挂载当前供应商全部文本模型并保留 xhigh', async () => {
    const f = fixture('basic');
    await guardOfficialFiles(async () => {
      const preview = await f.call('agent.preview'); assert(preview.ok, preview.message); noSecrets(preview);
      assert.equal(read(f.config), f.configText); assert(!fs.existsSync(f.catalog));
      const connected = await f.call('agent.connect', { revision: preview.revision }); assert(connected.ok, connected.message); noSecrets(connected);
      const config = parse(read(f.config)), catalog = json(f.catalog);
      assert.equal(config.model_catalog_json, f.catalog); assert.equal(config.model, `${f.provider.id}/gpt-5.4`);
      assert.equal(config.model_reasoning_effort, 'xhigh'); assert.equal(config.model_context_window, undefined); assert.equal(config.model_auto_compact_token_limit, undefined);
      assert.equal(config.model_providers.yunqiao.requires_openai_auth, false);
      assert.deepEqual(catalog.models.map(m => m.slug), ['gpt-5.4', 'custom-text', 'custom-vision', 'no-thinking'].map(id => `${f.provider.id}/${id}`));
      assert.deepEqual(catalog.models[0].supported_reasoning_levels.map(x => x.effort), ['low', 'medium', 'high', 'xhigh']);
      assert.equal(catalog.models[0].auto_compact_token_limit, 244800);
      assert.equal(catalog.models[1].default_reasoning_level, null); assert.deepEqual(catalog.models[1].supported_reasoning_levels, []);
      assert.deepEqual(catalog.models[2].input_modalities, ['text', 'image']);
      for (const model of catalog.models) { assert.equal(model.supports_parallel_tool_calls, false); assert(!model.supported_reasoning_levels.some(x => x.effort === 'none')); }
      const desktop = api.desktopModelCatalog(f.store); assert.deepEqual(desktop.models, catalog.models.map(m => m.slug));
      assert(desktop.modelMetadata[`${f.provider.id}/gpt-5.4`].supportedReasoningEfforts.some(x => x.reasoningEffort === 'xhigh')); noSecrets(desktop);
      const disconnected = await f.call('agent.disconnect'); assert(disconnected.ok, disconnected.message); assert.equal(read(f.config), f.configText);
    });
  });
  await check('新模型仅凭显式能力启用 reasoning，禁用声明优先于模型名', async () => {
    const f = fixture('explicit-reasoning');
    const models = [
      { id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-sol-enabled', capabilities: { thinking: true } },
      { id: 'custom-effort', thinkingField: 'reasoning_effort' },
      { id: 'gpt-5.4-disabled', capabilities: { thinking: false } },
      { id: 'gpt-5.4-none', thinkingField: 'none' },
    ];
    const catalog = api.buildGatewayModelCatalog({ ...f.provider, models });
    assert.deepEqual(catalog.models.map(m => m.supported_reasoning_levels.map(level => level.effort)),
      [[], ['low', 'medium', 'high'], ['low', 'medium', 'high'], [], []]);
    assert.deepEqual(catalog.models.map(m => m.default_reasoning_level), [null, 'medium', 'medium', null, null]);
  });
  await check('显式等级优先、白名单去重排序，默认值必须来自支持列表', () => {
    const f = fixture('explicit-efforts');
    const cases = [
      [{ id: 'unknown-max', supportedReasoningEfforts: ['max', 'high', 'medium', 'low', 'xhigh', 'minimal', 'none', 'max', 'invalid', 5, null] }, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
      [{ id: 'gpt-5.4', supportedReasoningEfforts: ['max', 'high', 'high'] }, ['high', 'max'], 'high'],
      [{ id: 'only-max', supportedReasoningEfforts: ['max'] }, ['max'], 'max'],
      [{ id: 'only-minimal', supportedReasoningEfforts: ['minimal'] }, ['minimal'], 'minimal'],
      [{ id: 'only-none', supportedReasoningEfforts: ['none'] }, ['none'], 'none'],
      [{ id: 'gpt-5.4-empty', supportedReasoningEfforts: [] }, [], null],
      [{ id: 'gpt-5.4-invalid', supportedReasoningEfforts: ['MAX', 'invalid', {}, null] }, [], null],
      [{ id: 'gpt-5.4-disabled', capabilities: { thinking: false }, supportedReasoningEfforts: ['medium', 'max'] }, [], null],
      [{ id: 'gpt-5.4-none', thinkingField: 'none', supportedReasoningEfforts: ['max'] }, [], null],
      [{ id: 'unknown-named-max' }, [], null],
      [{ id: 'unknown-thinking-max', capabilities: { thinking: true } }, ['low', 'medium', 'high'], 'medium'],
      [{ id: 'gpt-5.1-codex-max' }, ['low', 'medium', 'high', 'xhigh'], 'medium'],
      [{ id: 'gpt-5' }, ['minimal', 'low', 'medium', 'high'], 'medium'],
    ];
    const before = structuredClone(cases);
    for (const [model, expected, defaultLevel] of cases) {
      const entry = api.buildGatewayModelCatalog({ ...f.provider, models: [model] }).models[0];
      assert.deepEqual(entry.supported_reasoning_levels.map(level => level.effort), expected, model.id);
      assert.equal(entry.default_reasoning_level, defaultLevel, model.id);
      assert(defaultLevel === null || expected.includes(defaultLevel));
    }
    assert.deepEqual(cases, before, '目录生成不得修改供应商元数据');
  });
  await check('网关刷新与扩展目录保持显式等级，直连使用相同列表和否决规则', async () => {
    const f = fixture('refresh-efforts');
    const models = [
      { id: 'gpt-5.4', supportedReasoningEfforts: ['max', 'high', 'high'] },
      { id: 'custom-text', supportedReasoningEfforts: ['max', 'medium', 'low'] },
      { id: 'disabled', supportedReasoningEfforts: ['max'], capabilities: { thinking: false } },
      { id: 'field-none', supportedReasoningEfforts: ['max'], thinkingField: 'none' },
      { id: 'gpt-5-empty', supportedReasoningEfforts: [] },
    ];
    f.store.saveProvider({ id: f.provider.id, models });
    assert.equal((await f.connect()).ok, true);
    api.refreshGatewayModelCatalog(f.store);
    const native = json(f.catalog), desktop = api.desktopModelCatalog(f.store);
    for (const entry of native.models) {
      const metadata = desktop.modelMetadata[entry.slug];
      assert.deepEqual(metadata.supportedReasoningEfforts.map(level => level.reasoningEffort), entry.supported_reasoning_levels.map(level => level.effort));
      assert.equal(metadata.defaultReasoningEffort ?? null, entry.default_reasoning_level);
    }
    assert.deepEqual(native.models[0].supported_reasoning_levels.map(level => level.effort), ['high', 'max']);
    assert.equal(native.models[0].default_reasoning_level, 'high');
    f.store.saveProvider({ id: f.provider.id, models: models.map(m => m.id === 'gpt-5.4' ? { ...m, supportedReasoningEfforts: ['max'] } : m) });
    api.refreshGatewayModelCatalog(f.store);
    assert.deepEqual(json(f.catalog).models[0].supported_reasoning_levels, [{ effort: 'max', description: 'max' }]);
    assert.equal(json(f.catalog).models[0].default_reasoning_level, 'max');
    assert.equal((await f.connect({ mode: 'direct' })).ok, true);
    const direct = api.desktopModelCatalog(f.store);
    for (const [id, levels, defaultLevel] of [['gpt-5.4', ['max'], 'max'], ['custom-text', ['low', 'medium', 'max'], 'medium'], ['disabled', ['none'], 'none'], ['field-none', ['none'], 'none'], ['gpt-5-empty', [], undefined]]) {
      assert.deepEqual(direct.modelMetadata[id].supportedReasoningEfforts.map(level => level.reasoningEffort), levels);
      assert.equal(direct.modelMetadata[id].defaultReasoningEffort, defaultLevel);
    }
  });
  await check('云目录校验、缓存再校验及导入保留显式等级和 none 否决', () => {
    const f = fixture('cloud-efforts');
    const raw = { key: 'explicit-fixture', name: '显式模型目录', format: 'openai-responses', baseUrl: 'https://explicit.fixture.invalid/v1',
      models: [
        { id: 'explicit', supportedReasoningEfforts: ['max', 'medium', 'low', 'max', 'invalid'] },
        { id: 'disabled', supportedReasoningEfforts: ['max'], thinkingField: 'none' },
        { id: 'empty', supportedReasoningEfforts: [] },
      ] };
    const normalized = api.validateCloudProvider(raw);
    assert.deepEqual(normalized.models[0].supportedReasoningEfforts, ['low', 'medium', 'max']);
    assert.equal(normalized.models[1].thinkingField, 'none');
    assert.deepEqual(api.validateCloudProvider(normalized), normalized);
    const imported = api.importCloudProviders(f.store, [normalized]).providers[0];
    const saved = new api.AuroraStore(f.store.dir).getProvider(imported.id);
    assert.deepEqual(saved.models, JSON.parse(JSON.stringify(imported.models)));
    const catalog = api.buildGatewayModelCatalog({ ...saved, apiKeys: f.provider.apiKeys });
    assert.deepEqual(catalog.models.map(m => m.supported_reasoning_levels.map(level => level.effort)), [['low', 'medium', 'max'], [], []]);
    assert.deepEqual(catalog.models.map(m => m.default_reasoning_level), ['medium', null, null]);
  });
  await check('目录内容或供应商列表在预览后变化时拒绝写入', async () => {
    for (const kind of ['catalog', 'models']) {
      const f = fixture('stale-' + kind), preview = await f.call('agent.preview'); assert(preview.ok);
      if (kind === 'catalog') write(f.catalog, '{"models":[],"external":"保留"}\n');
      else f.store.saveProvider({ id: f.provider.id, models: [...f.provider.models, { id: 'later-text' }] });
      const beforeCatalog = fs.existsSync(f.catalog) ? read(f.catalog) : null;
      const result = await f.call('agent.connect', { revision: preview.revision }); assert.equal(result.ok, false); assert.equal(read(f.config), f.configText);
      assert.equal(fs.existsSync(f.catalog) ? read(f.catalog) : null, beforeCatalog);
    }
  });
  await check('配置写入失败和连接状态保存失败均回滚目录与配置', async () => {
    for (const kind of ['write', 'state']) {
      const f = fixture('failure-' + kind), originalWrite = fs.writeFileSync;
      write(f.catalog, '{"models":[],"prior":true}\n'); const before = read(f.catalog);
      if (kind === 'state') f.store.saveAgentsIfUnchanged = () => { throw new Error('fixture-state-failure'); };
      else fs.writeFileSync = function(file, ...args) { if (String(file).startsWith(f.config + '.aurora-')) throw Object.assign(new Error('fixture-write-failure'), { code: 'EACCES' }); return originalWrite.call(this, file, ...args); };
      let result; try { result = await f.connect(); } finally { fs.writeFileSync = originalWrite; }
      assert.equal(result.ok, false); assert.equal(read(f.config), f.configText); assert.equal(read(f.catalog), before);
      assert(!f.store.listAgents()['codex-cli']?.connected); noSecrets(result);
    }
  });
  await check('目录原子写 CAS 保留写入期间出现的外部修改', async () => {
    const f = fixture('catalog-cas'), preview = await f.call('agent.preview'); assert(preview.ok);
    const originalWrite = fs.writeFileSync; let raced = false;
    fs.writeFileSync = function(file, ...args) {
      const result = originalWrite.call(this, file, ...args);
      if (!raced && String(file).startsWith(f.catalog + '.aurora-')) { raced = true; originalWrite.call(this, f.catalog, '{"external":"保留并发修改"}'); }
      return result;
    };
    let result; try { result = await f.call('agent.connect', { revision: preview.revision }); } finally { fs.writeFileSync = originalWrite; }
    assert(raced); assert.equal(result.ok, false); assert.equal(read(f.config), f.configText);
    assert.equal(read(f.catalog), '{"external":"保留并发修改"}'); assert(!f.store.listAgents()['codex-cli']?.connected);
  });
  await check('外部根目录或 profile 目录明确报冲突，直连仍保留目录', async () => {
    for (const source of ['model_catalog_json = "C:/fixture-external.json"\n', 'profile = "work"\n[profiles.work]\nmodel_catalog_json = "C:/fixture-profile.json"\n']) {
      const f = fixture('external-' + passed + source.length, source), preview = await f.call('agent.preview');
      assert.equal(preview.ok, false); assert.match(preview.message, /外部自定义模型目录/); assert.equal(read(f.config), source); assert(!fs.existsSync(f.catalog));
      const direct = await f.connect({ mode: 'direct' }); assert(direct.ok, direct.message); assert(!fs.existsSync(f.catalog));
      const parsed = parse(read(f.config)); assert.equal(parsed.profiles?.work?.model_catalog_json ?? parsed.model_catalog_json, parse(source).profiles?.work?.model_catalog_json ?? parse(source).model_catalog_json);
    }
  });
  await check('刷新反映模型新增删除，且不会覆盖外部目录或直连', async () => {
    const f = fixture('refresh'), result = await f.connect(); assert(result.ok, result.message);
    f.store.saveProvider({ id: f.provider.id, models: [{ id: 'gpt-5.4', contextWindow: 128000 }, { id: 'new-text' }] });
    await guardOfficialFiles(() => api.refreshGatewayModelCatalog(f.store));
    assert.deepEqual(json(f.catalog).models.map(m => m.slug), [`${f.provider.id}/gpt-5.4`, `${f.provider.id}/new-text`]);
    assert.equal(json(f.catalog).models[0].context_window, 128000);
    const direct = await f.connect({ mode: 'direct' }); assert(direct.ok, direct.message); const prior = read(f.catalog);
    f.store.saveProvider({ id: f.provider.id, models: [{ id: 'gpt-5.4' }, { id: 'direct-only-new' }] });
    api.refreshGatewayModelCatalog(f.store); assert.equal(read(f.catalog), prior);
    const again = await f.connect(); assert(again.ok, again.message);
    write(f.catalog, '{"models":[],"external":true}'); api.refreshGatewayModelCatalog(f.store); assert.equal(read(f.catalog), '{"models":[],"external":true}');
  });
  await check('刷新清理已停用或删除供应商，不泄露其他供应商模型', async () => {
    for (const action of ['disable', 'delete']) {
      const f = fixture('unavailable-' + action), connected = await f.connect(); assert(connected.ok, connected.message);
      if (action === 'disable') f.store.saveProvider({ id: f.provider.id, enabled: false });
      else f.store.providers.write(f.store.listProviders().filter(provider => provider.id !== f.provider.id));
      api.refreshGatewayModelCatalog(f.store); assert.deepEqual(json(f.catalog).models, []);
    }
  });
  await check('profile 网关目录仅写根级且清除旧的全局窗口覆盖', async () => {
    const f = fixture('profile', 'profile = "work"\n[profiles.work]\nmodel_context_window = 99\nmodel_auto_compact_token_limit = 90\n');
    const result = await f.connect(); assert(result.ok, result.message);
    const parsed = parse(read(f.config)); assert.equal(parsed.model_catalog_json, f.catalog); assert.equal(parsed.profiles.work.model_catalog_json, undefined);
    assert.equal(parsed.profiles.work.model_context_window, undefined); assert.equal(parsed.profiles.work.model_auto_compact_token_limit, undefined);
  });
  console.log(`API 原生模型目录：${passed} 项隔离检查通过`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(path.dirname(scratch), os.tmpdir()); fs.rmSync(scratch, { recursive: true, force: true });
}
