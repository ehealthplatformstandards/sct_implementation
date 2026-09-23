"""Writes the result of a check as JSON + a self-contained HTML page (no external assets).

Python counterpart of ``01-terminology-services/lib/report.mjs``; the pages look the same, so a
report produced by the Python scripts and one produced by the Node scripts can be put side by side.
"""

import datetime
import html as html_mod
import json
import os

DEFAULT_REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'reports')

STYLE = """
body{font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:14px;color:#1f2933;background:#f5f6f8;margin:0}
header{background:#1d4f91;color:#fff;padding:12px 22px}header h1{font-size:18px;margin:0}header .sub{opacity:.85;font-size:12.5px;margin-top:3px}
.disc{background:#fff8d6;border-bottom:1px solid #efe1a0;color:#5c4b00;padding:6px 22px;font-size:12px}
main{padding:16px 22px 40px;max-width:1500px;margin:0 auto}.panel{background:#fff;border:1px solid #dde2e8;border-radius:8px;padding:14px 16px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef1f4;vertical-align:top}
th{background:#f7f8fa;color:#5f6b7a;font-size:12px}.num{text-align:right;white-space:nowrap}.d{color:#5f6b7a;font-size:12px;margin-top:2px}
.rq{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;color:#3b4a5c;margin-top:3px;word-break:break-all}
.st{font-size:11px;font-weight:700;border-radius:4px;padding:1px 6px}.st.pass{background:#e5f4ec;color:#1e7b4a}.st.fail{background:#fdecea;color:#b3261e}.st.warn{background:#fff4e0;color:#9a5b00}.st.info{background:#e8eff9;color:#1d4f91}
.kv{display:grid;grid-template-columns:230px 1fr;gap:4px 12px;font-size:13px}.kv div:nth-child(odd){color:#5f6b7a}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.badge{display:inline-block;font-size:11px;font-weight:700;color:#6b3fa0;background:#f1eafa;border:1px solid #d8c6ef;border-radius:4px;padding:0 5px;margin-right:4px}
.big{font-size:22px;font-weight:700}.ok{color:#1e7b4a}.bad{color:#b3261e}.warnc{color:#9a5b00}
pre{background:#0f1720;color:#d7e2ee;border-radius:6px;padding:10px 12px;font-size:12px;overflow:auto}
"""


def esc(value):
    return html_mod.escape('' if value is None else str(value), quote=True)


