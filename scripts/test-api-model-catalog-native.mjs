/** Opt-in installed Codex app-server acceptance: isolated profiles, fake keys, loopback only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
const candidates = process.env.AURORA_NATIVE_CODEX ? [process.env.AURORA_NATIVE_CODEX]
  : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name));
const executable = candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
assert(executable, 'Set AURORA_NATIVE_CODEX to an installed Codex executable. This test never downloads a client.');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-native-model-catalog-')));
const priorHome = process.env.AURORA_CLIENT_HOME;
const requests = [], blocked = [];
const deny = http.createServer((req, res) => { blocked.push(req.url); res.writeHead(403); res.end(); });
deny.on('connect', (req, socket) => { blocked.push(req.url); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
const upstream = http.createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
  requests.push(body);
  const response = { id: 'resp_fixture', object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] };
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const value of [{ type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }]) {
    res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  res.end();
});
await Promise.all([new Promise(resolve => deny.listen(0, '127.0.0.1', resolve)), new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))]);
const proxy = `http://127.0.0.1:${deny.address().port}`;
function isolatedEnvironment(home, work) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
  return Object.assign(env, { CODEX_HOME: home, USERPROFILE: work, HOME: work, TEMP: scratch, TMP: scratch,
    APPDATA: path.join(work, 'roaming'), LOCALAPPDATA: path.join(work, 'local'),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
}
function app(home, work) {
  const child = spawn(executable, ['app-server'], { env: isolatedEnvironment(home, work), cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', nextId = 0;
  const pending = new Map(), events = [];
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-12000); });
  child.stdout.on('data', value => {
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else events.push(message);
    }
  });
  return {
    events,
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${stderr}`)); }, 30000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ method }) + '\n'); },
    async stop() {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Isolated client stopped')); }
      pending.clear(); child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise(resolve => { const timer = setTimeout(() => child.kill(), 3000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    },
  };
}
const allText = request => [request.instructions || '', ...(request.input || []).filter(item => item.role === 'developer')
  .flatMap(item => (item.content || []).filter(part => part.type === 'input_text').map(part => part.text))];
const imageCount = request => (request.input || []).flatMap(item => item.content || []).filter(part => part.type === 'input_image').length;
const provider = { id: 'fixture-provider', name: 'Fixture', enabled: true, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
  apiKeys: [{ enabled: true, key: 'fixture-only' }], models: [{ id: 'gpt-5.4', contextWindow: 272000 }] };
let client;
try {
  const version = spawnSync(executable, ['--version'], { env: isolatedEnvironment(path.join(scratch, 'version-home'), scratch), cwd: scratch, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(version.status, 0, version.stderr); console.log(version.stdout.trim());
  const bundle = path.join(scratch, 'catalog.cjs');
  await build({ entryPoints: [path.join(workspace, 'src/core/agents/modelCatalog.ts')], outfile: bundle, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const { buildGatewayModelCatalog } = createRequire(import.meta.url)(bundle);
  let nativeInstructions = '';
  for (const mode of ['missing-template-fallback', 'native-template', 'empty-template-fallback', 'explicit-text-only']) {
    const work = path.join(scratch, mode), home = path.join(work, '.codex'); fs.mkdirSync(home, { recursive: true });
    process.env.AURORA_CLIENT_HOME = work;
    if (mode !== 'missing-template-fallback') {
      // The baseline supplies the installed client's own prompt; no production prompt is copied into the test source.
      const template = { slug: 'gpt-5.4', display_name: 'Fixture native model', base_instructions: nativeInstructions,
        shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, support_verbosity: false,
        truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
        supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }, { effort: 'xhigh', description: 'Extra high' }],
        default_reasoning_level: 'medium', input_modalities: ['text', 'image'], context_window: 272000 };
      if (mode === 'empty-template-fallback') template.model_messages = { instructions_template: '' };
      fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [template] }));
    }
    const selected = mode === 'explicit-text-only' ? { ...provider, models: [{ ...provider.models[0], capabilities: { vision: false } }] } : provider;
    const catalog = buildGatewayModelCatalog(selected);
    assert.equal(!!catalog, !mode.endsWith('-fallback'));
    const catalogFile = path.join(home, 'catalog.json');
    if (catalog) {
      assert.equal(catalog.models[0].auto_compact_token_limit, 244800);
      fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    }
    fs.writeFileSync(path.join(home, 'config.toml'), `model = "fixture-provider/gpt-5.4"\nmodel_provider = "yunqiao"\nmodel_reasoning_effort = "medium"\n`
      + (catalog ? `model_catalog_json = ${JSON.stringify(catalogFile.replaceAll('\\', '/'))}\n` : 'model_context_window = 272000\nmodel_auto_compact_token_limit = 244800\n')
      + `[model_providers.yunqiao]\nname = "Fixture"\nbase_url = ${JSON.stringify(provider.baseUrl)}\nwire_api = "responses"\nexperimental_bearer_token = "fixture-only"\nrequires_openai_auth = false\n`);
    client = app(home, work);
    await client.rpc('initialize', { clientInfo: { name: 'yunqiao-model-catalog-test', version: '0.0.0' }, capabilities: { experimentalApi: true } }); client.notify('initialized');
    const listed = await client.rpc('model/list', { includeHidden: true });
    if (catalog) {
      const model = listed.data.find(item => item.model === 'fixture-provider/gpt-5.4'); assert(model);
      assert(model.supportedReasoningEfforts.some(item => item.reasoningEffort === 'xhigh'));
      assert.deepEqual(model.inputModalities, mode === 'explicit-text-only' ? ['text'] : ['text', 'image']);
    }
    const thread = await client.rpc('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
    const offset = requests.length;
    const turn = await client.rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Say OK.', textElements: [] },
      { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }] });
    const deadline = Date.now() + 30000;
    let completed;
    while (Date.now() < deadline) { completed = client.events.find(event => event.method === 'turn/completed' && event.params?.turn?.id === turn.turn.id); if (completed) break; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(completed?.params?.turn?.status, 'completed'); assert.equal(requests.length, offset + 1);
    const sent = requests[offset];
    if (mode === 'missing-template-fallback') {
      nativeInstructions = allText(sent).find(text => text.includes('You are a coding agent') || text.includes('You are Codex')) || '';
      assert(nativeInstructions.length > 100, 'Installed client must provide non-empty native coding instructions');
    } else assert(allText(sent).some(text => text.includes(nativeInstructions)), 'Native coding instructions must survive catalog installation');
    assert.equal(imageCount(sent), mode === 'explicit-text-only' ? 0 : 1, 'Unspecified vision must not silently discard user images');
    console.log(`PASS ${mode}: native instructions retained; image inputs ${imageCount(sent)}`);
    await client.stop(); client = undefined;
  }
  console.log('Native API model catalog: 4 isolated app-server scenarios passed');
} finally {
  if (client) await client.stop();
  await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => deny.close(resolve))]);
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir())); fs.rmSync(scratch, { recursive: true, force: true });
}
