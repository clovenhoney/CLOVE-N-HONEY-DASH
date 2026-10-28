/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
/* ---------------- Xero helpers (accounting adapter) ---------------- */
const XERO_WAGE_RE = /wages|salaries|superannuation|\bsuper\b|payroll|annual leave|long service|workcover/i;
function xeroNum(v) { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
function xeroRound(n) { return Math.round(n * 100) / 100; }
function xeroSectionKind(title) {
  const t = String(title || '').toLowerCase();
  if (/other income|plus other|other revenue/.test(t)) return null;
  if (/cost of (sales|goods)|direct cost/.test(t)) return 'cogs';
  if (/operating expense|overhead/.test(t) || /^(less )?expenses$/.test(t.trim())) return 'opex';
  if (/income|revenue|sales|trading/.test(t)) return 'income';
  return null;
}
const XERO_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/* Column header -> 'YYYY-MM'. Reads the month name and year as written ('Oct 2026',
   'Oct-26', '31 Oct 26'), so it never depends on the runtime's timezone. */
function xeroMonthKey(label) {
  const m = /([A-Za-z]{3})[A-Za-z]*\.?[\s\-]+(\d{4}|\d{2})\b/.exec(String(label || ''));
  if (m && XERO_MONTHS[m[1].toLowerCase()]) {
    const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return y + '-' + String(XERO_MONTHS[m[1].toLowerCase()]).padStart(2, '0');
  }
  return null;
}
/* Parse a Xero P&L report JSON into one column object per period. */
function xeroParsePnl(rep) {
  const r = rep && rep.Reports && rep.Reports[0];
  const rows = (r && r.Rows) || [];
  const header = rows.find(function (x) { return x.RowType === 'Header'; });
  const labels = header && header.Cells ? header.Cells.slice(1).map(function (c) { return c.Value; }) : [null];
  const cols = labels.map(function (l) {
    return { month: xeroMonthKey(l), revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 };
  });
  const wageAccounts = {}; const otherSections = [];
  rows.forEach(function (sec) {
    if (sec.RowType !== 'Section' || !sec.Title) return;
    const kind = xeroSectionKind(sec.Title);
    if (!kind) { otherSections.push(sec.Title); return; }
    (sec.Rows || []).forEach(function (row) {
      if (row.RowType !== 'Row' || !row.Cells) return;
      const label = String(row.Cells[0].Value || '');
      cols.forEach(function (col, i) {
        const v = xeroNum(row.Cells[i + 1] && row.Cells[i + 1].Value);
        if (kind === 'income') col.revenue += v;
        else if (kind === 'cogs') col.cogs += v;
        else if (XERO_WAGE_RE.test(label)) { col.wagesSuper += v; wageAccounts[label] = true; }
        else col.overheads += v;
      });
    });
  });
  cols.forEach(function (c) {
    c.revenue = xeroRound(c.revenue); c.cogs = xeroRound(c.cogs);
    c.wagesSuper = xeroRound(c.wagesSuper); c.overheads = xeroRound(c.overheads);
  });
  return { cols: cols, wageAccounts: Object.keys(wageAccounts), otherSections: otherSections };
}
async function xeroTenant(env, h) {
  const t = await h.getTokens();
  const stamp = (t && t.obtained_at) || '';
  const raw = await env.TOKENS.get('xerotenant');
  if (raw) { try { const c = JSON.parse(raw); if (c && c.id && c.stamp === stamp) return c; } catch (e) {} }
  const list = await h.fetchJson('https://api.xero.com/connections', { headers: { 'Accept': 'application/json' } });
  const first = Array.isArray(list) ? list[0] : null;
  if (!first || !first.tenantId) { const e = new Error('no organisation'); e.status = 403; throw e; }
  const c = { id: first.tenantId, name: first.tenantName || '', stamp: stamp };
  await env.TOKENS.put('xerotenant', JSON.stringify(c));
  return c;
}
/* ---------------- Locations (Clove n Honey: two cafes, shown separately) ----------------
   Each location is matched by name: Xero tracking option name and Square location
   name must contain the match text. key is what the page sends as ?loc=. */
const LOCATIONS = [
  /* In Square the Stones Corner location is named just "CLOVE N HONEY" (owner confirmed) */
  { key: 'stones-corner', name: 'Stones Corner', match: /stones/i, square: /stones|^\s*clove\s*(n|and|&)\s*honey\s*$/i },
  { key: 'ormeau', name: 'Ormeau', match: /ormeau/i }
];
function findLocation(key) {
  for (let i = 0; i < LOCATIONS.length; i++) if (LOCATIONS[i].key === key) return LOCATIONS[i];
  return null;
}
function locationError(plain) { const e = new Error('location: ' + plain); e.plain = plain; e.status = 0; return e; }

/* Active Xero tracking categories with their options (cached an hour per connection). */
async function xeroTracking(env, h) {
  const org = await xeroTenant(env, h);
  const key = 'xerotracking:' + org.id + ':' + org.stamp;
  const raw = await env.TOKENS.get(key);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  const res = await h.fetchJson('https://api.xero.com/api.xro/2.0/TrackingCategories', {
    headers: { 'Xero-Tenant-Id': org.id, 'Accept': 'application/json' }
  });
  const cats = (res.TrackingCategories || [])
    .filter(function (c) { return !c.Status || c.Status === 'ACTIVE'; })
    .map(function (c) {
      return { id: c.TrackingCategoryID, name: c.Name || '',
               options: (c.Options || []).filter(function (o) { return !o.Status || o.Status === 'ACTIVE'; })
                 .map(function (o) { return { id: o.TrackingOptionID, name: o.Name || '' }; }) };
    });
  try { await env.TOKENS.put(key, JSON.stringify(cats), { expirationTtl: 3600 }); } catch (e) {}
  return cats;
}
/* P&L filter params for one location: the tracking category whose options cover
   the most locations (ties go to one named like 'Location'), then its matching option. */
async function xeroLocationParams(env, h, loc) {
  const cats = await xeroTracking(env, h);
  let best = null, bestScore = 0;
  cats.forEach(function (c) {
    let score = LOCATIONS.filter(function (l) { return c.options.some(function (o) { return l.match.test(o.name); }); }).length * 2;
    if (score && /location|site|venue|store|branch|shop|cafe/i.test(c.name)) score += 1;
    if (score > bestScore) { best = c; bestScore = score; }
  });
  if (!best) throw locationError('Xero has no tracking category with options named ' + LOCATIONS.map(function (l) { return l.name; }).join(' / ') + '. Check Settings > Tracking categories in Xero.');
  const opt = best.options.find(function (o) { return loc.match.test(o.name); });
  if (!opt) throw locationError('Xero tracking category "' + best.name + '" has no option for ' + loc.name + '.');
  return { trackingCategoryID: best.id, trackingOptionID: opt.id };
}

async function xeroPnl(h, tenantId, params) {
  const p = new URLSearchParams(Object.assign({ standardLayout: 'true', paymentsOnly: 'false' }, params));
  return h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + p.toString(), {
    headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' }
  });
}
function xeroLastDay(month) { /* 'YYYY-MM' -> 'YYYY-MM-DD' */
  const parts = month.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1], 0));
  return month + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/* ---------------- Square helpers (POS adapter: transaction COUNT only) ---------------- */
