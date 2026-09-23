// Reusable SNOMED CT search & select component (Demo 2).
//   U01 progressive matching (min. characters + debounce), response-time measurement, query rewrites,
//       multi-prefix any-order search, context subset first with optional extension to the binding
//   U02 Concept ID / Description ID       U04 only concepts of the binding are offered
//   U06 the term the user selected is kept S03 inactive concepts are never offered

import { h, api, req, highlight, config, lang } from './common.js';

export class ConceptPicker {
  /**
   * @param {HTMLElement} root
   * @param {object} o  { careSet, context, compact, placeholder, onSelect(item), onDetails(code), onTrace(trace), onTiming(ms), onFreeText(text), onResults(r) }
   */
  constructor(root, o) {
    this.root = root; this.o = o; this.seq = 0; this.timer = null; this.items = []; this.focus = -1; this.extend = false;
    this.input = h('input.search-input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: o.placeholder || `Type at least ${config.minChars} characters, or a Concept ID / Description ID`, oninput: () => this.onInput(), onkeydown: (e) => this.onKey(e) });
    if (o.compact) this.input.classList.remove('search-input');
    this.info = h('div.timing');
    this.rewrites = h('div.small');
    this.out = h('div');
    root.replaceChildren(this.input, this.info, this.rewrites, this.out);
  }

  setCareSet(careSet, context) { this.o.careSet = careSet; this.o.context = context; this.extend = false; this.clear(); }
  setContext(context) { this.o.context = context; this.extend = false; if (this.input.value) this.run(performance.now()); }
  clear() { this.input.value = ''; this.out.replaceChildren(); this.info.replaceChildren(); this.rewrites.replaceChildren(); this.items = []; }

  onInput() {
    const t0 = performance.now(); // U01: the measured time starts at the keystroke and includes the debounce
    clearTimeout(this.timer);
    this.extend = false;
    const text = this.input.value.trim();
    if (!/^\d+$/.test(text) && text.replace(/\s+/g, '').length < config.minChars) {
      this.out.replaceChildren(text ? h('div.muted.small', `Type at least ${config.minChars} characters…`, req('U01')) : '');
      this.info.replaceChildren(); this.rewrites.replaceChildren();
      return;
    }
    this.timer = setTimeout(() => this.run(t0), config.debounceMs);
  }

  async run(t0) {
    const my = ++this.seq;
    const params = new URLSearchParams({ text: this.input.value.trim(), careSet: this.o.careSet, lang: lang(), extend: String(this.extend) });
    if (this.o.context) params.set('context', this.o.context);
    let r;
    try { r = await api(`/api/search?${params}`); } catch (e) { this.out.replaceChildren(h('div.chip.bad', e.message)); return; }
    if (my !== this.seq) return; // a newer search is running
    this.render(r);
    const ms = Math.round(performance.now() - t0);
    this.info.replaceChildren(
      h('span', 'Results shown after ', h('b', `${ms} ms`), ` (incl. ${config.debounceMs} ms debounce; server ${r.serverMs} ms)`), req('U01'),
    );
    this.o.onTiming?.(ms, r);
    this.o.onTrace?.(r.trace || []);
    this.o.onResults?.(r);
  }

  render(r) {
    this.items = []; this.focus = -1;
    const rw = r.analysis?.rewrites || [];
    this.rewrites.replaceChildren(...(rw.length ? [h('span.muted', 'Also searched: '), ...rw.map((x) => h('span.chip.warn', `${label(x.type)}: ${x.from} → ${x.to}`)), req('U01')] : []));
    if (r.message) { this.out.replaceChildren(h('div.chip.bad', r.message), req('U02')); return; }
    const blocks = [];
    for (const s of r.sections) {
      const title = s.id === 'context' ? `Context subset: ${s.label}` : s.id === 'id' ? s.label : 'Other concepts permitted by the binding';
      const sec = h('div', h('div.section-title', h('span', title, s.id === 'context' ? req('U01') : s.id === 'id' ? req('U02') : req('U01', 'U04')),
        h('span', s.id !== 'id' ? `${s.items.length}${s.total !== undefined ? ` shown · ${s.total} typed matches` : ''}` : '', s.autoExtended ? ' · extended automatically (few matches in the subset)' : '')));
      if (!s.items.length) sec.append(h('div.result.muted', { style: { cursor: 'default' } }, 'No matches'));
      for (const it of s.items) {
        const idx = this.items.length; this.items.push(it);
        const selectable = it.selectable !== false;
        sec.append(h(`div.result${selectable ? '' : '.disabled'}`, { onclick: () => selectable && this.select(it), onmouseenter: () => this.setFocus(idx), 'data-idx': idx },
          h('div',
            h('div.term', { html: highlight(it.term, r.query || '') }),
            h('div.sub', it.term !== it.pt ? `PT: ${it.pt} · ` : '', it.semanticTag ? `${it.semanticTag} · ` : '', h('span.mono', it.code),
              (it.via || []).filter((v) => v !== 'typed').map((v) => h('span.chip.warn', { style: { marginLeft: '6px' } }, `via ${label(v)}`)),
              !selectable ? h('span.chip.bad', { style: { marginLeft: '6px' } }, it.reason) : null)),
          h('div.actions', this.o.onDetails ? h('button.secondary', { title: 'Show hierarchy & details (U03)', onclick: (e) => { e.stopPropagation(); this.o.onDetails(it.code); } }, 'ⓘ') : null,
            this.o.onFavourite && selectable ? h('button.secondary', { title: 'Add to favourites (U07)', onclick: (e) => { e.stopPropagation(); this.o.onFavourite(it); } }, '★') : null)));
      }
      blocks.push(sec);
    }
    const foot = [];
    if (r.canExtend && !r.extended) foot.push(h('button.secondary', { onclick: () => { this.extend = true; this.run(performance.now()); } }, 'Search all concepts permitted by the binding'), req('U01'));
    if (!r.context && r.mode === 'text') foot.push(h('span.muted.small', `Search limited to the binding of ${r.careSet.label}: ${r.careSet.binding.source}.`), req('U04'));
    if (this.o.onFreeText && r.mode === 'text') foot.push(h('button.link', { onclick: () => this.o.onFreeText(this.input.value.trim()) }, 'No suitable concept? Record as free text and report it'), req('U05', 'TSP7'));
    this.out.replaceChildren(h('div.results', blocks), h('div.row', { style: { marginTop: '8px' } }, foot));
  }

  setFocus(i) {
    this.focus = i;
    this.out.querySelectorAll('.result').forEach((el) => el.classList.toggle('focus', Number(el.dataset.idx) === i));
  }

  onKey(e) {
    if (!this.items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.setFocus(Math.min(this.focus + 1, this.items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); this.setFocus(Math.max(this.focus - 1, 0)); }
    if (e.key === 'Enter' && this.focus >= 0) { e.preventDefault(); const it = this.items[this.focus]; if (it.selectable !== false) this.select(it); }
  }

  select(it) {
    // U06: keep exactly the term that was presented and selected
    this.o.onSelect?.({ code: it.code, term: it.term, pt: it.pt, semanticTag: it.semanticTag, via: it.via });
  }
}

function label(v) {
  return { variant: 'plural/feminine form', decompound: 'decompounding', typo: 'spelling correction', fuzzy: 'fuzzy match', 'Concept ID': 'Concept ID', 'Description ID': 'Description ID' }[v] || v;
}
