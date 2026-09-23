// SNOMED CT identifier helpers (SCTID).
//
// An SCTID is a 6-18 digit integer whose last digit is a Verhoeff check digit and whose
// second- and third-last digits form the "partition identifier":
//   00 / 10 = concept, 01 / 11 = description, 02 / 12 = relationship
// (x0 = short format, x1 = long format with namespace). See the SNOMED CT Technical
// Implementation Guide, section "SCTID data type".
//
// Used by U02 (search by Concept ID / Description ID) so that a typed number is only treated
// as an identifier when it is structurally valid.

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** True when the full string (including its last digit) passes the Verhoeff check. */
export function verhoeffValid(num) {
  let c = 0;
  const digits = String(num).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

/**
 * Classify a string as an SCTID.
 * @returns {{valid:boolean, kind?:'concept'|'description'|'relationship', format?:'short'|'long', reason?:string}}
 */
export function classifySctid(text) {
  const s = String(text || '').trim();
  if (!/^\d{6,18}$/.test(s)) return { valid: false, reason: 'not a 6-18 digit number' };
  if (s.startsWith('0')) return { valid: false, reason: 'leading zero' };
  if (!verhoeffValid(s)) return { valid: false, reason: 'Verhoeff check digit mismatch' };
  const partition = s.slice(-3, -1);
  const map = {
    '00': ['concept', 'short'], '01': ['description', 'short'], '02': ['relationship', 'short'],
    '10': ['concept', 'long'], '11': ['description', 'long'], '12': ['relationship', 'long'],
  };
  const hit = map[partition];
  if (!hit) return { valid: false, reason: `unknown partition identifier ${partition}` };
  return { valid: true, kind: hit[0], format: hit[1], namespace: hit[1] === 'long' ? s.slice(-10, -3) : null };
}

export const isConceptId = (s) => classifySctid(s).kind === 'concept';
export const isDescriptionId = (s) => classifySctid(s).kind === 'description';
