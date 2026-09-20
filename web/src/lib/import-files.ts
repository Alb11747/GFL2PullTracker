import type { ImportInput } from './api.ts';
import {
  convertExilium,
  decodeExilium,
  exiliumProfiles,
  validateImportContents,
  type ExiliumProfile
} from './exilium-import.ts';
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export interface ExportFile {
  name: string;
  size: number;
  webkitRelativePath?: string;
  text(): Promise<string>;
}
function document(text: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${name} is not valid JSON. Select the original collector export.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${name} must contain a JSON object.`);
  validateImportContents(parsed);
  return parsed as Record<string, unknown>;
}
function checkSize(files: ExportFile[]): void {
  if (
    files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0) ||
    files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES
  )
    throw new Error('The export exceeds the 64 MiB import limit.');
}
async function readText(file: ExportFile): Promise<string> {
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES)
    throw new Error('The export exceeds the 64 MiB import limit.');
  return text;
}
function boundedResult(result: ImportInput): ImportInput {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_IMPORT_BYTES)
    throw new Error('The encoded export exceeds the 64 MiB import limit.');
  return result;
}
/** Empty for collector exports; source profile selection is separate from destination. */
export async function inspectExiliumProfiles(files: ExportFile[]): Promise<ExiliumProfile[]> {
  checkSize(files);
  if (files.length !== 1) return [];
  const store = await decodeExilium(document(await readText(files[0]), files[0].name));
  return store ? exiliumProfiles(store) : [];
}
/** Raw responses stay as original text; parsing/reserializing loses their representation. */
export async function readExport(
  files: ExportFile[],
  profile_id: string,
  exiliumProfileId?: string
): Promise<ImportInput> {
  if (!profile_id) throw new Error('Choose or create a profile before importing.');
  if (!files.length) throw new Error('Choose an export folder or records.json first.');
  checkSize(files);
  if (files.length === 1) {
    const parsed = document(await readText(files[0]), files[0].name);
    const store = await decodeExilium(parsed);
    return boundedResult({
      profile_id,
      records_document: store ? convertExilium(store, exiliumProfileId) : parsed
    });
  }
  const recordFiles = files.filter((file) => file.name === 'records.json');
  if (recordFiles.length !== 1)
    throw new Error('Select exactly one collector export containing one records.json.');
  const recordFile = recordFiles[0];
  const recordPath = recordFile.webkitRelativePath || recordFile.name;
  const root = recordPath.slice(0, -'records.json'.length);
  const normalized = files.map((file) => {
    const path = file.webkitRelativePath || file.name;
    if (
      path.includes('\\') ||
      path.startsWith('/') ||
      path.includes(':') ||
      path.split('/').some((part) => !part || part === '..' || part === '.')
    )
      throw new Error('The export contains an invalid file path.');
    if (root && !path.startsWith(root))
      throw new Error('Files from different export folders cannot be imported together.');
    return { file, path: root ? path.slice(root.length) : path };
  });
  const seen = new Set<string>();
  for (const { path } of normalized) {
    if (seen.has(path))
      throw new Error('The selection contains duplicate file paths. Choose one export folder.');
    seen.add(path);
    if (
      path !== 'records.json' &&
      path !== 'manifest.json' &&
      !/^(?:raw|responses)\/type_\d+\/page_\d+\.json$/.test(path)
    )
      throw new Error(
        'Choose a single collector export folder. Raw pages need their original raw/type_…/page_….json folder paths.'
      );
  }
  const result: ImportInput = {
    profile_id,
    records_document: document(await readText(recordFile), 'records.json')
  };
  const raw: Record<string, string> = {};
  for (const { file, path } of normalized) {
    if (path === 'manifest.json') result.manifest = document(await readText(file), 'manifest.json');
    else if (path.startsWith('raw/') || path.startsWith('responses/')) {
      const text = await readText(file);
      document(text, path);
      raw[path] = text;
    }
  }
  if (Object.keys(raw).length) result.raw_pages = raw;
  // Escaping raw page text can expand the upload beyond the files' original byte count.
  return boundedResult(result);
}
