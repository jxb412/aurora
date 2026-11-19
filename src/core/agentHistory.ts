import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AuroraStore } from './store/index.js';
import type { AgentState } from './store/types.js';
import { atomicWrite, readText, digest, type PlannedFile } from './agents/configFiles.js';
import { detectReset } from './agents/adapters.js';
import { getManagedHistoryTarget } from './agents/historyProviders.js';
import { isGatewayCatalogPath } from './agents/catalogStorage.js';
import { createHistoryRepairService } from './historyRepair.js';
import { historyContext, historyLocation, normalizeHistoryContext, assertClientsStopped, type HistoryContext } from './historyRepairIO.js';
import { recoverClientHistorySwitches, runClientHistorySwitch, type ClientHistorySwitchSnapshot, type ClientHistoryBackup } from './clientHistorySwitch.js';

export const CODEX_STATE_IDS = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'] as const;
interface Deps { store: AuroraStore; dataDir: string; historyContext?: HistoryContext }
type StateSlice = Record<string, AgentState | null>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = (value: unknown) => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).filter(key => key !== 'lastSyncAt').sort().map(key => [key, entry[key]]));
});
const slice = (states: Record<string, AgentState>): StateSlice => Object.fromEntries(CODEX_STATE_IDS.map(id => [id, states[id] ?? null]));
function validateSlice(value: unknown): asserts value is StateSlice {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...CODEX_STATE_IDS].sort().join()
    || CODEX_STATE_IDS.some(id => (value as StateSlice)[id] !== null && (!(value as StateSlice)[id] || (value as StateSlice)[id]?.id !== id)))
    throw new Error('客户端连接记录无法校验');
}
export const clientHistoryContext = (deps: Deps) => normalizeHistoryContext(deps.historyContext ?? historyContext());
export function clientConnectionRevision(deps: Deps): string {
  return digest(JSON.stringify([deps.store.providers.revision(deps.store.providers.read()), deps.store.settings.revision(deps.store.settings.read()), identity(slice(deps.store.readAgentSnapshot().states))]));
}
const trusted = (configurationText?: string, onPrepared?: (info: ClientHistoryBackup) => Promise<void>, reservation?: ClientHistoryBackup) => ({
  ...(configurationText === undefined ? {} : { configurationText }), backupAll: true, includeSubagents: true, requireAll: true, preserveMissingSourceIndexes: true, preserveUnrepairableHistory: true,
  ...(reservation ? { backupId: reservation.backupId } : {}),
  ...(onPrepared ? { lockHeld: true, onPrepared } : {}),
});

/** Only the action layer supplies the unredacted adapter plan. No renderer options are trusted. */
export async function prepareClientHistory(deps: Deps, configurationText: string, inspect = true, restore = false) {
  const historyTargetProvider = restore ? undefined : getManagedHistoryTarget(configurationText), historyTargetRequired = !restore;
  const deferred = (message: string) => ({ ok: true as const, revision: '', configurationText, historyTargetProvider, historyTargetRequired, history: {
    status: 'deferred' as 'pending' | 'deferred', total: 0, repairable: 0, unchanged: 0, blocked: 0, preserved: 0, skipped: 0,
    filesToBackUp: 0, indexDatabasesToBackUp: 0, blockedReasons: [] as string[], skippedReasons: [] as string[], backupRequired: false, requiresClientExit: false, message, warnings: [] as string[],
  } });
  if (historyTargetRequired && !historyTargetProvider) return deferred('可直接保存配置；历史兼容连接暂未就绪，已有历史保持不变。');
  if (!inspect) return deferred('先保存客户端配置，随后尝试处理历史。');
  try {
  const ctx = clientHistoryContext(deps); await assertClientsStopped(ctx);
  const plan = await createHistoryRepairService(ctx, trusted(configurationText)).preview({ scope: 'all', fixPaths: true, ...(historyTargetProvider ? { targetProvider: historyTargetProvider } : {}) });
  if (!plan.ok || !('summary' in plan)) return deferred('可直接保存配置；历史暂时无法检查，已有历史保持不变。');
  const summary = plan.summary;
  const backupRequired = summary.scanned > 0 || plan.dbPaths.length > 0;
  return { ok: true as const, revision: plan.revision, configurationText, historyTargetProvider, historyTargetRequired, history: {
    status: 'pending' as 'pending' | 'deferred',
    total: summary.scanned, repairable: summary.repairable, unchanged: summary.unchanged, blocked: summary.blocked, preserved: summary.preserved, skipped: summary.skipped,
    filesToBackUp: summary.filesToBackUp, indexDatabasesToBackUp: summary.indexDatabasesToBackUp,
    blockedReasons: [...new Set(plan.items.filter(item => item.status === 'blocked').map(item => item.reason || '无法安全处理的历史记录'))].slice(0, 5),
    skippedReasons: [...new Set([...plan.items.filter(item => item.status === 'skipped').map(item => item.reason || '无法安全修复的历史记录'), ...plan.backupOnlyDatabases.map(entry => entry.reason)])].slice(0, 5),
    backupRequired, requiresClientExit: false,
    message: summary.blocked ? `有 ${summary.blocked} 个历史会话需要检查，尚未更改配置。`
      : backupRequired ? `将自动备份 ${summary.filesToBackUp} 个会话文件和 ${summary.indexDatabasesToBackUp} 个索引数据库，并修复 ${summary.repairable} 个会话的归属。${summary.preserved ? `${summary.preserved} 条缺少原文件的会话索引将原样保留，不影响应用配置。` : ''}${summary.skipped ? `${summary.skipped} 个暂不能修复的会话将完整备份并原样保留，继续应用配置。` : ''}`
        : '未发现已有历史会话，可直接应用配置。',
    warnings: [...plan.warnings, ...plan.items.filter(item => item.status === 'blocked').slice(0, 5).map(item => `${item.id}：${item.reason}`)],
  } };
  } catch { return deferred('可直接保存配置；客户端运行中或历史暂不可读取，历史处理稍后进行。'); }
}
export type PreparedClientHistory = Extract<Awaited<ReturnType<typeof prepareClientHistory>>, { ok: true }>;

