// TSP7 - reporting missing or erroneous SNOMED CT content to the Belgian NRC.
//
// The requirement allows two ways; the demo shows both:
//   A. direct: open the official NRC request portal (in the user's language) with a prepared
//      summary the user can paste;
//   B. intermediary: the eHR stores the report and the supplier forwards it to the NRC.
// U05 (free text) is linked to this: recording free text always offers to report the missing concept.

export const NRC_PORTAL = {
  nl: 'https://apps.health.belgium.be/terminology-portal/snomed_ct_requests/nl',
  fr: 'https://apps.health.belgium.be/terminology-portal/snomed_ct_requests/fr',
};

export const FEEDBACK_KINDS = {
  'missing-concept': 'Missing concept',
  'missing-translation': 'Missing or incorrect translation',
  'wrong-concept': 'Erroneous concept / description',
  'mapping': 'Missing or incorrect mapping',
  'other': 'Other',
};

export function portalFor(language) {
  const lang = (language || 'nl').slice(0, 2);
  return lang === 'fr' ? NRC_PORTAL.fr : NRC_PORTAL.nl;
}

/** Text the user can paste in the NRC portal form (or that the supplier forwards). */
export function summary(f, productionVersion, product = 'Demo eHR (example implementation)') {
  return [
    `Type: ${FEEDBACK_KINDS[f.kind] || f.kind}`,
    `Language: ${f.language}`,
    f.search_text ? `Searched for: "${f.search_text}"` : null,
    f.sct_concept_id ? `SNOMED CT concept: ${f.sct_concept_id}` : null,
    f.care_set ? `Data element / care set: ${f.care_set}` : null,
    `Edition: ${productionVersion}`,
    `Reported from: ${product}`,
    f.comment ? `Comment: ${f.comment}` : null,
  ].filter(Boolean).join('\n');
}
