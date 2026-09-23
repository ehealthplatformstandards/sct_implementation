// Build (or rebuild) the lexicon + Description ID cache used by the search demo (U01, U02).
// Usage: node build-lexicon.mjs <path-to-RF2-Snapshot-folder> [cache-file]
import { buildFromRf2, saveCache } from './lib/lexicon.mjs';
const [snapshot, cache = './data/lexicon-cache.json'] = process.argv.slice(2);
if (!snapshot) { console.error('usage: node build-lexicon.mjs <RF2 Snapshot folder> [cache file]'); process.exit(1); }
const fs = await import('node:fs'); const path = await import('node:path');
fs.mkdirSync(path.dirname(cache), { recursive: true });
const built = await buildFromRf2(snapshot);
saveCache(cache, built);
console.log(`[lexicon] cache written to ${cache} (${(fs.statSync(cache).size / 1e6).toFixed(1)} MB)`);
