import type { ImportInput } from './api.ts';
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
  return parsed as Record<string, unknown>;
}
/** Raw responses stay as original text; parsing/reserializing loses their representation. */
export async function readExport(files: ExportFile[], profile_id: string): Promise<ImportInput> {
  if (!profile_id) throw new Error('Choose or create a profile before importing.');
  if (!files.length) throw new Error('Choose an export folder or records.json first.');
  if (files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_BYTES)
    throw new Error('The export exceeds the 64 MiB import limit.');
  const recordFiles = files.filter((file) => file.name === 'records.json');
  if (recordFiles.length !== 1)
    throw new Error('Select exactly one collector export containing one records.json.');
  const recordFile = recordFiles[0];
  const recordPath = recordFile.webkitRelativePath || recordFile.name;
  const root = recordPath.slice(0, -'records.json'.length);
  const normalized = files.map((file) => {
    const path = file.webkitRelativePath || file.name;
    if (path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.'))
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
      !/^raw\/type_\d+\/page_\d+\.json$/.test(path)
    )
      throw new Error(
        'Choose a single collector export folder. Raw pages need their original raw/type_…/page_….json folder paths.'
      );
  }
  const result: ImportInput = {
    profile_id,
    records_document: document(await recordFile.text(), 'records.json')
  };
  const raw: Record<string, string> = {};
  for (const { file, path } of normalized) {
    if (path === 'manifest.json') result.manifest = document(await file.text(), 'manifest.json');
    else if (path.startsWith('raw/')) raw[path] = await file.text();
  }
  if (Object.keys(raw).length) result.raw_pages = raw;
  // Escaping raw page text can expand the upload beyond the files' original byte count.
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_IMPORT_BYTES)
    throw new Error('The encoded export exceeds the 64 MiB import limit.');
  return result;
}
