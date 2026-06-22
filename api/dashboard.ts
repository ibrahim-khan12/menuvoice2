// GET /api/dashboard?key=...   ->  live, auto-refreshing visual analytics dashboard
//
// A command center for "what is everyone doing right now". Reads the same `events`
// table as /api/report and /api/morning (written by api/events.ts) and serves:
//   - an HTML shell (default) that polls the JSON mode every 30s and re-renders in
//     place, so the page stays current without a manual reload, and
//   - format=json: the same numbers as raw JSON (what the shell polls; also handy
//     for piping into other tools).
//
// Costs zero AI tokens — plain server SQL, current on every request.
//
// Access: guarded by REPORT_KEY (same key as /api/report + /api/morning). Set it in
// Vercel (Project -> Settings -> Env Vars), then open
//   https://<deployment>/api/dashboard?key=<REPORT_KEY>
//
// Query params:
//   hours=24    window length in hours (default 24). days= is accepted too.
//   days=7      convenience alias; days=7 -> hours=168
//   format=json raw JSON instead of the HTML shell

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@vercel/postgres';

// Self-contained on purpose: this endpoint depends only on @vercel/postgres (the
// same surface as the working /api/report). It deliberately does NOT import
// ./_morningData — doing so pulls that module's whole dependency graph into load,
// which has crashed view endpoints (FUNCTION_INVOCATION_FAILED). The three helpers
// below mirror _morningData's excludeList()/withClient()/esc() so all three views
// stay consistent; keep the exclusion default in sync if it changes there.