def fmt(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return str(value)


def thousands(n):
    try:
        return '{:,}'.format(int(n))
    except (TypeError, ValueError):
        return str(n)


class Report(object):
    """Collects checks and extra HTML blocks, then writes <id>.json and <id>.html."""

    def __init__(self, id, title, requirements, intro=None, report_dir=None, demo='Demo 1'):
        self.id = id
        self.title = title
        self.requirements = requirements
        self.intro = intro
        self.demo = demo
        self.report_dir = report_dir or DEFAULT_REPORT_DIR
        self.started = datetime.datetime.now(datetime.timezone.utc)
        self.meta = {}
        self.checks = []
        self.blocks = []

    def check(self, name, status, req=None, detail=None, expected=None, actual=None,
              ms=None, request=None):
        """Record one check. status: 'pass' | 'fail' | 'warn' | 'info'."""
        self.checks.append({'req': req, 'name': name, 'detail': detail, 'expected': expected,
                            'actual': actual, 'status': status, 'ms': ms, 'request': request})
        icon = {'pass': 'PASS', 'fail': 'FAIL', 'warn': 'WARN', 'info': 'INFO'}.get(status, status)
        tail = '' if actual is None else ' -> %s' % fmt(actual)
        print('  [%s] %s%s%s' % (icon, (req + ' ') if req else '', name, tail))
        return status in ('pass', 'info')

    def block(self, title, html):
        """Extra HTML block (trusted markup produced by the scripts themselves)."""
        self.blocks.append({'title': title, 'html': html})

    @property
    def ok(self):
        return all(c['status'] != 'fail' for c in self.checks)

    def write(self):
        os.makedirs(self.report_dir, exist_ok=True)
        finished = datetime.datetime.now(datetime.timezone.utc)
        summary = {'pass': 0, 'fail': 0, 'warn': 0, 'info': 0}
        for c in self.checks:
            summary[c['status']] = summary.get(c['status'], 0) + 1
        data = {
            'id': self.id, 'title': self.title, 'requirements': self.requirements,
            'started': self.started.isoformat(), 'finished': finished.isoformat(),
            'generator': 'python', 'meta': self.meta, 'summary': summary, 'ok': self.ok,
            'checks': self.checks, 'blocks': [b['title'] for b in self.blocks],
        }
        with open(os.path.join(self.report_dir, self.id + '.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

        rows = []
        for c in self.checks:
            detail = '<div class="d">%s</div>' % esc(c['detail']) if c['detail'] else ''
            request = '<div class="rq">%s</div>' % esc(c['request']) if c['request'] else ''
            ms = '%s ms' % c['ms'] if c['ms'] is not None else ''
            rows.append('<tr class="{s}"><td><span class="st {s}">{S}</span></td><td>{req}</td>'
                        '<td><b>{name}</b>{detail}{request}</td><td>{exp}</td><td>{act}</td>'
                        '<td class="num">{ms}</td></tr>'.format(
                            s=c['status'], S=c['status'].upper(), req=esc(c['req'] or ''),
                            name=esc(c['name']), detail=detail, request=request,
                            exp=esc(fmt(c['expected'])), act=esc(fmt(c['actual'])), ms=ms))

        seconds = int(round((finished - self.started).total_seconds()))
        badges = ''.join('<span class="badge" style="background:#fff">%s</span>' % esc(r)
                         for r in self.requirements)
        meta_html = ''.join('<div>%s</div><div class="mono">%s</div>' % (esc(k), esc(fmt(v)))
                            for k, v in self.meta.items())
        blocks_html = '\n'.join('<section class="panel"><h2>%s</h2>%s</section>' % (esc(b['title']), b['html'])
                                for b in self.blocks)
        html = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{title}</title>
<style>{style}</style></head><body>
<header><h1>{title}</h1><div class="sub">{badges} {demo} (Python) &middot; run {started} UTC &middot; {seconds} s</div></header>
<div class="disc">Example implementation for discussion - not a normative test suite. SNOMED CT content: SNOMED CT Belgian Edition, &copy; SNOMED International.</div>
<main>
<section class="panel"><div class="kv">{meta}
<div>Result</div><div class="big {cls}">{verdict} <span style="font-size:13px;font-weight:400;color:#5f6b7a">{p} pass &middot; {f} fail &middot; {w} warning &middot; {i} info</span></div></div>
{intro}</section>
{blocks}
<section class="panel"><h2>Checks</h2><table><tr><th>Status</th><th>Req.</th><th>Check</th><th>Expected</th><th>Actual</th><th>Time</th></tr>{rows}</table></section>
</main></body></html>""".format(
            title=esc(self.title), style=STYLE, badges=badges, demo=esc(self.demo),
            started=esc(self.started.strftime('%Y-%m-%d %H:%M:%S')), seconds=seconds,
            meta=meta_html, cls='ok' if self.ok else 'bad', verdict='PASS' if self.ok else 'FAIL',
            p=summary['pass'], f=summary['fail'], w=summary['warn'], i=summary['info'],
            intro='<p style="font-size:13px;color:#3b4a5c">%s</p>' % self.intro if self.intro else '',
            blocks=blocks_html, rows='\n'.join(rows))

        path = os.path.join(self.report_dir, self.id + '.html')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        write_index(self.report_dir)
        print('\n%s - report written to %s' % ('PASS' if self.ok else 'FAIL', path))
        return path


def write_index(report_dir=None):
    """reports/index.html lists every report that has been produced."""
    report_dir = report_dir or DEFAULT_REPORT_DIR
    items = []
    for name in sorted(os.listdir(report_dir)):
        if name.endswith('.json'):
            with open(os.path.join(report_dir, name), encoding='utf-8') as f:
                items.append(json.load(f))
    items.sort(key=lambda i: i.get('id') or '')
    rows = ''.join(
        '<tr><td><a href="{id}.html">{title}</a></td><td>{req}</td>'
        '<td class="{cls}">{verdict}</td><td>{run}</td></tr>'.format(
            id=esc(i['id']), title=esc(i['title']), req=esc(', '.join(i.get('requirements') or [])),
            cls='ok' if i.get('ok') else 'bad', verdict='PASS' if i.get('ok') else 'FAIL',
            run=esc(str(i.get('started'))[:19].replace('T', ' ')))
        for i in items)
    html = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Python check reports</title>
<style>body{{font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:14px;margin:0;background:#f5f6f8;color:#1f2933}}
header{{background:#1d4f91;color:#fff;padding:12px 22px}}main{{padding:16px 22px;max-width:1100px}}
table{{border-collapse:collapse;width:100%;background:#fff}}th,td{{padding:8px 10px;border-bottom:1px solid #eef1f4;text-align:left}}
th{{background:#f7f8fa;color:#5f6b7a;font-size:12px}}.ok{{color:#1e7b4a;font-weight:700}}.bad{{color:#b3261e;font-weight:700}}</style></head><body>
<header><b>Demo 1 &middot; Terminology services &amp; release management - Python reports</b></header>
<main><p>Example checks against a FHIR terminology server, run with the scripts in <code>python/</code>
(standard library only). Re-run them to refresh.</p>
<table><tr><th>Report</th><th>Requirements</th><th>Result</th><th>Run</th></tr>{rows}</table></main></body></html>""".format(rows=rows)
    with open(os.path.join(report_dir, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