const SQUARE_BASE = 'https://connect.squareup.com';
const SQUARE_VERSION = '2024-10-17';
function posHeaders(env) {
  return { 'Authorization': 'Bearer ' + (env.POS_API_TOKEN || ''), 'Square-Version': SQUARE_VERSION,
           'Content-Type': 'application/json', 'Accept': 'application/json' };
}
function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
/* Local wall-clock 'YYYY-MM-DD' + hours in a timezone -> UTC ISO string. */
function zonedToUtcIso(dateStr, tz, hours) {
  const a = dateStr.split('-').map(Number);
  const guess = Date.UTC(a[0], a[1] - 1, a[2], hours || 0, 0, 0);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  return new Date(ms).toISOString();
}
function addDaysStr(s, n) {
  const a = s.split('-').map(Number);
  return new Date(Date.UTC(a[0], a[1] - 1, a[2] + n)).toISOString().slice(0, 10);
}
/* Business name + active locations (cached an hour per token). */
async function posInfo(env, h) {
  const tok = String(env.POS_API_TOKEN || '');
  const key = 'posinfo:' + tok.slice(-8);
  const raw = await env.TOKENS.get(key);
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  const hdr = { headers: posHeaders(env) };
  const locs = await h.fetchJson(SQUARE_BASE + '/v2/locations', hdr);
  let name = '';
  try { const m = await h.fetchJson(SQUARE_BASE + '/v2/merchants/me', hdr); name = (m.merchant && m.merchant.business_name) || ''; } catch (e) {}
  let list = (locs.locations || []).filter(function (l) { return l.status === 'ACTIVE'; })
    .map(function (l) { return { id: l.id, name: l.name }; });
  const only = String(env.POS_LOCATION_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (only.length) list = list.filter(function (l) { return only.indexOf(l.id) >= 0; });
  const info = { name: name, locations: list.slice(0, 10) };
  await env.TOKENS.put(key, JSON.stringify(info), { expirationTtl: 3600 });
  return info;
}
/* Square locations for one venue location key (all active ones when no key). */
function posLocationsFor(info, locKey) {
  const loc = locKey ? findLocation(locKey) : null;
  if (!loc) return info.locations;
  const re = loc.square || loc.match;
  const locs = info.locations.filter(function (l) { return re.test(l.name || ''); });
  if (!locs.length) throw locationError('Square has no location with "' + loc.name + '" in its name. Your Square locations are: '
    + (info.locations.map(function (l) { return l.name; }).join(', ') || 'none') + '.');
  return locs;
}
/* Count completed orders (voids/cancels excluded by state) in a local date range.
   Built to fit Cloudflare's FREE plan (10 ms CPU, 50 subrequests per request):
   - asks Square for order IDs only (return_entries) and counts them by scanning
     the response text, never parsing whole orders;
   - counts each Square location separately, so a cafe's cached counts are reused
     by the "Both cafes" view;
   - shares one page budget per request (budget.left); when it runs out the
     position is saved in KV and the next load carries on from there;
   - settled past periods are cached for 30 days. */
function budgetError() { const e = new Error('budget'); e.status = 429; e.budget = true; return e; }
async function posCountOne(env, locId, q, budget) {
  const hours = +q.rollover || 0;
  const key = 'poscnt1:' + [q.from, q.to, q.tz, hours, locId].join('|');
  const cached = await env.TOKENS.get(key);
  if (cached !== null && cached !== undefined) { const n = parseInt(cached, 10); if (!isNaN(n)) return n; }
  const body = {
    location_ids: [locId], limit: 1000, return_entries: true,
    query: { filter: { state_filter: { states: ['COMPLETED'] },
                       date_time_filter: { closed_at: { start_at: zonedToUtcIso(q.from, q.tz, hours),
                                                        end_at: zonedToUtcIso(addDaysStr(q.to, 1), q.tz, hours) } } },
             sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' } }
  };
  let count = 0, cursor = null;
  const progKey = 'posprog:' + key.slice(8);
  const prog = await env.TOKENS.get(progKey);
  if (prog) { try { const p = JSON.parse(prog); count = p.count || 0; cursor = p.cursor || null; } catch (e) {} }
  let first = true;
  while (first || cursor) {
    first = false;
    if (budget.left <= 0) {
      try { await env.TOKENS.put(progKey, JSON.stringify({ count: count, cursor: cursor }), { expirationTtl: 3600 }); } catch (e) {}
      throw budgetError();
    }
    budget.left--;
    const res = await fetch(SQUARE_BASE + '/v2/orders/search', {
      method: 'POST', headers: posHeaders(env), body: JSON.stringify(cursor ? Object.assign({}, body, { cursor: cursor }) : body)
    });
    if (!res.ok) {
      if (cursor && res.status === 400) { /* saved position expired: start this range again next load */
        try { await env.TOKENS.delete(progKey); } catch (e) {}
        throw budgetError();
      }
      const e = new Error('HTTP ' + res.status); e.status = res.status; throw e;
    }
    const text = await res.text();
    let i = 0;
    while ((i = text.indexOf('"order_id"', i)) !== -1) { count++; i += 10; }
    const c = /"cursor"\s*:\s*"([^"]+)"/.exec(text.slice(Math.max(0, text.lastIndexOf('"cursor"') - 1)));
    cursor = (text.lastIndexOf('"cursor"') !== -1 && c) ? c[1] : null;
  }
  try { await env.TOKENS.delete(progKey); } catch (e) {}
  const today = new Date().toISOString().slice(0, 10);
  const settled = q.to < addDaysStr(today, -3); /* allow a few days for offline-mode sales to arrive */
  try { await env.TOKENS.put(key, String(count), { expirationTtl: settled ? 30 * 86400 : 300 }); } catch (e) {}
  return count;
}
async function posCount(env, h, q, budget) {
  const info = await posInfo(env, h);
  if (!info.locations.length) { const e = new Error('no locations'); e.status = 403; throw e; }
  const locs = posLocationsFor(info, q.loc);
  let total = 0;
  for (let i = 0; i < locs.length; i++) total += await posCountOne(env, locs[i].id, q, budget);
  return total;
}

