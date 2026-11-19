import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-api-catalog-storage-'));
const read = file => fs.readFileSync(file, 'utf8');
let count = 0;
try {
  const bundle = path.join(scratch, 'storage.cjs');
  await build({ entryPoints: [path.join(workspace, 'src/core/agents/catalogStorage.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const catalog = providerId => ({ models: [{ slug: providerId + '/fixture-model', base_instructions: 'fixture' }], yunqiao: { kind: 'yunqiao-api-gateway-v1', providerId } });
  const check = (name, run) => { run(); count++; console.log('PASS', name); };
  const data = name => { const dir = path.join(scratch, name); fs.mkdirSync(dir); return dir; };

  check('首次挂载使用独立文件，保护旧共存目录和所有 profile 引用', () => {
    const dir = data('first'), legacy = path.join(dir, 'codex-model-catalog.json');
    const reserved = path.join(dir, api.CODEX_API_MODEL_CATALOG_FILE);
    const original = '{"models":[{"slug":"original-model"}],"external":true}';
    fs.writeFileSync(legacy, original);
    const config = `model_catalog_json = ${JSON.stringify(legacy)}\n[profiles.work]\nmodel_catalog_json = ${JSON.stringify(reserved)}\n`;
    const plan = api.planGatewayModelCatalog(dir, catalog('a'), config);
    assert.equal(plan.path, path.join(dir, 'codex-api-model-catalog-2.json'));
    assert.equal(plan.existed, false); assert.equal(plan.before, '');
    assert.equal(read(legacy), original); assert(!fs.existsSync(reserved));
  });

  check('接入前已有签名目录仍保留，只有现有受管连接允许复用', () => {
    const dir = data('owned'), existing = path.join(dir, api.CODEX_API_MODEL_CATALOG_FILE);
    const original = api.serializeGatewayModelCatalog(catalog('old'));
    fs.writeFileSync(existing, original);
    const config = `model_catalog_json = ${JSON.stringify(existing)}\n`;
    const fresh = api.planGatewayModelCatalog(dir, catalog('next'), config);
    assert.notEqual(fresh.path, existing); assert.equal(read(existing), original);
    const again = api.planGatewayModelCatalog(dir, catalog('next'), config, { reuseManagedCurrent: true });
    assert.equal(again.path, existing); assert.equal(again.before, original); assert.equal(again.existed, true);
  });

  check('外部改动后另建目录，不覆盖已有内容或阻止可用配置', () => {
    const dir = data('external-edit'), existing = path.join(dir, api.CODEX_API_MODEL_CATALOG_FILE);
    const edited = JSON.parse(api.serializeGatewayModelCatalog(catalog('a')));
    edited.models[0].base_instructions = 'outside change';
    const original = JSON.stringify(edited);
    fs.writeFileSync(existing, original);
    assert.equal(api.readManagedGatewayModelCatalog(existing, dir), undefined);
    const plan = api.planGatewayModelCatalog(dir, catalog('a'), `model_catalog_json = ${JSON.stringify(existing)}\n`, { reuseManagedCurrent: true });
    assert.notEqual(plan.path, existing); assert.equal(read(existing), original);
  });

  check('刷新签名验证覆盖全部模型内容与供应商标记', () => {
    const dir = data('integrity'), file = path.join(dir, api.CODEX_API_MODEL_CATALOG_FILE);
    const text = api.serializeGatewayModelCatalog(catalog('a'));
    fs.writeFileSync(file, text);
    assert.equal(api.readManagedGatewayModelCatalog(file, dir).text, text);
    for (const mutate of [value => value.models.push({ slug: 'extra' }), value => { value.yunqiao.providerId = 'changed'; }, value => { value.yunqiao.storageVersion = 2; }]) {
      const edited = JSON.parse(text); mutate(edited); fs.writeFileSync(file, JSON.stringify(edited));
      assert.equal(api.readManagedGatewayModelCatalog(file, dir), undefined);
    }
  });

  check('受管路径白名单仅允许数据目录直系文件，分配跳过普通文件和目录', () => {
    const dir = data('paths');
    for (const filename of ['codex-api-model-catalog.json', 'codex-api-model-catalog-2.json', 'codex-api-model-catalog-256.json']) assert(api.isGatewayCatalogPath(path.join(dir, filename), dir));
    for (const filename of ['codex-model-catalog.json', 'codex-api-model-catalog-1.json', 'codex-api-model-catalog-02.json', 'codex-api-model-catalog-0.json', 'other.json', 'nested/codex-api-model-catalog.json']) assert(!api.isGatewayCatalogPath(path.join(dir, filename), dir));
    assert(!api.isGatewayCatalogPath('../codex-api-model-catalog.json', dir));
    fs.writeFileSync(path.join(dir, api.CODEX_API_MODEL_CATALOG_FILE), 'foreign content');
    fs.mkdirSync(path.join(dir, 'codex-api-model-catalog-2.json'));
    const plan = api.planGatewayModelCatalog(dir, catalog('a'), '');
    assert.equal(plan.path, path.join(dir, 'codex-api-model-catalog-3.json'));
  });

  console.log(`API 模型目录存储：${count} 项检查通过`);
} finally {
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
