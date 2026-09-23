"""TSP7 - reporting missing or erroneous SNOMED CT content to the Belgian NRC.

Python counterpart of ``ehr-demo-app/lib/feedback.mjs``. The requirement allows two ways; the demo
shows both:
    A. direct: open the official NRC request portal (in the user's language) with a prepared
       summary the user can paste;
    B. intermediary: the eHR stores the report and the supplier forwards it to the NRC.
U05 (free text) is linked to this: recording free text always offers to report the missing concept.
"""

NRC_PORTAL = {
    'nl': 'https://apps.health.belgium.be/terminology-portal/snomed_ct_requests/nl',
    'fr': 'https://apps.health.belgium.be/terminology-portal/snomed_ct_requests/fr',
}

FEEDBACK_KINDS = {
    'missing-concept': 'Missing concept',
    'missing-translation': 'Missing or incorrect translation',
    'wrong-concept': 'Erroneous concept / description',
    'mapping': 'Missing or incorrect mapping',
    'other': 'Other',
}


def portal_for(language):
    return NRC_PORTAL['fr'] if (language or 'nl')[:2] == 'fr' else NRC_PORTAL['nl']


def summary(f, production_version, product='Demo eHR (example implementation)'):
    """Text the user can paste in the NRC portal form (or that the supplier forwards)."""
    lines = [
        'Type: %s' % (FEEDBACK_KINDS.get(f.get('kind')) or f.get('kind')),
        'Language: %s' % f.get('language'),
        'Searched for: "%s"' % f['search_text'] if f.get('search_text') else None,
        'SNOMED CT concept: %s' % f['sct_concept_id'] if f.get('sct_concept_id') else None,
        'Data element / care set: %s' % f['care_set'] if f.get('care_set') else None,
        'Edition: %s' % production_version,
        'Reported from: %s' % product,
        'Comment: %s' % f['comment'] if f.get('comment') else None,
    ]
    return '\n'.join(x for x in lines if x)