function recoveryOptions(deps: Deps, configurationOnly = false) {
  // A broken external SQLite directory must not prevent saving config.toml.
  const ctx = configurationOnly ? normalizeHistoryContext({ home: deps.historyContext?.home || path.dirname(getConfigurationPath()), sqliteHome: deps.historyContext?.home || path.dirname(getConfigurationPath()) }) : clientHistoryContext(deps);
  const validate = (snapshot: ClientHistorySwitchSnapshot) => {
    validateSlice(snapshot.stateBefore); validateSlice(snapshot.stateAfter);
    const key = (file: string) => { const canonical = historyLocation(file); return process.platform === 'win32' ? canonical.toLowerCase() : canonical; };
    const allowed = new Set([key(path.join(ctx.home, 'config.toml')), key(path.join(deps.dataDir, 'codex-model-catalog.json'))]);
    // The transaction canonicalizes snapshot paths (for example macOS /var -> /private/var).
    // Compare the API allowlist against the same physical data root during rollback/recovery.
    const catalogDataDir = historyLocation(deps.dataDir);
    if (snapshot.files.some(file => !allowed.has(key(file.path)) && !isGatewayCatalogPath(file.path, catalogDataDir))) throw new Error('配置恢复路径无法校验');
    const fresh = deps.store.readAgentSnapshot(), current = slice(fresh.states);
    for (const id of CODEX_STATE_IDS) {
      if (identity(current[id]) !== identity(snapshot.stateBefore[id]) && identity(current[id]) !== identity(snapshot.stateAfter[id]))
        throw new Error('客户端连接记录已经变化，已保留外部修改');
    }
    return fresh;
  };
  return {
    ctx, dataDir: deps.dataDir, configurationOnly,
    createHistoryService: (onPrepared: (info: ClientHistoryBackup) => Promise<void>) => createHistoryRepairService(ctx, trusted(undefined, onPrepared)),
    revalidateRecovery: (snapshot: ClientHistorySwitchSnapshot) => { validate(snapshot); },
    rollbackConfig: async (snapshot: ClientHistorySwitchSnapshot) => {
      validate(snapshot);
      for (const file of [...snapshot.files].reverse()) {
        const exists = fs.existsSync(file.path), content = readText(file.path);
        if (exists === file.existed && content === file.before) continue;
        if (exists !== (file.afterExisted !== false) || content !== file.after) throw new Error('配置已经变化，已保留外部修改');
        if (file.existed) atomicWrite(file.path, file.before, { existed: exists, content });
        else if (exists) fs.unlinkSync(file.path);
      }
      const fresh = validate(snapshot), before = snapshot.stateBefore as StateSlice;
      if (identity(slice(fresh.states)) !== identity(before)) {
        const restored = { ...fresh.states };
        for (const id of CODEX_STATE_IDS) { if (before[id] === null) delete restored[id]; else restored[id] = before[id]!; }
        deps.store.agents.writeIfUnchanged(restored, fresh.revision);
      }
      return { ok: true };
    },
  };
}

export async function recoverClientHistory(deps: Deps) {
  // Older history-first journals remain available for explicit inspection.
  // New automatic configuration never restores their stale configuration.
  return recoverClientHistorySwitches(recoveryOptions(deps, true));
}

function getConfigurationPath(): string {
  // Resolve only the configuration root, without touching CODEX_SQLITE_HOME.
  const home = process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}
