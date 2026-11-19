import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import type { GatewayModelCatalog } from './modelCatalog.js';
import { digest, readText, type PlannedFile } from './configFiles.js';

export const CODEX_API_MODEL_CATALOG_FILE = 'codex-api-model-catalog.json';
const OWNER = 'yunqiao-api-gateway-v1';
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const location = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/** API catalogs live directly in the application data directory, independently of coexist catalogs. */
export function isGatewayCatalogPath(file: unknown, dataDir: string): file is string {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)) return false;
  const name = path.basename(file);
  return location(path.dirname(file)) === location(dataDir)
    && /^codex-api-model-catalog(?:-(?:[2-9]|[1-9]\d{1,2}))?\.json$/.test(name);
}

/** The integrity marker detects outside edits; it is not an authentication credential. */
export function serializeGatewayModelCatalog(catalog: GatewayModelCatalog): string {
  const unsigned = JSON.parse(JSON.stringify(catalog));
  if (unsigned?.yunqiao?.kind !== OWNER || typeof unsigned.yunqiao.providerId !== 'string' || !Array.isArray(unsigned.models))
    throw new Error('无法生成有效的 API 模型目录');
  delete unsigned.yunqiao.contentSha256;
  unsigned.yunqiao.storageVersion = 1;
  const contentSha256 = digest(JSON.stringify(unsigned));
  const text = JSON.stringify({ ...unsigned, yunqiao: { ...unsigned.yunqiao, contentSha256 } }, null, 2);
  if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) throw new Error('API 模型目录过大，未更改现有目录');
  return text;
}

/** Unrecognized, linked or externally edited catalogs are never treated as writable. */
export function readManagedGatewayModelCatalog(file: unknown, dataDir: string): { text: string; catalog: GatewayModelCatalog } | undefined {
  if (!isGatewayCatalogPath(file, dataDir)) return undefined;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CATALOG_BYTES) return undefined;
    const text = readText(file), catalog = JSON.parse(text);
    if (catalog?.yunqiao?.kind !== OWNER || catalog.yunqiao.storageVersion !== 1
      || typeof catalog.yunqiao.providerId !== 'string' || !Array.isArray(catalog.models)
      || typeof catalog.yunqiao.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(catalog.yunqiao.contentSha256)) return undefined;
    const claimed = catalog.yunqiao.contentSha256;
    const unsigned = { ...catalog, yunqiao: { ...catalog.yunqiao } };
    delete unsigned.yunqiao.contentSha256;
    if (digest(JSON.stringify(unsigned)) !== claimed) return undefined;
    return { text, catalog };
  } catch { return undefined; }
}

/** Keep the original catalog available for disconnect by mounting a separate managed file. */
export function planGatewayModelCatalog(
  dataDir: string,
  catalog: GatewayModelCatalog,
  configurationText: string,
  options: { reuseManagedCurrent?: boolean } = {},
): PlannedFile {
  const root: any = parse(configurationText.replace(/^\uFEFF/, ''));
  const profile = typeof root.profile === 'string' ? root.profiles?.[root.profile] : undefined;
  const current = profile?.model_catalog_json ?? root.model_catalog_json;
  const after = serializeGatewayModelCatalog(catalog);
  const managed = options.reuseManagedCurrent ? readManagedGatewayModelCatalog(current, dataDir) : undefined;
  if (managed) return { path: current, before: managed.text, after, existed: true };

  // Protect every original profile pointer too, including a temporarily missing catalog.
  const referenced = new Set([root.model_catalog_json, ...Object.values(root.profiles ?? {}).map((value: any) => value?.model_catalog_json)]
    .filter((value): value is string => typeof value === 'string')
    .map(value => location(path.isAbsolute(value) ? value : path.resolve(dataDir, value))));
  for (let index = 1; index <= 256; index++) {
    const file = path.join(dataDir, index === 1 ? CODEX_API_MODEL_CATALOG_FILE : `codex-api-model-catalog-${index}.json`);
    if (referenced.has(location(file))) continue;
    try { fs.lstatSync(file); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
    return { path: file, before: '', after, existed: false };
  }
  throw new Error('暂时无法为 API 模型目录分配独立位置，原目录保持不变');
}
