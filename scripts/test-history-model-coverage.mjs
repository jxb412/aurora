import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunqiao-history-model-'));
const bundle = path.join(scratch, 'coverage.cjs');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let passed = 0;
try {
  await build({ entryPoints: [path.join(workspace, 'src/core/agents/historyModelCoverage.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { readHistoryModelCoverage: coverage } = createRequire(import.meta.url)(bundle);
  const catalog = { models: [
    { slug: 'supplier/selected', context_window: 64000, auto_compact_token_limit: 57600, effective_context_window_percent: 95 },
    { slug: 'supplier/same-budget', context_window: 64000, auto_compact_token_limit: 57600, effective_context_window_percent: 95 },
    { slug: 'supplier/larger', context_window: 272000, auto_compact_token_limit: 244800, effective_context_window_percent: 95 },
  ] };
  const run = home => coverage('model="supplier/selected"\n', home, home, catalog, 'supplier/selected');
  const fixture = name => { const home = path.join(scratch, name); fs.mkdirSync(home, { recursive: true }); return home; };
  const check = (name, fn) => { fn(); passed++; console.log('PASS', name); };
  function database(home, model, rollout, table = 'threads') {
    const file = table === 'threads' ? path.join(home, 'state_5.sqlite') : path.join(home, 'sqlite', 'catalog.db');
    fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file);
    try { db.exec(`CREATE TABLE ${table}(model TEXT,rollout_path TEXT)`); if (model !== undefined) db.prepare(`INSERT INTO ${table} VALUES(?,?)`).run(model, rollout); }
    finally { db.close(); } return file;
  }
  function log(file, model) { write(file, JSON.stringify({ type: 'session_meta', payload: { model_provider: 'legacy' } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model } }) + '\n'); }
  check('Empty profiles and empty known databases can use per-model limits', () => {
    const home = fixture('empty'); assert.equal(run(home).safe, true); database(home); assert.equal(run(home).safe, true);
  });
  check('Exact indexed historical models retain the selected window and 90% trigger', () => {
    const home = fixture('covered'), rollout = path.join(home, 'sessions', 'rollout.jsonl');
    database(home, 'supplier/same-budget', rollout); log(rollout, 'supplier/same-budget'); assert.equal(run(home).safe, true);
    database(home, 'supplier/same-budget', rollout, 'local_thread_catalog'); assert.equal(run(home).safe, true);
    if (process.platform === 'win32') {
      const extended = fixture('extended-path'), source = path.join(extended, 'sessions', 'rollout.jsonl');
      database(extended, 'supplier/selected', '\\\\?\\' + source); log(source, 'supplier/selected'); assert.equal(run(extended).safe, true);
    }
  });
  check('Unknown old model names and prefix matches use ordinary root limits', () => {
    for (const model of ['retired-model', 'supplier/selected-new', 'supplier/larger']) {
      const home = fixture('uncovered-' + passed + model.replaceAll('/', '_')), rollout = path.join(home, 'sessions', 'rollout.jsonl');
      database(home, model, rollout); log(rollout, model); assert.equal(run(home).safe, false);
    }
  });
  check('Orphaned rollout and outdated index evidence cannot clear root limits', () => {
    const home = fixture('orphan'), rollout = path.join(home, 'sessions', 'rollout.jsonl');
    log(rollout, 'supplier/selected'); assert.equal(run(home).safe, false);
    database(home, 'supplier/selected', rollout); log(rollout, 'retired-model'); assert.equal(run(home).safe, false);
    log(rollout, 'supplier/selected'); fs.appendFileSync(rollout, '{bad trailing record'); assert.equal(run(home).safe, false);
    const missing = fixture('missing-source'); database(missing, 'supplier/selected', path.join(missing, 'sessions', 'missing.jsonl')); assert.equal(run(missing).safe, false);
  });
  check('Unreadable, unknown-schema and busy databases conservatively fall back', () => {
    const corrupt = fixture('corrupt'); write(path.join(corrupt, 'state_5.sqlite'), 'corrupt'); assert.equal(run(corrupt).safe, false);
    const unknown = fixture('unknown'); const db = new DatabaseSync(path.join(unknown, 'state_5.sqlite'));
    try { db.exec('CREATE TABLE threads(model_provider TEXT); INSERT INTO threads VALUES(\'legacy\')'); } finally { db.close(); }
    assert.equal(run(unknown).safe, false);
    const busy = fixture('busy'), file = database(busy), lock = new DatabaseSync(file);
    try { lock.exec('BEGIN EXCLUSIVE'); assert.equal(run(busy).safe, false); } finally { lock.exec('ROLLBACK'); lock.close(); }
  });
  check('Large rollouts are not scanned without bounds or treated as complete', () => {
    const home = fixture('large'), rollout = path.join(home, 'sessions', 'large.jsonl');
    database(home, 'supplier/selected', rollout); write(rollout, 'x'.repeat(2 * 1024 * 1024 + 1)); assert.equal(run(home).safe, false);
  });
  check('Conflicting database rows and invalid catalog budgets fall back', () => {
    const home = fixture('conflict'), rollout = path.join(home, 'sessions', 'rollout.jsonl');
    database(home, 'supplier/selected', rollout); database(home, 'supplier/same-budget', rollout, 'local_thread_catalog'); log(rollout, 'supplier/selected'); assert.equal(run(home).safe, false);
    const empty = fixture('invalid-budget');
    assert.equal(coverage('', empty, empty, { models: [{ ...catalog.models[0], auto_compact_token_limit: 1 }] }, 'supplier/selected').safe, false);
    assert.equal(coverage('', empty, empty, { models: [catalog.models[0], catalog.models[0]] }, 'supplier/selected').safe, false);
  });
  console.log(`${passed} historical model coverage checks passed`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