const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read accounting.settings.read', /* settings.read: tracking categories, for the per-location split */
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },
    async status(env, h) {
      const t = await h.getTokens();
      if (!t || !t.access_token) return { connected: false };
      const org = await xeroTenant(env, h);
      return { connected: true, org: org.name, sandbox: /demo company/i.test(org.name || '') };
    },
    async fetchRange(env, h, q) {
      const org = await xeroTenant(env, h);
      const loc = q.loc ? findLocation(q.loc) : null;
      const track = loc ? await xeroLocationParams(env, h, loc) : {};
      const rep = await xeroPnl(h, org.id, Object.assign({ fromDate: q.from, toDate: q.to }, track));
      const p = xeroParsePnl(rep);
      const c = p.cols[0] || { revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 };
      return {
        revenue: c.revenue, cogs: c.cogs, wagesSuper: c.wagesSuper, overheads: c.overheads,
        wageAccounts: p.wageAccounts, otherSections: p.otherSections
      };
    },
    async fetchMonthly(env, h, q) {
      const org = await xeroTenant(env, h);
      const loc = q.loc ? findLocation(q.loc) : null;
      const track = loc ? await xeroLocationParams(env, h, loc) : {};
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: months, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      const idx = {}; months.forEach(function (m, i) {
        idx[m] = i; out.revenue.push(null); out.cogs.push(null); out.wagesSuper.push(null); out.overheads.push(null);
      });
      for (let i = 0; i < months.length; i += 12) {
        const chunk = months.slice(i, i + 12);
        /* Xero's periods param counts comparison periods (1-11 here); a single-month chunk sends none */
        const params = { fromDate: chunk[chunk.length - 1] + '-01', toDate: xeroLastDay(chunk[chunk.length - 1]) };
        if (chunk.length > 1) { params.periods = String(chunk.length - 1); params.timeframe = 'MONTH'; }
        const rep = await xeroPnl(h, org.id, Object.assign(params, track));
        const p = xeroParsePnl(rep);
        p.cols.forEach(function (c, k) {
          const key = c.month || chunk[chunk.length - 1 - k]; /* Xero lists the latest period first */
          if (idx[key] === undefined) return;
          out.revenue[idx[key]] = c.revenue; out.cogs[idx[key]] = c.cogs;
          out.wagesSuper[idx[key]] = c.wagesSuper; out.overheads[idx[key]] = c.overheads;
        });
      }
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.POS_API_TOKEN) return { connected: false };
      const info = await posInfo(env, h);
      const names = info.locations.map(function (l) { return l.name; }).join(', ');
      return { connected: true, org: (info.name ? info.name + ' - ' : '') + names, sandbox: false };
    },
    async fetchRange(env, h, q) {
      const n = await posCount(env, h, { from: q.from, to: q.to, tz: q.tz, rollover: q.rollover, loc: q.loc }, q.posBudget || { left: 30 });
      return { count: n };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: months, count: months.map(function () { return null; }) };
      const budget = q.posBudget || { left: 30 };
      /* newest first, several months at once (each month is its own Square query) */
      const order = months.map(function (m, i) { return i; }).reverse();
      for (let b = 0; b < order.length; b += 6) {
        const batch = order.slice(b, b + 6);
        let ranOut = false;
        await Promise.all(batch.map(async function (i) {
          try {
            out.count[i] = await posCount(env, h, { from: months[i] + '-01', to: xeroLastDay(months[i]), tz: q.tz, rollover: q.rollover, loc: q.loc }, budget);
          } catch (e) { if (e && e.budget) { ranOut = true; if (q.posBudget) q.posBudget.pending = true; return; } throw e; }
        }));
        if (ranOut) break;
      }
      return out;
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    let recent = null;
    try {
      const d = await env.TOKENS.get('diag:' + source);
      if (d) { const j = JSON.parse(d); if (j && Date.now() - j.at < 3600000) recent = j; }
    } catch (e) {}
    return {
      configured: true,
      auth: adapter.auth || null,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: recent ? { code: recent.code, plain: (/^location: /.test(recent.msg || '') ? recent.msg.slice(10)
        : plainError(recent.code || 500) + ' [' + (recent.code || '') + ' ' + recent.msg + ']') } : null
    };
  } catch (err) {
    return {
      configured: true,
      auth: adapter.auth || null,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
      try { await env.TOKENS.delete('diag:' + source); } catch (e) {}
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
      if (err && err.budget) { if (q.posBudget) q.posBudget.pending = true; continue; } /* still counting: not an error */
      try {
        await env.TOKENS.put('diag:' + source, JSON.stringify({ at: Date.now(), code: err.status || 0, msg: String((err && err.message) || '').slice(0, 300) }), { expirationTtl: 3600 });
      } catch (e) {}
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const location = findLocation(url.searchParams.get('loc') || '');
  /* Square pages this request may fetch: keeps the whole request under the free
     plan's 50-subrequest cap (Xero uses ~8). Unfinished counts resume next load. */
  const posBudget = { left: Math.max(1, parseInt(env.POS_PAGE_BUDGET || '30', 10) || 30), pending: false };
  const base = { tz, rollover, loc: location ? location.key : null, posBudget: posBudget };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover, base.loc || 'all'
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    const slots = await Promise.all([
      fetchSlot(env, { ...base, ...cur }),
      prev ? fetchSlot(env, { ...base, ...prev }) : null,
      yoy ? fetchSlot(env, { ...base, ...yoy }) : null
    ]);
    periods.cur = slots[0]; periods.prev = slots[1]; periods.yoy = slots[2];

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut, posPending: posBudget.pending };
    if (env.TOKENS && !posBudget.pending) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    locations: LOCATIONS.map(function (l) { return { key: l.key, name: l.name }; }),
    location: base.loc || 'all',
    posPending: !!data.posPending,
    locationIssues: location ? await locationIssues(env, location, sAcc, sPos) : [],
    periods: data.periods,
    trend: data.trend
  });
}

/* Plain-English reasons a location's figures can't be split out (e.g. no matching
   Xero tracking option or Square location name). Connection problems are already
   reported per source, so only location-matching problems are listed here. */
async function locationIssues(env, loc, sAcc, sPos) {
  const out = [];
  if (ADAPTERS.accounting.configured && sAcc && sAcc.connected) {
    try { await xeroLocationParams(env, makeHelpers(env, 'accounting'), loc); }
    catch (e) {
      if (e && e.plain) out.push(e.plain);
      else if (e && (e.status === 401 || e.status === 403)) out.push('Xero needs one more read-only permission to split figures by location. Open Connections and click Reconnect on Xero.');
    }
  }
  if (ADAPTERS.pos.configured && sPos && sPos.connected) {
    try { posLocationsFor(await posInfo(env, makeHelpers(env, 'pos')), loc.key); }
    catch (e) { if (e && e.plain) out.push(e.plain); }
  }
  return out;
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
