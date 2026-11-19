import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { defaultAutoCompactTokenLimit, isValidContextWindow } from '../modelContext.js';

interface ModelCatalog { models: Array<Record<string, any>> }
export interface HistoryModelCoverage { safe: boolean; reason: string }
const LIMITS = { databases: 40, rows: 50000, files: 2000, directories: 256, entries: 12000, fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 };
const key = (file: string) => process.platform === 'win32'
  ? path.resolve(file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase() : path.resolve(file);
const fail = (reason: string): HistoryModelCoverage => ({ safe: false, reason });

/** A catalog is an optimization, never a prerequisite for saving configuration.
 * Native resume retains the historical model name while our compatibility route
 * selects the new upstream model. Missing or ambiguous evidence therefore keeps
 * the ordinary root window/90% settings instead of guessing a catalog alias.
 * Callers must also establish that native clients are stopped before enabling it.
 */
export function readHistoryModelCoverage(configText: string, home: string, sqliteHome: string,
  catalog: ModelCatalog, selectedSlug: string): HistoryModelCoverage {
  try {
    parse(configText.replace(/^\uFEFF/, ''));
    const selected = catalog.models.find(model => model.slug === selectedSlug);
    if (!selected || !isValidContextWindow(selected.context_window)
      || selected.auto_compact_token_limit !== defaultAutoCompactTokenLimit(selected.context_window)) return fail('所选模型上下文信息不完整');
    const models = new Map<string, Record<string, any>>();
    for (const model of catalog.models) {
      if (typeof model.slug !== 'string' || models.has(model.slug)) return fail('模型目录包含重复或无效标识');
      models.set(model.slug, model);
    }
    const indexed = new Map<string, string>(), seenDatabases = new Set<string>(), verifiedRollouts = new Set<string>();
    let databases = 0, rows = 0, files = 0, directories = 0, entries = 0, bytes = 0;
    const directory = (file: string): fs.Dirent[] => {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('历史目录不可完整读取');
      return fs.readdirSync(file, { withFileTypes: true });
    };
    const compatible = (model: unknown): model is string => {
      if (typeof model !== 'string') return false;
      // Never use Codex's prefix matching: similarly named models can have
      // different capacities, and every migrated history uses selectedSlug.
      const entry = models.get(model);
      return !!entry && entry.context_window === selected.context_window
        && entry.auto_compact_token_limit === selected.auto_compact_token_limit
        && entry.effective_context_window_percent === selected.effective_context_window_percent;
    };
    for (const folder of [sqliteHome, path.join(sqliteHome, 'sqlite')]) {
      for (const entry of directory(folder)) {
        if (folder === sqliteHome ? !/^(?:state_\d+|thread_history_\d+)\.sqlite$/.test(entry.name) : !/\.(?:sqlite|sqlite3|db)$/i.test(entry.name)) continue;
        const file = path.join(folder, entry.name), databaseKey = key(file);
        if (seenDatabases.has(databaseKey)) continue;
        seenDatabases.add(databaseKey);
        if (!entry.isFile() || ++databases > LIMITS.databases) return fail('历史数据库无法完整检查');
        let db: any;
        try {
          const { DatabaseSync } = require('node:sqlite');
          db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout=5; BEGIN');
          const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row: any) => row.name));
          const supported = ['threads', 'local_thread_catalog'].filter(table => tables.has(table));
          if (!supported.length) return fail('历史数据库结构尚无法确认');
          for (const table of supported) {
            if (!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) continue;
            const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => row.name));
            if (!columns.has('model') || !columns.has('rollout_path')) return fail('历史模型或正文位置尚无法确认');
            for (const row of db.prepare(`SELECT model,rollout_path FROM ${table} LIMIT ${LIMITS.rows - rows + 1}`).all()) {
              if (++rows > LIMITS.rows) return fail('历史数量超过本次完整检查范围');
              if (!compatible(row.model)) return fail('旧会话模型与当前模型目录的上下文设置不一致');
              if (typeof row.rollout_path !== 'string' || !path.isAbsolute(row.rollout_path)) return fail('历史正文位置尚无法确认');
              const rollout = key(row.rollout_path), previous = indexed.get(rollout);
              if (previous !== undefined && previous !== row.model) return fail('历史索引包含不一致的模型');
              indexed.set(rollout, row.model);
            }
          }
        } finally { try { db?.close(); } catch { /* Outer fallback remains conservative. */ } }
      }
    }
    const walk = (folder: string, depth = 0): boolean => {
      if (depth > 10 || ++directories > LIMITS.directories) return false;
      for (const entry of directory(folder)) {
        if (++entries > LIMITS.entries) return false;
        const file = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) return false;
        if (entry.isDirectory()) { if (!walk(file, depth + 1)) return false; }
        else if (entry.name.endsWith('.jsonl')) {
          if (!entry.isFile() || ++files > LIMITS.files || !indexed.has(key(file))) return false;
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.fileBytes || (bytes += stat.size) > LIMITS.totalBytes) return false;
          const content = fs.readFileSync(file), after = fs.lstatSync(file);
          if (content.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return false;
          const lines = new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '').split(/\r?\n/);
          let contexts = 0;
          for (const line of lines) {
            if (!line.trim()) continue;
            const value = JSON.parse(line);
            if (value?.type === 'turn_context') { if (!compatible(value.payload?.model)) return false; contexts++; }
          }
          if (!contexts) return false;
          verifiedRollouts.add(key(file));
        }
      }
      return true;
    };
    if (!walk(path.join(home, 'sessions')) || !walk(path.join(home, 'archived_sessions'))) return fail('部分历史正文缺少可确认的模型索引');
    if ([...indexed.keys()].some(file => !verifiedRollouts.has(file))) return fail('部分历史索引的正文暂时无法确认');
    return { safe: true, reason: '' };
  } catch { return fail('历史信息暂时无法完整读取，继续使用当前模型的上下文设置'); }
}
