/** Official-account coexistence regressions; fixture auth, loopback servers, no real API requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { zstdCompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-coexist-'));
process.env.AURORA_CLIENT_HOME = path.join(scratch, 'client');
const nativeHome = path.join(process.env.AURORA_CLIENT_HOME, '.codex');
fs.mkdirSync(nativeHome, { recursive: true });
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: [
  './src/core/gateway/coexist.ts', './src/core/gateway/server.ts', './src/core/gateway/upstream.ts',
  './src/core/gateway/liveUsage.ts', './src/core/store/index.ts', './src/core/extensions/models.ts',
].map(file => `export * from '${file}';`).join('\n'), resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
const m = createRequire(import.meta.url)(bundle);
const jwt = (generation, expires = Date.now() / 1000 + 3600) => `${Buffer.from('{"alg":"fixture"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: expires, generation, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
let token = jwt(1);
const authFile = path.join(nativeHome, 'auth.json'), configFile = path.join(nativeHome, 'config.toml');
const writeAuth = (value = token) => fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: value, refresh_token: 'fixture-refresh-must-never-be-used', account_id: 'fixture-account', id_token: 'fixture-id-token' }, last_refresh: '2026-11-15T00:00:00Z' }));
writeAuth();
const initialAuth = fs.readFileSync(authFile, 'utf8');
fs.writeFileSync(path.join(nativeHome, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-fixture', display_name: 'GPT Fixture', context_window: 123456, visibility: 'list', supported_reasoning_levels: [{ effort: 'high', description: 'High' }], default_reasoning_level: 'high', model_messages: { instructions_template: 'Fixture native instructions' }, supports_parallel_tool_calls: true, authorization: 'must-not-copy' },
  { slug: 'hidden-fixture', visibility: 'hide' }, { slug: '../invalid' },
] }));
let officialMode = 'ok', supplierMode = 'ok', officialCalls = [], supplierCalls = [], cancelledOfficial = false, cancelledSupplier = false;
let releaseStream;
const officialMock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  officialCalls.push({ url: req.url, headers: req.headers, body });
  if (officialMode === '401') { res.writeHead(401); res.end('fixture official token error'); return; }
  if (officialMode === 'redirect') { res.writeHead(302, { location: 'https://attacker.invalid/collect' }); res.end(); return; }
  if (officialMode === 'slow') { res.on('close', () => { cancelledOfficial = true; }); return; }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'official-response', status: 'in_progress', usage: { input_tokens: 42, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`);
    releaseStream = () => res.end(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"真实中文🌏"}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'official-response', status: 'completed', output: [], usage: { input_tokens: 42, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'official-response', object: req.url.endsWith('/compact') ? 'response.compaction' : 'response', status: 'completed', model: body.model,
    output: [{ type: 'reasoning', encrypted_content: 'official-opaque-content', summary: [] }], usage: { input_tokens: 42, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } }));
});
const supplierMock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  supplierCalls.push({ headers: req.headers, body });
  if (supplierMode === 'slow') { res.on('close', () => { cancelledSupplier = true; }); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'supplier-response', status: 'completed', model: body.model,
    output: [{ type: 'custom_tool_call', name: 'fixture_tool', call_id: 'fixture-call', input: 'opaque' }], usage: { input_tokens: 2, output_tokens: 3 } }));
});
await Promise.all([new Promise(resolve => officialMock.listen(0, '127.0.0.1', resolve)), new Promise(resolve => supplierMock.listen(0, '127.0.0.1', resolve))]);
const store = new m.AuroraStore(path.join(scratch, 'store'));
store.saveSettings({ gatewayHost: '127.0.0.1', gatewayToken: 'fixture-local-gateway-token', maskSecrets: false, logRequests: true, maxRetries: 0 });
const supplier = store.saveProvider({ name: 'Fixture Relay', baseUrl: `http://127.0.0.1:${supplierMock.address().port}/v1`, format: 'openai-responses', enabled: true,
  apiKeys: [{ id: 'key', label: 'Fixture', key: 'fixture-supplier-secret', enabled: true, weight: 1 }], models: [{ id: 'gpt-fixture', contextWindow: 65536 }] });
store.saveAgent({ id: 'chatgpt-desktop', connected: true, mode: 'gateway', authMode: 'coexist', providerId: supplier.id, model: 'gpt-fixture' });
let officialTransportCount = 0;
const gateway = new m.GatewayServer({ store, officialTransport: async (url, options) => {
  officialTransportCount++;
  assert.ok(['https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses/compact'].includes(url));
  return m.openUpstream(`http://127.0.0.1:${officialMock.address().port}${new URL(url).pathname}`, options);
} });
await gateway.start('127.0.0.1', 0);
const port = gateway.getStatus().port;
store.saveSettings({ gatewayPort: port });
const nativeConfig = `# retain official identity\nmodel_provider = "openai"\nmodel = "official/gpt-fixture"\nopenai_base_url = "${m.codexCoexistBaseUrl(port)}"\n[mcp_servers.fixture]\ncommand = "fixture"\n`;
fs.writeFileSync(configFile, nativeConfig);
const base = `http://127.0.0.1:${port}`, nativePath = m.CODEX_COEXIST_BASE_PATH;
const request = (tail, body, headers = {}) => fetch(base + nativePath + tail, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let passed = 0;
const test = async (name, action) => { await action(); passed++; console.log(`PASS ${name}`); };
const waitUntil = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture wait timed out'); await new Promise(resolve => setTimeout(resolve, 15)); } };
try {
  await test('official status exposes no credential or personal identifier', () => {
    const identity = m.readOfficialCodexIdentity(); assert.equal(identity.available, true);
    const text = JSON.stringify(identity); for (const secret of [token, 'fixture-account', 'fixture-refresh', 'fixture-id-token']) assert.ok(!text.includes(secret));
  });
  await test('native catalog separates official and same-name relay models with actual schema', () => {
    const catalog = m.getCoexistCatalog(store); assert.equal(catalog.officialModelCount, 1); assert.equal(catalog.models.length, 2);
    assert.equal(catalog.nativeCatalog.models[0].base_instructions, 'Fixture native instructions');
    assert.equal(catalog.nativeCatalog.models[1].supports_parallel_tool_calls, false);
    assert.ok(!JSON.stringify(catalog).includes('must-not-copy'));
    assert.equal(m.desktopModelCatalog(store).codex_model_provider, 'openai');
  });
  await test('共存原生和扩展目录复用显式等级，不继承官方能力且否决优先', () => {
    const models = [
      { id: 'gpt-fixture', supportedReasoningEfforts: ['max', 'high', 'high'] },
      { id: 'explicit-medium', supportedReasoningEfforts: ['max', 'medium', 'low'] },
      { id: 'disabled', supportedReasoningEfforts: ['max'], capabilities: { thinking: false } },
      { id: 'field-none', supportedReasoningEfforts: ['max'], thinkingField: 'none' },
      { id: 'gpt-5-empty', supportedReasoningEfforts: [] },
      { id: 'gpt-5.1-codex-max' },
    ];
    try {
      store.saveProvider({ id: supplier.id, models });
      const catalog = m.getCoexistCatalog(store), desktop = m.desktopModelCatalog(store);
      const expected = [['high', 'max'], ['low', 'medium', 'max'], [], [], [], ['none']];
      const defaults = ['high', 'medium', null, null, null, 'none'];
      models.forEach((model, index) => {
        const id = `${supplier.id}/${model.id}`, native = catalog.nativeCatalog.models.find(entry => entry.slug === id);
        assert.deepEqual(native.supported_reasoning_levels.map(level => level.effort), expected[index]);
        assert.equal(native.default_reasoning_level, defaults[index]);
        assert.deepEqual(desktop.modelMetadata[id].supportedReasoningEfforts.map(level => level.reasoningEffort), expected[index]);
        assert.equal(desktop.modelMetadata[id].defaultReasoningEffort ?? null, defaults[index]);
      });
      assert.equal(catalog.nativeCatalog.models[0].default_reasoning_level, 'high');
      assert.deepEqual(catalog.nativeCatalog.models[0].supported_reasoning_levels, [{ effort: 'high', description: 'High' }]);
    } finally { store.saveProvider({ id: supplier.id, models: supplier.models }); }
  });
  await test('rewritten cache never promotes relay IDs or duplicates official prefixes', () => {
    const cacheFile = path.join(nativeHome, 'models_cache.json'), initial = fs.readFileSync(cacheFile, 'utf8');
    const catalog = m.getCoexistCatalog(store);
    fs.writeFileSync(cacheFile, JSON.stringify(catalog.nativeCatalog));
    let reread = m.getCoexistCatalog(store);
    assert.deepEqual(reread.models.filter(model => model.official).map(model => model.id), ['official/gpt-fixture']);
    assert.equal(reread.models.filter(model => model.id === `${supplier.id}/gpt-fixture`).length, 1);
    fs.writeFileSync(cacheFile, JSON.stringify({ models: catalog.nativeCatalog.models.filter(model => !model.slug.startsWith('official/')) }));
    reread = m.getCoexistCatalog(store); assert.equal(reread.officialModelSource, 'saved-cache'); assert.equal(reread.officialModelCount, 1);
    fs.unlinkSync(cacheFile); assert.equal(m.getCoexistCatalog(store).officialModelSource, 'saved-cache');
    const sameAccount = fs.readFileSync(authFile, 'utf8'), different = JSON.parse(sameAccount); different.tokens.account_id = 'other-fixture-account'; fs.writeFileSync(authFile, JSON.stringify(different));
    assert.equal(m.getCoexistCatalog(store).officialModelCount, 0);
    fs.writeFileSync(authFile, sameAccount); fs.writeFileSync(cacheFile, initial);
    const isolated = new m.AuroraStore(path.join(scratch, 'foreign-catalog-store'));
    isolated.saveSettings({ gatewayPort: port });
    fs.writeFileSync(configFile, 'model_provider = "foreign"\n');
    assert.equal(m.getCoexistCatalog(isolated).officialModelCount, 0);
    fs.writeFileSync(configFile, nativeConfig);
  });
  await test('native models endpoint returns native models and provider-qualified menu IDs', async () => {
    const response = await request('/models'); assert.equal(response.status, 200); const body = await response.json();
    assert.deepEqual(body.models.map(model => model.slug), ['official/gpt-fixture', `${supplier.id}/gpt-fixture`]); assert.equal(body.data.length, 2);
  });
  await test('OAuth only authorizes dedicated loopback endpoint, never RPC or browser traffic', async () => {
    for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: 'Bearer fixture-local-gateway-token' }]) assert.equal((await request('/models', undefined, headers)).status, 401);
    assert.equal((await request('/models', undefined, { origin: base })).status, 403);
    assert.equal((await request('/models', undefined, { 'sec-fetch-site': 'same-origin' })).status, 403);
    const forgedHostStatus = await new Promise((resolve, reject) => { const req = http.get(base + nativePath + '/models', { headers: { host: `evil.invalid:${port}`, authorization: `Bearer ${token}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(base + '/api/state', { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal(m.authorizeCodexCoexistRequest({ url: nativePath + '/models', socket: { remoteAddress: '192.168.1.2' }, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, store).status, 403);
  });
  await test('native websocket upgrades get authenticated 426 HTTP fallback instead of socket reset', async () => {
    const upgrade = authorization => new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${nativePath}/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${authorization}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZS13ZWJzb2NrZXQ=\r\n\r\n`));
      let response = ''; socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade timed out'))); socket.on('data', chunk => { response += chunk.toString(); }); socket.on('end', () => resolve(response)); socket.on('error', reject);
    });
    assert.ok((await upgrade(token)).startsWith('HTTP/1.1 426 ')); assert.ok((await upgrade('wrong')).startsWith('HTTP/1.1 401 '));
    assert.ok(m.getCoexistCatalog(store).nativeCatalog.models.every(model => model.prefer_websockets === false));
  });
  await test('relay receives only its own key and no OAuth, account, cookie or actor headers', async () => {
    const response = await request('/responses', { model: `${supplier.id}/gpt-fixture`, stream: false, input: 'fixture' },
      { cookie: 'official-cookie', 'chatgpt-account-id': 'hostile-account', 'x-openai-actor-authorization': token, 'x-api-key': token, 'x-codex-thread-id': 'relay-thread' });
    assert.equal(response.status, 200); assert.equal((await response.json()).output[0].type, 'custom_tool_call');
    const sent = supplierCalls.at(-1); assert.equal(sent.headers.authorization, 'Bearer fixture-supplier-secret'); assert.equal(sent.body.model, 'gpt-fixture');
    const text = JSON.stringify(sent); for (const secret of [token, 'official-cookie', 'hostile-account', 'fixture-refresh']) assert.ok(!text.includes(secret));
  });
  await test('native zstd requests decode losslessly before both official and relay routing', async () => {
    for (const model of ['official/gpt-fixture', `${supplier.id}/gpt-fixture`]) {
      const response = await fetch(base + nativePath + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-encoding': 'zstd' }, body: zstdCompressSync(Buffer.from(JSON.stringify({ model, input: '压缩请求🌏', stream: false }))) });
      assert.equal(response.status, 200); await response.json();
    }
    assert.equal(officialCalls.at(-1).body.input, '压缩请求🌏'); assert.equal(supplierCalls.at(-1).body.input, '压缩请求🌏');
    const before = officialCalls.length;
    assert.equal((await request('/responses', { model: 'official/gpt-fixture', input: [] }, { 'content-encoding': 'zstd' })).status, 400);
    assert.equal((await request('/responses', { model: 'official/gpt-fixture', input: [] }, { 'content-encoding': 'unsupported' })).status, 415);
    const tooLarge = await fetch(base + nativePath + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-encoding': 'zstd' }, body: zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1, 32)) });
    assert.equal(tooLarge.status, 400);
    assert.equal(officialCalls.length, before);
  });
  await test('official model uses fixed official endpoint and current account headers', async () => {
    const response = await request('/responses', { model: 'official/gpt-fixture', stream: false, input: 'fixture' }, { 'chatgpt-account-id': 'hostile-account', cookie: 'must-not-send' });
    assert.equal(response.status, 200); assert.equal((await response.json()).output[0].encrypted_content, 'official-opaque-content');
    const sent = officialCalls.at(-1); assert.equal(sent.headers.authorization, `Bearer ${token}`); assert.equal(sent.headers['chatgpt-account-id'], 'fixture-account');
    assert.equal(sent.headers.originator, 'codex_cli_rs'); assert.equal(sent.headers.cookie, undefined); assert.equal(sent.body.model, 'gpt-fixture');
    assert.equal(store.recentRequests(5).find(record => record.providerId === 'official').inputTokens, 42);
  });
  await test('streaming official usage remains live and preserves Unicode and opaque events', async () => {
    const response = await request('/responses', { model: 'official/gpt-fixture', stream: true, input: 'fixture' }, { 'x-codex-thread-id': 'official-thread' });
    assert.equal(response.status, 200); await waitUntil(() => !!releaseStream);
    await waitUntil(() => m.activeRequests(store).some(request => request.inputTokens === 42));
    const live = m.activeRequests(store).find(request => request.threadId === 'official-thread'); assert.equal(live.cacheRead, 0); assert.equal(live.cacheWrite, undefined);
    releaseStream(); const text = await response.text(); assert.ok(text.includes('真实中文🌏')); assert.ok(text.includes('response.completed'));
    await waitUntil(() => m.activeRequests(store).length === 0);
  });
  await test('official compact works and third-party compact fails before charging', async () => {
    const before = supplierCalls.length;
    const response = await request('/responses/compact', { model: 'official/gpt-fixture', input: [] });
    assert.equal(response.status, 200); assert.equal((await response.json()).object, 'response.compaction');
    assert.ok(officialCalls.at(-1).url.endsWith('/responses/compact'));
    assert.equal((await request('/responses/compact', { model: `${supplier.id}/gpt-fixture`, input: [] })).status, 501); assert.equal(supplierCalls.length, before);
  });
  await test('official 401 never falls back to relay or refreshes native credentials', async () => {
    officialMode = '401'; const before = supplierCalls.length;
    assert.equal((await request('/responses', { model: 'official/gpt-fixture', input: [] })).status, 401);
    assert.equal(supplierCalls.length, before); assert.equal(fs.readFileSync(authFile, 'utf8'), initialAuth); officialMode = 'ok';
  });
  await test('official redirects are rejected without a second outgoing request', async () => {
    officialMode = 'redirect'; const before = officialTransportCount;
    assert.equal((await request('/responses', { model: 'official/gpt-fixture', input: [] })).status, 502);
    assert.equal(officialTransportCount, before + 1); officialMode = 'ok';
  });
  await test('native rotation invalidates old token and adopts new token without writing auth', async () => {
    const previous = token; token = jwt(2); writeAuth();
    assert.equal((await request('/models', undefined, { authorization: `Bearer ${previous}` })).status, 401);
    assert.equal((await request('/models')).status, 200);
    assert.equal((await request('/responses', { model: 'gpt-fixture', input: [] })).status, 200);
    assert.equal(officialCalls.at(-1).headers.authorization, `Bearer ${token}`);
  });
  await test('configuration drift and active-profile override disable coexistence', async () => {
    fs.writeFileSync(configFile, nativeConfig + '\n[profiles.external]\nmodel_provider = "other"\n');
    fs.writeFileSync(configFile, 'profile = "external"\n' + fs.readFileSync(configFile, 'utf8'));
    assert.equal((await request('/models')).status, 409);
    fs.writeFileSync(configFile, nativeConfig + '\n[model_providers.openai]\nbase_url = "https://unexpected.invalid/v1"\n');
    assert.equal((await request('/models')).status, 409); fs.writeFileSync(configFile, nativeConfig);
  });
  await test('cancelling before official headers aborts upstream and clears live request', async () => {
    officialMode = 'slow'; const before = officialCalls.length, controller = new AbortController();
    const pending = fetch(base + nativePath + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'official/gpt-fixture', input: [] }), signal: controller.signal }).catch(() => null);
    await waitUntil(() => officialCalls.length > before); controller.abort(); await pending;
    await waitUntil(() => cancelledOfficial && m.activeRequests(store).length === 0); officialMode = 'ok';
  });
  await test('cancelling before relay headers aborts upstream without retry', async () => {
    supplierMode = 'slow'; const before = supplierCalls.length, controller = new AbortController();
    const pending = fetch(base + nativePath + '/responses', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `${supplier.id}/gpt-fixture`, input: [] }), signal: controller.signal }).catch(() => null);
    await waitUntil(() => supplierCalls.length > before); controller.abort(); await pending;
    await waitUntil(() => cancelledSupplier && m.activeRequests(store).length === 0); assert.equal(supplierCalls.length, before + 1); supplierMode = 'ok';
  });
  await test('disabled or unknown relay cannot fall through to same-name official model', async () => {
    store.saveProvider({ ...supplier, enabled: false }); const before = officialCalls.length;
    assert.equal((await request('/responses', { model: `${supplier.id}/gpt-fixture`, input: [] })).status, 400);
    assert.equal((await request('/responses', { model: 'unknown/model', input: [] })).status, 400); assert.equal(officialCalls.length, before);
    store.saveProvider({ ...supplier, enabled: true });
  });
  await test('invalid or expired native credentials remain untouched and never leak into logs', async () => {
    writeAuth(jwt(3, Date.now() / 1000 - 60)); assert.equal(m.readOfficialCodexIdentity().status, 'expired');
    fs.writeFileSync(authFile, '{broken'); assert.equal(m.readOfficialCodexIdentity().status, 'invalid'); assert.equal((await request('/models')).status, 401); assert.equal(fs.readFileSync(authFile, 'utf8'), '{broken');
    writeAuth(); const logs = JSON.stringify(store.recentRequests(100)); for (const secret of [token, 'fixture-account', 'fixture-refresh', 'fixture-supplier-secret']) assert.ok(!logs.includes(secret));
    assert.equal(fs.readFileSync(configFile, 'utf8'), nativeConfig);
  });
  console.log(`Coexistence: ${passed} tests passed`);
} finally {
  releaseStream?.(); await gateway.stop();
  await Promise.all([new Promise(resolve => { officialMock.close(resolve); officialMock.closeAllConnections(); }), new Promise(resolve => { supplierMock.close(resolve); supplierMock.closeAllConnections(); })]);
  const resolved = path.resolve(scratch);
  if (!resolved.startsWith(path.join(os.tmpdir(), 'aurora-coexist-'))) throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(resolved, { recursive: true, force: true });
}
