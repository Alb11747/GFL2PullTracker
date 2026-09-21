import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

// adapter-node precompresses before the PostHog CLI injects symbol IDs. Rebuild
// both variants from the shipped JavaScript, or browsers receive unmapped code.
let injected = 0;
async function compress(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await compress(path);
    else if (entry.name.endsWith('.js')) {
      const content = await readFile(path);
      // Import/re-export facades and empty chunks have no map or executable frames.
      if (content.includes('_posthogChunkIds')) injected++;
      await writeFile(`${path}.gz`, gzipSync(content));
      await writeFile(`${path}.br`, brotliCompressSync(content));
      count++;
    }
  }
  return count;
}

const count = await compress('build/client');
if (!count) throw new Error('No client JavaScript found for source-map verification.');
if (!injected) throw new Error('No PostHog symbol IDs found in the client build.');
console.log(`Recompressed ${count} JavaScript assets (${injected} with symbol IDs).`);