async function withClient<T>(fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function esc(v: unknown): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Internal/test accounts to hide. Mirrors _morningData.excludeList() so
// /api/report, /api/morning, and /api/dashboard agree.
function excludeList(): string[] {
  const raw = process.env.REPORT_EXCLUDE_EMAILS ?? '';
  return raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.REPORT_KEY?.trim();
  const provided = (req.query.key as string) ?? '';
  const format = (req.query.format as string) ?? 'html';

  if (!expected) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(
      `<!doctype html><meta charset="utf-8"><h1>Dashboard not configured</h1>` +
      `<p>Set a <code>REPORT_KEY</code> environment variable in Vercel, then open ` +
      `<code>/api/dashboard?key=YOUR_KEY</code>.</p>`
    );
  }
  if (provided !== expected) {
    // The HTML shell polls JSON; answer both modes with a matching 401.
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(
      `<!doctype html><meta charset="utf-8"><h1>Unauthorized</h1>` +
      `<p>Append <code>?key=YOUR_KEY</code> to the URL.</p>`
    );
  }

  // Window: hours= wins; else days= * 24; else default 24h. Clamp to a year.
  const hoursRaw = Number(req.query.hours);
  const daysRaw = Number(req.query.days);
  let hours = 24;
  if (Number.isFinite(hoursRaw) && hoursRaw > 0) hours = hoursRaw;
  else if (Number.isFinite(daysRaw) && daysRaw > 0) hours = daysRaw * 24;
  hours = Math.min(Math.round(hours), 24 * 365);

  // The HTML shell renders once and then fetches JSON itself — serve it cheaply
  // without touching the DB.
  if (format !== 'json') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(shell(provided));
  }

  // ---- JSON (the live data the shell polls) ----
  const w = `now() - interval '${hours} hours'`;        // window start
  const prevStart = `now() - interval '${hours * 2} hours'`; // previous equal window start
  // Bucket the activity chart by hour for short windows, by day for long ones.
  const bucketUnit = hours <= 72 ? 'hour' : 'day';
  const bucketStep = bucketUnit === 'hour' ? '1 hour' : '1 day';

  // Internal/test accounts (own testing) are excluded everywhere so the dashboard
  // reflects real usage and agrees with the morning report. $1 = lower-cased email
  // array; anonymous events (NULL email) always pass. Parameterized = injection-safe.
  const exclude = excludeList();
  const keep = `(user_email IS NULL OR lower(user_email) <> ALL($1::text[]))`;
  const keepE = `(e.user_email IS NULL OR lower(e.user_email) <> ALL($1::text[]))`;
  const keepSignedIn = `user_email IS NOT NULL AND lower(user_email) <> ALL($1::text[])`;

  try {
    const data = await withClient(async (client) => {
      const [headline, prev, series, funnel, screens, topEvents, users, recent, failures] =
        await Promise.all([
          client.query(`
            SELECT
              count(*)                                                          AS events,
              count(DISTINCT session_id)                                        AS sessions,
              count(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL)  AS users,
              count(DISTINCT session_id) FILTER (WHERE user_email IS NULL)      AS anon_sessions,
              count(*) FILTER (WHERE outcome='failure')                         AS failures,
              min(ts) AS first_ts, max(ts) AS last_ts
            FROM events WHERE ts > ${w} AND ${keep}
          `, [exclude]),
          client.query(`
            SELECT
              count(*)                                                          AS events,
              count(DISTINCT session_id)                                        AS sessions,
              count(DISTINCT user_email) FILTER (WHERE user_email IS NOT NULL)  AS users,
              count(DISTINCT session_id) FILTER (WHERE user_email IS NULL)      AS anon_sessions,
              count(*) FILTER (WHERE outcome='failure')                         AS failures
            FROM events WHERE ts > ${prevStart} AND ts <= ${w} AND ${keep}
          `, [exclude]),
          client.query(`
            WITH buckets AS (
              SELECT generate_series(
                date_trunc('${bucketUnit}', ${w}),
                date_trunc('${bucketUnit}', now()),
                interval '${bucketStep}'
              ) AS bucket
            )
            SELECT b.bucket AS bucket,
                   count(e.id)                                       AS events,
                   count(DISTINCT e.session_id)                      AS sessions,
                   count(e.id) FILTER (WHERE e.outcome='failure')    AS failures
            FROM buckets b
            LEFT JOIN events e
              ON date_trunc('${bucketUnit}', e.ts) = b.bucket AND e.ts > ${w} AND ${keepE}
            GROUP BY b.bucket
            ORDER BY b.bucket
          `, [exclude]),
          client.query(`
            SELECT
              count(*) FILTER (WHERE event_name='camera_start')                          AS camera,
              count(*) FILTER (WHERE event_name='photo_added')                           AS photo,
              count(*) FILTER (WHERE event_name='analyze_start')                         AS analyze,
              count(*) FILTER (WHERE event_name='ocr_result' AND outcome='success')      AS ocr_ok,
              count(*) FILTER (WHERE event_name='user_utterance')                        AS asked,
              count(*) FILTER (WHERE event_name='llm_reply')                             AS replied
            FROM events WHERE ts > ${w} AND ${keep}
          `, [exclude]),
          client.query(`
            SELECT coalesce(screen,'(none)') AS screen,
                   count(*) AS n,
                   count(DISTINCT session_id) AS sessions,
                   count(*) FILTER (WHERE outcome='failure') AS failures
            FROM events WHERE ts > ${w} AND ${keep}
            GROUP BY screen ORDER BY n DESC LIMIT 12
          `, [exclude]),
          client.query(`
            SELECT event_type, event_name,
                   count(*) AS n,
                   count(*) FILTER (WHERE outcome='failure') AS failures,
                   round(avg(duration_ms)) AS avg_ms
            FROM events WHERE ts > ${w} AND ${keep}
            GROUP BY event_type, event_name ORDER BY n DESC LIMIT 20
          `, [exclude]),
          client.query(`
            WITH win AS (
              SELECT user_email,
                     count(*)                                              AS events,
                     count(DISTINCT session_id)                            AS sessions,
                     count(*) FILTER (WHERE event_name='photo_added')      AS photos,
                     count(*) FILTER (WHERE event_name='user_utterance')   AS asks,
                     count(*) FILTER (WHERE event_name='llm_reply')        AS replies,
                     count(*) FILTER (WHERE outcome='failure')             AS failures,
                     max(ts)                                               AS last_seen,
                     array_agg(DISTINCT screen) FILTER (WHERE screen IS NOT NULL) AS screens
              FROM events WHERE ${keepSignedIn} AND ts > ${w}
              GROUP BY user_email
            ),
            life AS (
              SELECT user_email, min(ts) AS first_ts, count(DISTINCT session_id) AS lifetime_sessions
              FROM events WHERE ${keepSignedIn} GROUP BY user_email
            )
            SELECT win.*, life.first_ts, life.lifetime_sessions,
                   (life.first_ts > ${w}) AS is_new
            FROM win JOIN life USING (user_email)
            ORDER BY win.last_seen DESC LIMIT 100
          `, [exclude]),
          client.query(`
            SELECT ts, coalesce(user_email,'(anon)') AS user_email, screen,
                   event_type, event_name, outcome, duration_ms, session_id
            FROM events WHERE ts > ${w} AND ${keep}
            ORDER BY ts DESC LIMIT 50
          `, [exclude]),
          client.query(`
            SELECT ts, coalesce(user_email,'(anon)') AS user_email, screen,
                   event_name, session_id, content
            FROM events WHERE outcome='failure' AND ts > ${w} AND ${keep}
            ORDER BY ts DESC LIMIT 30
          `, [exclude]),
        ]);

      return {
        headline: headline.rows[0],
        prev: prev.rows[0],
        series: series.rows,
        funnel: funnel.rows[0],
        screens: screens.rows,
        topEvents: topEvents.rows,
        users: users.rows,
        recent: recent.rows,
        failures: failures.rows.map((r) => ({
          ...r,
          // Pre-stringify content so the client can show a compact detail snippet.
          detail: (() => {
            try { return JSON.stringify(r.content); } catch { return ''; }
          })(),
          content: undefined,
        })),
      };
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      window_hours: hours,
      bucket_unit: bucketUnit,
      generated: new Date().toISOString(),
      ...data,
    });
  } catch (err) {
    console.error('[dashboard] error:', err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(500).json({ ok: false, error: (err as Error).message });
  }
}