async function optionalHistory(deps: Deps, prepared: PreparedClientHistory) {
  const { configurationText, historyTargetProvider, historyTargetRequired } = prepared;
  const base = { backedUp: 0, indexBackedUp: 0, repaired: 0, unchanged: 0, preserved: 0, skipped: 0, skippedReasons: [] as string[], code: undefined as string | undefined, backupId: undefined as string | undefined, backupPath: undefined as string | undefined };
  if (historyTargetRequired && (!historyTargetProvider || getManagedHistoryTarget(configurationText) !== historyTargetProvider))
    return { ...base, status: 'deferred' as const, code: 'CLIENT_HISTORY_TARGET_UNAVAILABLE', message: '配置已保存；历史兼容连接暂未就绪，已有历史保持不变。' };
  let ctx: HistoryContext;
  try { ctx = clientHistoryContext(deps); await assertClientsStopped(ctx); }
  catch (error) { const running = /检测到：/.test(String((error as Error).message)); return { ...base, status: 'deferred' as const, code: running ? 'CLIENT_HISTORY_BUSY' : 'CLIENT_HISTORY_DEFERRED', message: running ? '配置已保存；客户端正在运行，历史保持不变，退出后可再处理。' : '配置已保存；历史暂不可读取，已保留原状，可稍后重试。' }; }
  try {
    // Never replay a previous history-first transaction over a newer saved
    // configuration. Its original backup remains available for manual review.
    const legacyRoot = path.join(deps.dataDir, 'client-history-switches');
    if (fs.existsSync(legacyRoot)) for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const name of fs.readdirSync(path.join(legacyRoot, entry.name)).filter(name => /^switch-.*\.json$/.test(name))) {
        const previous = JSON.parse(readText(path.join(legacyRoot, entry.name, name)));
        if (!['complete', 'rolled-back'].includes(previous.status)) return { ...base, status: 'deferred' as const, message: '配置已保存；发现旧版未完成的历史处理记录，已保留原始备份供稍后检查。' };
      }
    }
    if (readText(path.join(ctx.home, 'config.toml')) !== configurationText) return { ...base, status: 'deferred' as const, message: '配置已保存；客户端随后更新了配置，历史保持不变。' };
    const input = { scope: 'all' as const, fixPaths: true, ...(historyTargetProvider ? { targetProvider: historyTargetProvider } : {}) };
    const service = createHistoryRepairService(ctx, trusted(configurationText)), plan = await service.preview(input);
    if (!plan.ok || !('summary' in plan)) return { ...base, status: 'failed' as const, message: '配置已保存；历史检查暂未完成，可稍后重新处理历史。' };
    const result = await service.apply({ ...input, revision: plan.revision });
    if (!result.ok) return { ...base, status: 'failed' as const, backupId: result.backupId, backupPath: result.backup, message: '配置已保存；历史备份或修复暂未完成，可稍后在历史记录中重试。' };
    return { ...base, status: 'completed' as const, backedUp: result.backedUp, indexBackedUp: result.indexBackedUp, repaired: result.updated, unchanged: plan.summary.unchanged, preserved: result.preserved, skipped: result.skipped,
      skippedReasons: [...new Set([...plan.items.filter(item => item.status === 'skipped').map(item => item.reason || '已备份并跳过'), ...plan.backupOnlyDatabases.map(entry => entry.reason)])].slice(0, 5), backupId: result.backupId, backupPath: result.backup, message: result.message };
  } catch { return { ...base, status: 'failed' as const, message: '配置已保存；历史处理暂未完成，可稍后重试。' }; }
}
/** Config/catalog/state commit atomically; optional history can never undo that success. */
export async function applyClientHistory<T extends { ok: boolean; message: string; backup?: string }>(deps: Deps, options: {
  prepared: PreparedClientHistory;
  files: Array<PlannedFile & { afterExisted?: boolean }>;
  commit: () => T;
  states: (result: T) => AgentState[];
  revalidate: () => void;
}) {
  const { prepared } = options, initial = deps.store.readAgentSnapshot(), stateBefore = clone(slice(initial.states));
  const recovery = recoveryOptions(deps, true);
  let committed: T | undefined;
  const switched = await runClientHistorySwitch({
    ...recovery,
    snapshot: { files: options.files, stateBefore, stateAfter: stateBefore },
    historyRevision: 'configuration-only', historyInput: {},
    revalidate: () => {
      if (identity(slice(deps.store.readAgentSnapshot().states)) !== identity(stateBefore)) throw new Error('连接状态在处理期间发生变化');
      options.revalidate();
    },
    commit: async control => {
      committed = options.commit();
      if (!committed.ok) return committed;
      const fresh = deps.store.readAgentSnapshot();
      if (identity(slice(fresh.states)) !== identity(stateBefore)) throw new Error('连接状态在处理期间发生变化');
      const states = options.states(committed), after = { ...fresh.states };
      for (const state of states) after[state.id] = { ...after[state.id], ...state };
      control.setStateAfter(clone(slice(after)));
      deps.store.saveAgentsIfUnchanged(states, fresh);
      return committed;
    },
  });
  detectReset();
  if (!switched.ok) return { ok: false, code: switched.code, message: switched.message,
    ...(committed?.backup ? { backup: committed.backup } : {}), rolledBack: switched.rolledBack,
    recoveryRequired: switched.recoveryRequired, ...(switched.journalPath ? { recoveryPath: switched.journalPath } : {}) };
  return { ...switched.result!, message: '客户端配置已保存，重新启动客户端后生效。', history: await optionalHistory(deps, prepared) };
}

export function historyPreviewRevision(clientRevision: string | undefined, prepared: PreparedClientHistory, connectionRevision: string): string {
  return digest(JSON.stringify({ clientRevision, connectionRevision }));
}
