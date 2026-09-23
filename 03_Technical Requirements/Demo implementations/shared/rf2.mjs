// Small helpers to stream RF2 release files (tab separated, UTF-8, header row).
// Used by the demos that work directly on the release package the NRC publishes:
//   - the lexicon / description index of the search demo (U01, U02),
//   - the integrity verification after a release deployment (TSP4),
//   - the map import of the analytics demo (S05).

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Find the RF2 file in a Snapshot folder whose name matches `pattern` (RegExp). */
export function findRf2File(snapshotDir, pattern) {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (pattern.test(e.name)) hits.push(p);
    }
  };
  walk(snapshotDir);
  return hits.sort();
}

/**
 * Stream an RF2 file and call `onRow(fields, header)` for every data row.
 * @returns {Promise<number>} number of data rows read
 */
export async function streamRf2(file, onRow) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let header; let n = 0;
  for await (const line of rl) {
    if (!header) { header = line.split('\t'); continue; }
    if (!line) continue;
    onRow(line.split('\t'), header);
    n++;
  }
  return n;
}

export const RF2 = {
  FSN: '900000000000003001',
  SYNONYM: '900000000000013009',
  PREFERRED: '900000000000548007',
  ACCEPTABLE: '900000000000549004',
  IS_A: '116680003',
  INFERRED: '900000000000011006',
  CONCEPT_INACTIVATION_INDICATOR: '900000000000489007',
};

/** Belgian Edition language reference sets (from release_package_information.json of the edition). */
export const BE_LANGUAGE_REFSETS = {
  'nl-BE': { refset: '31000172101', lang: 'nl', label: 'Nederlands (BE)' },
  'fr-BE': { refset: '21000172104', lang: 'fr', label: 'Français (BE)' },
  'de-BE': { refset: '120961000172108', lang: 'de', label: 'Deutsch (BE)' },
  'nl-BE-GP': { refset: '701000172104', lang: 'nl', label: 'Nederlands – huisarts (BE GP)' },
  'fr-BE-GP': { refset: '711000172101', lang: 'fr', label: 'Français – médecin généraliste (BE GP)' },
  'en-US': { refset: '900000000000509007', lang: 'en', label: 'English (US)' },
};