// The HTML shell. Rendered once; all numbers are filled in by client-side JS that
// polls ?format=json. Keeping rendering on the client is what lets the page stay
// live (poll + re-render) without reloading.
function shell(key: string): string {
  const k = esc(key);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MenuVoice live dashboard</title>
<style>
  :root { color-scheme: light dark; --good:#1e8449; --bad:#c0392b; --accent:#2563eb; --muted:rgba(128,128,128,.5); }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.25rem; max-width: 1200px; }
  h1 { font-size: 1.5rem; margin: 0 0 .15rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; border-bottom: 2px solid currentColor; padding-bottom: .2rem; }
  .topbar { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem 1rem; }
  .meta { opacity: .7; font-size: .85rem; }
  .nav { margin: .75rem 0; display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
  .nav a { text-decoration: none; padding: .25rem .6rem; border: 1px solid var(--muted); border-radius: 999px; font-size: .85rem; color: inherit; }
  .nav a.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .nav .sep { opacity: .5; }
  .dot { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; background: var(--good); margin-right: .35rem; vertical-align: middle; }
  .dot.stale { background: #d68910; }
  .cards { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .5rem; }
  .card { border: 1px solid var(--muted); border-radius: 12px; padding: .7rem .9rem; min-width: 120px; flex: 1 0 120px; }
  .card .num { font-size: 1.7rem; font-weight: 700; line-height: 1.1; }
  .card .lbl { font-size: .72rem; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .delta { font-size: .8rem; font-weight: 600; }
  .delta.up { color: var(--good); }
  .delta.down { color: var(--bad); }
  .delta.flat { opacity: .55; }
  table { border-collapse: collapse; width: 100%; margin-top: .4rem; font-size: .86rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid rgba(128,128,128,.25); }
  th { position: sticky; top: 0; background: Canvas; font-size: .78rem; }
  td.r, th.r { text-align: right; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
  .small { font-size: .75rem; opacity: .8; }
  .bad { color: var(--bad); font-weight: 600; }
  .good { color: var(--good); }
  .pill { font-size: .7rem; padding: .05rem .4rem; border-radius: 999px; border: 1px solid var(--muted); }
  .pill.new { background: var(--good); color: #fff; border-color: var(--good); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 760px){ .grid2 { grid-template-columns: 1fr; } }
  .bars { display: flex; flex-direction: column; gap: .3rem; margin-top: .4rem; }
  .barrow { display: grid; grid-template-columns: 9rem 1fr 3rem; align-items: center; gap: .5rem; font-size: .82rem; }
  .barrow .track { background: rgba(128,128,128,.18); border-radius: 5px; height: 1.1rem; overflow: hidden; }
  .barrow .fill { background: var(--accent); height: 100%; border-radius: 5px; }
  .barrow .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .barrow .val { text-align: right; font-variant-numeric: tabular-nums; }
  .funnel .fill { background: var(--good); }
  .err { color: var(--bad); }
  svg.chart { width: 100%; height: 160px; display: block; margin-top: .4rem; }
  .chart .bar { fill: var(--accent); }
  .chart .barfail { fill: var(--bad); }
  .chart .axis { stroke: var(--muted); stroke-width: 1; }
  .chart text { fill: currentColor; font-size: 10px; opacity: .7; }
  .empty { opacity: .65; font-style: italic; padding: .5rem 0; }
  #err { color: var(--bad); font-weight: 600; }
</style>
</head>
<body>
<div class="topbar">
  <h1>MenuVoice live dashboard</h1>
  <span class="meta"><span id="dot" class="dot"></span><span id="status">loading…</span></span>
</div>
<nav class="nav" id="nav" aria-label="Time window">
  <span>Window:</span>
  <a data-h="1">1 h</a>
  <a data-h="6">6 h</a>
  <a data-h="24">24 h</a>
  <a data-h="168">7 d</a>
  <a data-h="720">30 d</a>
  <a data-h="87600">All</a>
  <span class="sep">·</span>
  <a href="/api/morning?key=${k}">morning</a>
  <a href="/api/report?key=${k}">report</a>
</nav>
<p id="err"></p>

<div class="cards" id="cards"></div>

<h2>Activity over time</h2>
<div id="chart" role="img" aria-label="Activity over time"></div>

<div class="grid2">
  <div>
    <h2>Usage funnel</h2>
    <div class="bars funnel" id="funnel"></div>
  </div>
  <div>
    <h2>Top screens</h2>
    <div class="bars" id="screens"></div>
  </div>
</div>

<h2>People (who did what)</h2>
<div id="users"></div>

<h2>Top events</h2>
<div id="events"></div>

<div class="grid2">
  <div>
    <h2>Live event stream</h2>
    <div id="recent"></div>
  </div>
  <div>
    <h2>Failures</h2>
    <div id="failures"></div>
  </div>
</div>

<script>
const KEY = ${JSON.stringify(key)};
const REFRESH_MS = 30000;
let hours = 24;
let lastFetch = 0;
let timer = null;

// ---- helpers ----
const $ = (id) => document.getElementById(id);
const esc = (v) => v==null ? '' : String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function fmtMs(ms){ const n=Number(ms); if(!isFinite(n)) return ''; if(n<1000) return n+' ms'; const s=n/1000; if(s<60) return s.toFixed(1)+' s'; const m=Math.floor(s/60); return m+'m '+Math.round(s%60)+'s'; }
function fmtTs(ts){ if(!ts) return ''; const d=new Date(ts); if(isNaN(d)) return ''; return d.toISOString().replace('T',' ').slice(5,16); }
function ago(ts){ if(!ts) return ''; const t=new Date(ts).getTime(); if(isNaN(t)) return ''; const s=Math.floor((Date.now()-t)/1000); if(s<60) return s+'s ago'; const m=Math.floor(s/60); if(m<60) return m+'m ago'; const h=Math.floor(m/60); if(h<24) return h+'h ago'; return Math.floor(h/24)+'d ago'; }
function num(n){ return Number(n||0).toLocaleString(); }

function delta(cur, prev){
  cur=Number(cur||0); prev=Number(prev||0);
  if(prev===0 && cur===0) return '<span class="delta flat">–</span>';
  if(prev===0) return '<span class="delta up">new</span>';
  const pct = Math.round((cur-prev)/prev*100);
  if(pct===0) return '<span class="delta flat">0%</span>';
  const cls = pct>0 ? 'up' : 'down';
  const arrow = pct>0 ? '▲' : '▼';
  return '<span class="delta '+cls+'">'+arrow+' '+Math.abs(pct)+'%</span>';
}

function barRow(label, value, max, extra){
  const pct = max>0 ? Math.round(value/max*100) : 0;
  return '<div class="barrow"><span class="lab" title="'+esc(label)+'">'+esc(label)+'</span>'+
    '<span class="track"><span class="fill" style="width:'+pct+'%"></span></span>'+
    '<span class="val">'+num(value)+(extra||'')+'</span></div>';
}

// ---- renderers ----
function renderCards(d){
  const h=d.headline||{}, p=d.prev||{};
  const defs=[
    ['Events','events'],['Sessions','sessions'],['Signed-in users','users'],
    ['Anon sessions','anon_sessions'],['Failures','failures'],
  ];
  $('cards').innerHTML = defs.map(([lbl,key])=>{
    const isFail = key==='failures';
    return '<div class="card"><div class="num '+(isFail&&Number(h[key])>0?'bad':'')+'">'+num(h[key])+'</div>'+
      '<div class="lbl">'+lbl+'</div>'+delta(h[key],p[key])+'</div>';
  }).join('');
}

function renderChart(d){
  const s=d.series||[];
  const box=$('chart');
  if(!s.length){ box.innerHTML='<p class="empty">No activity in this window.</p>'; return; }
  const W=1000, H=160, padB=18, padT=6;
  const max=Math.max(1, ...s.map(r=>Number(r.events)));
  const bw=W/s.length;
  let bars='';
  s.forEach((r,i)=>{
    const ev=Number(r.events), fl=Number(r.failures);
    const x=i*bw, gap=Math.min(2,bw*0.15);
    const evH=(ev/max)*(H-padB-padT);
    const flH=(fl/max)*(H-padB-padT);
    const okH=evH-flH;
    if(okH>0) bars+='<rect class="bar" x="'+(x+gap).toFixed(1)+'" y="'+(H-padB-evH).toFixed(1)+'" width="'+(bw-gap*2).toFixed(1)+'" height="'+okH.toFixed(1)+'"><title>'+esc(fmtTs(r.bucket))+': '+ev+' events</title></rect>';
    if(flH>0) bars+='<rect class="barfail" x="'+(x+gap).toFixed(1)+'" y="'+(H-padB-flH).toFixed(1)+'" width="'+(bw-gap*2).toFixed(1)+'" height="'+flH.toFixed(1)+'"><title>'+esc(fmtTs(r.bucket))+': '+fl+' failures</title></rect>';
  });
  // sparse x labels: first, middle, last
  const idxs=[0, Math.floor(s.length/2), s.length-1];
  let labels='';
  idxs.forEach(i=>{ if(s[i]) labels+='<text x="'+(i*bw+bw/2).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle">'+esc(fmtTs(s[i].bucket))+'</text>'; });
  const peak=s.reduce((a,b)=>Number(b.events)>Number(a.events)?b:a,s[0]);
  box.setAttribute('aria-label','Activity over time. Peak '+peak.events+' events around '+fmtTs(peak.bucket)+'.');
  box.innerHTML='<svg class="chart" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<line class="axis" x1="0" y1="'+(H-padB)+'" x2="'+W+'" y2="'+(H-padB)+'"/>'+bars+labels+'</svg>'+
    '<p class="small">Bars = events per '+esc(d.bucket_unit)+'; red = failures. Peak '+num(peak.events)+' @ '+esc(fmtTs(peak.bucket))+'.</p>';
}

function renderFunnel(d){
  const f=d.funnel||{};
  const steps=[
    ['Camera opened','camera'],['Photo captured','photo'],['Analyze tapped','analyze'],
    ['Menu read (OCR)','ocr_ok'],['Asked a question','asked'],['Got an answer','replied'],
  ];
  const max=Math.max(1, ...steps.map(([,k])=>Number(f[k])));
  let prev=null;
  $('funnel').innerHTML = steps.map(([lbl,k])=>{
    const v=Number(f[k]||0);
    let extra='';
    if(prev!==null && prev>0) extra=' <span class="small">('+Math.round(v/prev*100)+'%)</span>';
    prev=v;
    return barRow(lbl, v, max, extra);
  }).join('') || '<p class="empty">No funnel activity.</p>';
}

function renderScreens(d){
  const s=d.screens||[];
  if(!s.length){ $('screens').innerHTML='<p class="empty">No screen activity.</p>'; return; }
  const max=Math.max(1,...s.map(r=>Number(r.n)));
  $('screens').innerHTML = s.map(r=>{
    const fail = Number(r.failures)>0 ? ' <span class="bad small">'+r.failures+'✗</span>' : '';
    return barRow(r.screen, Number(r.n), max, fail);
  }).join('');
}

function renderUsers(d){
  const u=d.users||[];
  if(!u.length){ $('users').innerHTML='<p class="empty">No signed-in users in this window.</p>'; return; }
  const rows=u.map(r=>'<tr>'+
    '<td>'+esc(r.user_email)+(r.is_new?' <span class="pill new">NEW</span>':'')+'</td>'+
    '<td class="r">'+num(r.sessions)+'</td>'+
    '<td class="r">'+num(r.events)+'</td>'+
    '<td class="r">'+num(r.photos)+'</td>'+
    '<td class="r">'+num(r.asks)+'</td>'+
    '<td class="r '+(Number(r.failures)>0?'bad':'')+'">'+num(r.failures)+'</td>'+
    '<td class="r">'+num(r.lifetime_sessions)+'</td>'+
    '<td class="small">'+esc(ago(r.last_seen))+'</td>'+
    '<td class="small">'+esc((r.screens||[]).join(', '))+'</td>'+
    '</tr>').join('');
  $('users').innerHTML='<table><thead><tr><th>User</th><th class="r">Sess</th><th class="r">Events</th>'+
    '<th class="r">Photos</th><th class="r">Asks</th><th class="r">Fail</th><th class="r">Lifetime</th>'+
    '<th>Last seen</th><th>Screens</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderEvents(d){
  const e=d.topEvents||[];
  if(!e.length){ $('events').innerHTML='<p class="empty">No events.</p>'; return; }
  const rows=e.map(r=>'<tr>'+
    '<td class="small">'+esc(r.event_type)+'</td>'+
    '<td>'+esc(r.event_name)+'</td>'+
    '<td class="r">'+num(r.n)+'</td>'+
    '<td class="r '+(Number(r.failures)>0?'bad':'')+'">'+num(r.failures)+'</td>'+
    '<td class="r small">'+(r.avg_ms!=null?fmtMs(r.avg_ms):'')+'</td>'+
    '</tr>').join('');
  $('events').innerHTML='<table><thead><tr><th>Type</th><th>Event</th><th class="r">Count</th>'+
    '<th class="r">Fail</th><th class="r">Avg</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderRecent(d){
  const e=d.recent||[];
  if(!e.length){ $('recent').innerHTML='<p class="empty">Nothing yet.</p>'; return; }
  const rows=e.map(r=>{
    const oc = r.outcome==='failure'?'bad':r.outcome==='success'?'good':'';
    return '<tr><td class="small">'+esc(fmtTs(r.ts))+'</td>'+
      '<td class="small">'+esc(r.user_email)+'</td>'+
      '<td class="small">'+esc(r.screen||'')+'</td>'+
      '<td>'+esc(r.event_name)+'</td>'+
      '<td class="'+oc+' small">'+esc(r.outcome||'')+'</td></tr>';
  }).join('');
  $('recent').innerHTML='<table><thead><tr><th>When</th><th>User</th><th>Screen</th><th>Event</th><th>Out</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderFailures(d){
  const e=d.failures||[];
  if(!e.length){ $('failures').innerHTML='<p class="empty good">No failures in this window.</p>'; return; }
  const rows=e.map(r=>'<tr><td class="small">'+esc(fmtTs(r.ts))+'</td>'+
    '<td class="small">'+esc(r.user_email)+'</td>'+
    '<td>'+esc(r.event_name)+'</td>'+
    '<td class="mono small">'+esc((r.detail||'').slice(0,120))+'</td></tr>').join('');
  $('failures').innerHTML='<table><thead><tr><th>When</th><th>User</th><th>Event</th><th>Detail</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function setStatus(ok, generated){
  const dot=$('dot');
  if(ok){
    dot.className='dot';
    $('status').textContent='live · updated '+ago(generated)+' · window '+labelFor(hours);
  } else {
    dot.className='dot stale';
  }
}
function labelFor(h){ if(h>=87600) return 'all time'; if(h>=720&&h%720===0) return (h/720)+'mo'; if(h%24===0) return (h/24)+'d'; return h+'h'; }

function markNav(){
  document.querySelectorAll('#nav a[data-h]').forEach(a=>{
    a.classList.toggle('on', Number(a.dataset.h)===hours);
    a.href='?key='+encodeURIComponent(KEY)+'&hours='+a.dataset.h;
  });
}

async function load(){
  try{
    const r=await fetch('/api/dashboard?format=json&key='+encodeURIComponent(KEY)+'&hours='+hours,{cache:'no-store'});
    if(!r.ok){ throw new Error('HTTP '+r.status); }
    const d=await r.json();
    if(!d.ok){ throw new Error(d.error||'error'); }
    $('err').textContent='';
    renderCards(d); renderChart(d); renderFunnel(d); renderScreens(d);
    renderUsers(d); renderEvents(d); renderRecent(d); renderFailures(d);
    lastFetch=Date.now();
    setStatus(true, d.generated);
  }catch(e){
    $('err').textContent='Update failed: '+e.message+' (retrying)';
    $('dot').className='dot stale';
  }
}

function tick(){ if(!document.hidden) load(); }

// window switch (no reload): intercept data-h links
document.getElementById('nav').addEventListener('click',(e)=>{
  const a=e.target.closest('a[data-h]'); if(!a) return;
  e.preventDefault();
  hours=Number(a.dataset.h);
  history.replaceState(null,'', '?key='+encodeURIComponent(KEY)+'&hours='+hours);
  markNav(); load();
});

// keep the "updated Ns ago" label honest between polls
setInterval(()=>{ if(lastFetch) $('status').textContent='live · updated '+ago(new Date(lastFetch).toISOString())+' · window '+labelFor(hours); },5000);

// initial window from URL
(()=>{ const u=new URL(location.href); const h=Number(u.searchParams.get('hours')); if(isFinite(h)&&h>0) hours=Math.round(h); })();
markNav();
load();
timer=setInterval(tick, REFRESH_MS);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) load(); });
</script>
</body>
</html>`;
}
