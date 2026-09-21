import { MAX_COMPRESSED_BYTES } from './local/limits.ts';

/** Inspect bytes before routing: a renamed backup still belongs to archive restoration. */
export async function classifyImportFiles(
  files: File[],
  hosted: boolean,
  decode?: (bytes: Uint8Array) => Promise<unknown>
): Promise<'export' | 'backup'> {
  if (!files.length) throw new Error('Choose an export or compressed tracker backup first.');
  const compressed = await Promise.all(
    files.map(async (file) => {
      const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      return header[0] === 0x1f && header[1] === 0x8b;
    })
  );
  if (!compressed.some(Boolean)) return 'export';
  if (files.length !== 1)
    throw new Error(
      'Choose one tracker backup by itself. Backups cannot be combined with exports or other backups.'
    );
  if (!hosted)
    throw new Error(
      'Compressed tracker backups can only be restored in the browser-local tracker. Open the hosted tracker to restore this archive.'
    );
  if (files[0].size > MAX_COMPRESSED_BYTES)
    throw new Error('This archive exceeds the 16 MiB compressed limit.');
  // The application supplies its worker decoder; standalone callers load it only
  // after identifying a backup, so ordinary browsing never imports the engine.
  const decodeBackup = decode ?? (await import('./local/backup.ts')).decodeBackup;
  await decodeBackup(new Uint8Array(await files[0].arrayBuffer()));
  return 'backup';
}
