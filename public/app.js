/* ============ DashKee — Keeta personal dashboard frontend ============ */
'use strict';

const $ = (id) => document.getElementById(id);
const LS_KEY = 'keetascan.accounts.v2';

/* ---------- formatting ---------- */
const fmt = {
  usd(n, d = 2) {
    if (n == null || Number.isNaN(n)) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  usdAuto(n) {
    if (n == null) return '—';
    const d = n !== 0 && Math.abs(n) < 1 ? 4 : 2;
    return fmt.usd(n, d);
  },
  compact(n, d = 2) {
    if (n == null || Number.isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(d) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(d) + 'M';
    if (abs >= 1e3 && d >= 0 && Number.isInteger(n)) return n.toLocaleString('en-US');
    return n.toLocaleString('en-US', { maximumFractionDigits: Math.min(8, d) });
  },
  pct(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; },
  short(s, a = 10, b = 6) {
    if (s == null) return '—';
    return s.length <= a + b + 1 ? s : s.slice(0, a) + '…' + s.slice(-b);
  },
  ago(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '—';
    if (ms < 0) return 'now';
    if (ms < 60_000) return Math.max(1, Math.round(ms / 1000)) + 's ago';
    if (ms < 3_600_000) return Math.round(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return Math.round(ms / 3_600_000) + 'h ago';
    return Math.round(ms / 86_400_000) + 'd ago';
  },
  date(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
};

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- state ---------- */
const state = {
  accounts: [],      // [{address,label,source}] from localStorage
  lookups: null,     // {accounts:[...]} from /api/lookup
  storage: null,     // {storageAccounts, byOwner}
  activity: null,    // {blocks}
  market: null,
  tab: 'overview',
};
const saved = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
};
const persist = () => localStorage.setItem(LS_KEY, JSON.stringify(state.accounts));

const ACCENT = ['#7aa2f7', '#0db9d7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#ff9e64', '#73daca', '#c0caf5', '#89ddff'];

/* ---------- tabs ---------- */
document.querySelectorAll('#tabs button').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab))
);
document.querySelectorAll('[data-goto]').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.goto))
);
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.add('hidden'));
  $('tab-' + tab).classList.remove('hidden');
  if (tab === 'network') startNetworkPolling();
  else stopNetworkPolling();
  if (tab === 'assets') renderHistory();
}

/* ---------- connect modal ---------- */
const modal = $('connect-modal');
$('connect-btn').onclick = () => modal.classList.remove('hidden');
$('connect-close').onclick = () => modal.classList.add('hidden');
$('empty-connect').onclick = () => modal.classList.remove('hidden');
$('add-account-btn').onclick = () => modal.classList.remove('hidden');
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

/* watch addresses */
$('watch-save').onclick = () => {
  const addrs = $('watch-input').value.split(/[\s,]+/).filter(Boolean);
  const valid = addrs.filter((a) => a.startsWith('keeta_'));
  if (!valid.length) return toast('Paste at least one address starting with keeta_');
  for (const a of valid) {
    if (!state.accounts.some((x) => x.address === a)) {
      state.accounts.push({ address: a, label: 'Watched address', source: 'watch' });
    }
  }
  persist();
  $('watch-input').value = '';
  modal.classList.add('hidden');
  toast(`Added ${valid.length} address${valid.length > 1 ? 'es' : ''}`);
  refreshPortfolio();
};

/* seed derivation — client-side only */
$('seed-derive').onclick = async () => {
  const seed = $('seed-input').value.trim().replace(/\s+/g, '');
  const range = parseInt($('seed-range').value, 10);
  if (!/^[0-9a-fA-F]{64}$/.test(seed)) return toast('Seed must be 64 hex characters');
  $('seed-derive').disabled = true;
  $('seed-derive').textContent = 'Deriving…';
  try {
    const derived = [];
    for (let i = 0; i < range; i++) {
      const acct = KeetaNet.lib.Account.fromSeed(seed, i);
      derived.push({ index: i, address: acct.publicKeyString.get() });
    }
    // Check which exist on-chain (only addresses sent to the server)
    const { accounts } = await getJSON('/api/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: derived.map((d) => d.address) }),
    });
    const exists = new Map(accounts.filter((a) => a.exists).map((a) => [a.address, a]));
    const list = $('seed-list');
    list.innerHTML = derived.map((d) => {
      const on = exists.get(d.address);
      const bal = on?.totalUsd != null ? fmt.usdAuto(on.totalUsd) : '';
      return `<label class="seed-item ${on ? 'exists' : ''}">
        <input type="checkbox" value="${d.address}" ${on ? 'checked' : ''} />
        <span class="mono">#${d.index}</span>
        <span class="mono addr">${fmt.short(d.address, 12, 6)}</span>
        <span class="right">${on ? (on.name ? on.name : 'active') + (bal ? ' · ' + bal : '') : '<span class="muted">empty</span>'}</span>
      </label>`;
    }).join('');
    $('seed-results').classList.remove('hidden');
  } catch (e) {
    toast('Derivation failed: ' + e.message, 4000);
  } finally {
    $('seed-derive').disabled = false;
    $('seed-derive').textContent = 'Derive subaccounts';
  }
};

$('seed-save').onclick = () => {
  const picked = [...$('seed-list').querySelectorAll('input:checked')].map((i) => i.value);
  if (!picked.length) return toast('Select at least one subaccount');
  for (const a of picked) {
    if (!state.accounts.some((x) => x.address === a)) {
      const idx = $('seed-list').querySelector(`input[value="${a}"]`)?.closest('.seed-item')?.querySelector('.mono')?.textContent || '#?';
      state.accounts.push({ address: a, label: 'Subaccount ' + idx.replace('#', ''), source: 'seed' });
    }
  }
  persist();
  modal.classList.add('hidden');
  $('seed-results').classList.add('hidden');
  $('seed-input').value = '';
  toast('Saved ' + picked.length + ' account' + (picked.length > 1 ? 's' : ''));
  refreshPortfolio();
};

/* ---------- charts ---------- */
const charts = {};
function chart(id) {
  if (!charts[id]) {
    charts[id] = echarts.init($(id), null, { renderer: 'canvas' });
    new ResizeObserver(() => charts[id].resize()).observe($(id));
  }
  return charts[id];
}
const C = { text: '#9aa5ce', grid: '#3b4261' };
const axisCommon = {
  axisLine: { lineStyle: { color: C.grid } },
  axisLabel: { color: C.text, fontSize: 10.5, fontFamily: 'JetBrains Mono, Menlo, monospace' },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: 'rgba(59, 66, 97, 0.45)' } },
};
const tooltipCommon = {
  backgroundColor: '#2f344d', borderColor: '#4a5075', borderWidth: 1,
  textStyle: { color: '#eaf0ff', fontSize: 12 },
  extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.4); border-radius:10px;',
};
function areaSeries(data, color, name) {
  return {
    name, type: 'line', smooth: 0.35, symbol: 'none', data,
    lineStyle: { width: 2.5, color }, itemStyle: { color },
    areaStyle: {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: color + '33' }, { offset: 1, color: color + '03' },
      ]),
    },
  };
}

/* ---------- portfolio refresh ---------- */
let refreshing = false;
async function refreshPortfolio() {
  const addrs = state.accounts.map((a) => a.address);
  if (!addrs.length) {
    $('empty-state').classList.remove('hidden');
    $('dashboard').classList.add('hidden');
    return;
  }
  $('empty-state').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  if (refreshing) return;
  refreshing = true;
  try {
    const [lookup, owned, activity] = await Promise.all([
      getJSON('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: addrs }) }),
      getJSON('/api/owned', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: addrs }) }).catch(() => null),
      getJSON('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: addrs }) }).catch(() => null),
    ]);
    state.lookups = lookup;
    state.storage = owned;
    state.activity = activity;
    renderAll();
    recordSnapshot();
  } catch (e) {
    toast('Portfolio refresh failed: ' + e.message, 4000);
  } finally {
    refreshing = false;
  }
}

/* ---------- renderers ---------- */
function labelFor(addr, i) {
  const saved = state.accounts.find((a) => a.address === addr);
  if (saved?.label) return saved.label;
  return 'Account ' + (i + 1);
}

function allAssets() {
  // aggregate balances across all accounts (incl. storage accounts)
  const accounts = [...(state.lookups?.accounts || []), ...(state.storage?.storageAccounts || [])];  const byToken = new Map();
  for (const acc of accounts) {
    for (const b of acc.balances || []) {
      if (b.amount === 0) continue;
      const cur = byToken.get(b.address) || { ...b, amount: 0, value: 0, holders: [] };
      cur.amount += b.amount;
      cur.value = cur.price != null ? cur.amount * cur.price : null;
      cur.holders.push({ address: acc.address, amount: b.amount, name: acc.name, type: acc.type });
      byToken.set(b.address, cur);
    }
  }
  return [...byToken.values()].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}

function renderAll() {
  renderOverview();
  renderAccounts();
  renderAssets();
  renderActivity();
}

function assetIcon(asset, cls = 'asset-ico') {
  if (asset.logo) return `<img class="${cls}" src="${asset.logo}" alt="" />`;
  const letter = (asset.name || '?').slice(0, 1);
  const color = asset.isKta ? 'kta-bg' : asset.known && !asset.isKta ? 'usd-bg' : '';
  return `<span class="${cls} ${color}">${letter}</span>`;
}

function renderOverview() {
  const walletAccs = state.lookups?.accounts || [];
  const activeStorage = (state.storage?.storageAccounts || []).filter((s) => (s.balances || []).some((b) => b.amount !== 0) || s.owner?.isYours);
  const accounts = [...walletAccs, ...activeStorage];
  const assets = allAssets();
  const total = assets.reduce((a, b) => a + (b.value ?? 0), 0);
  const kta = assets.find((a) => a.isKta);
  const stables = assets.filter((a) => a.known && !a.isKta);
  const stableVal = stables.reduce((a, b) => a + (b.value ?? 0), 0);

  $('total-usd').textContent = fmt.usd(total);
  $('total-sub').textContent = `across ${accounts.length} account${accounts.length !== 1 ? 's' : ''} · ${assets.length} asset${assets.length !== 1 ? 's' : ''}`;
  $('kta-price-line').textContent = state.market ? `${fmt.usdAuto(state.market.price)} · ${fmt.pct(state.market.change24h)} 24h` : '—';
  const dex = state.market?.dex;
  if (dex?.priceUsd != null) {
    $('dex-line').classList.remove('hidden');
    $('dex-price-line').textContent = `${fmt.usdAuto(dex.priceUsd)} · ${fmt.pct(dex.change24hPct)} 24h (Base pool)`;
    if (state.market.price != null && Math.abs(dex.priceUsd - state.market.price) / state.market.price > 0.02) {
      $('dex-price-line').textContent += ' · ⚠ marks disagree >2%';
    }
  }

  const chips = [];
  if (kta) chips.push(`<span class="chip-item">${kta.name || 'KTA'} ${fmt.compact(kta.amount, 4)}</span>`);
  if (stableVal > 0) chips.push(`<span class="chip-item usd-chip">${fmt.usd(stableVal)} in stablecoins</span>`);
  if (!assets.length) chips.push('<span class="chip-item muted">No balances found — add more accounts or fund one on Keeta</span>');
  $('hero-chips').innerHTML = chips.join('');

  // allocation donut
  const priced = assets.filter((a) => a.value != null && a.value > 0);
  const data = priced.map((a, i) => ({
    name: a.name || fmt.short(a.address, 8, 4),
    value: a.value,
    itemStyle: { color: ACCENT[i % ACCENT.length] },
  }));
  if (priced.length) {
    chart('chart-alloc').setOption({
      tooltip: { ...tooltipCommon, formatter: (p) => `${p.name}<br/>${fmt.usdAuto(p.value)} · ${p.percent}%` },
      series: [{
        type: 'pie', radius: ['55%', '80%'],
        data, label: { show: false }, itemStyle: { borderColor: '#24283b', borderWidth: 2 },
      }],
    });
  } else {
    $('chart-alloc').innerHTML = '<div class="muted empty-noline">No priced assets yet</div>';
  }

  // mini assets
  $('ov-assets').innerHTML = assets.slice(0, 6).map((a) => `
    <div class="mini-row">
      ${assetIcon(a)}
      <div class="mini-main"><div class="mini-name">${a.name || 'Unknown token'}</div><div class="muted small mono">${fmt.short(a.address, 10, 5)}</div></div>
      <div class="mini-num">
        <div>${fmt.compact(a.amount, a.amount !== 0 && Math.abs(a.amount) < 1 ? 6 : 4)} ${a.name || ''}</div>
        <div class="muted small">${a.value != null ? fmt.usdAuto(a.value) : 'price n/a'}</div>
      </div>
    </div>`).join('') || '<div class="muted">No balances found</div>';

  // mini accounts
  $('ov-accounts').innerHTML = accounts.slice(0, 5).map((acc, i) => `
    <div class="mini-row">
      <span class="asset-ico ${acc.isStorage ? 'st-bg' : 'kta-bg'}">${acc.isStorage ? 'S' : (acc.name || labelFor(acc.address, i)).slice(0, 1)}</span>
      <div class="mini-main">
        <div class="mini-name">${acc.isStorage ? 'Storage · ' + fmt.short(acc.address, 8, 4) : (acc.name || labelFor(acc.address, i))}</div>
        <div class="muted small mono">${fmt.short(acc.address, 10, 5)} · ${acc.type || ''}</div>
      </div>
      <div class="mini-num"><div>${acc.totalUsd != null ? fmt.usdAuto(acc.totalUsd) : ''}</div><div class="muted small">${(acc.balances || []).length} token${(acc.balances || []).length !== 1 ? 's' : ''}</div></div>
    </div>`).join('') || '<div class="muted">—</div>';

  renderActivityInto($('ov-activity'), 6);
}

function renderAccounts() {
  const wallet = (state.lookups?.accounts || []);
  const storage = (state.storage?.storageAccounts || []);
  $('wallet-count').textContent = wallet.length + ' account' + (wallet.length !== 1 ? 's' : '');

  $('account-list').innerHTML = wallet.map((acc, i) => {
    const bals = (acc.balances || []).filter((b) => b.amount !== 0);
    return `<div class="account-card">
      <div class="acc-head">
        <span class="asset-ico kta-bg">${(acc.name || labelFor(acc.address, i)).slice(0, 1)}</span>
        <div class="acc-name">
          <div>${acc.name || labelFor(acc.address, i)}${acc.username ? ` <span class="tag tag-owner">@${acc.username}</span>` : ''}</div>
          <div class="muted small mono">${acc.type} · ${fmt.short(acc.address, 12, 6)}</div>
        </div>
        <button class="x-btn" title="Remove" data-remove="${acc.address}">✕</button>
      </div>
      <div class="acc-total">${acc.totalUsd != null ? fmt.usdAuto(acc.totalUsd) : '<span class="muted">no priced assets</span>'}</div>
      <div class="acc-bals">
        ${bals.map((b) => `<span class="chip-item">${assetIcon(b, 'asset-ico sm')} ${fmt.compact(b.amount, 4)} ${b.name || ''}</span>`).join('') || '<span class="muted small">empty account</span>'}
      </div>
      <div class="acc-foot muted small">Height ${acc.headHeight != null ? BigInt('0x' + String(acc.headHeight).replace('0x', '')).toString(10) : '—'} · <a href="https://explorer.keeta.com/account/${acc.address}" target="_blank" rel="noopener">explorer ↗</a></div>
    </div>`;
  }).join('') || '<div class="muted card-pad">No wallet accounts connected yet.</div>';

  const walletStorage = storage.filter((s) => (s.balances || []).some((b) => b.amount !== 0) || s.owner?.isYours);
  const empties = storage.filter((s) => !walletStorage.includes(s));

  $('storage-list').innerHTML = walletStorage.length
    ? walletStorage.map((acc) => {
        const owner = acc.owner;
        const isYours = owner?.isYours === true;
        const bals = (acc.balances || []).filter((b) => b.amount !== 0);
        const perms = acc.permissions || [];
        const permLabel = perms.map((p) => p.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())).join(' · ') || 'Access';
        return `<div class="account-card storage">
        <div class="acc-head">
          <span class="asset-ico st-bg">S</span>
          <div class="acc-name">
            ${isYours ? 'Your storage account' : 'Storage account'}
            <span class="sub muted small mono">${fmt.short(acc.address, 14, 8)}</span>
          </div>
          <span class="tag ${isYours ? 'tag-owner' : 'tag-managed'}">${isYours ? 'OWNED BY YOU' : 'MANAGED'}</span>
        </div>
        <div class="perm-badges"><span class="tag tag-info">${permLabel}</span></div>
        <div class="acc-total">${acc.totalUsd != null && acc.totalUsd !== 0 ? fmt.usdAuto(acc.totalUsd) : '<span class="muted" style="font-size:14px">empty</span>'}</div>
        <div class="acc-bals">
          ${bals.map((b) => `<span class="chip-item">${assetIcon(b, 'asset-ico sm')} ${fmt.compact(b.amount, 4)} ${b.name || ''}</span>`).join('') || ''}
        </div>
        <div class="acc-foot muted small">
          ${owner
            ? (isYours
                ? 'You hold the OWNER permission'
                : `Owner: ${owner.name || fmt.short(owner.address, 10, 6)} · your access: ${permLabel}`)
            : 'Owner not determinable (ACL fetch failed)'}
        </div>
      </div>`;
      }).join('')
    : (empties.length
        ? `<div class="muted card-pad">No storage accounts with balances. ${empties.length} account${empties.length !== 1 ? 's' : ''} grant you access but hold nothing — expand below.</span></div>`
        : '<div class="muted card-pad">No storage accounts discovered via ACLs for your accounts. <span class="small">They appear here once an account controls or accesses one.</span></div>');

  // Collapse zero-balance storage accounts the user doesn't own
  const emptyDet = $('empty-storage');
  if (empties.length) {
    emptyDet.classList.remove('hidden');
    $('empty-storage-summary').textContent = `${empties.length} more empty storage account${empties.length !== 1 ? 's' : ''} (access granted, no balances)`;
    $('empty-storage-grid').innerHTML = empties.map((s) => `
      <div class="empty-storage-item">
        <span class="mono">${fmt.short(s.address, 12, 6)}</span>
        <span class="muted">${(s.permissions || []).map((p) => p.replace(/_/g, ' ').toLowerCase()).join(', ') || 'access'}</span>
      </div>`).join('');
  } else {
    emptyDet.classList.add('hidden');
  }

  document.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      state.accounts = state.accounts.filter((a) => a.address !== b.dataset.remove);
      persist();
      refreshPortfolio();
    })
  );
}

/* ---------- portfolio history (localStorage snapshots) ---------- */
const SNAP_KEY = 'dashkee_snaps';
const SNAP_MAX = 400;
const SNAP_THROTTLE = 15 * 60 * 1000; // one snapshot per 15 min per portfolio

function loadSnaps() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; } catch { return []; }
}
const snaps = { list: loadSnaps() };
const saveSnaps = () => {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps.list.slice(-SNAP_MAX))); } catch { /* quota */ }
};
const portfolioSig = (addrs) => [...addrs].sort().join(',');

function recordSnapshot() {
  if (!state.lookups) return;
  const assets = allAssets().map((a) => ({
    code: a.code || null, name: a.name || null, token: a.address,
    amount: a.amount, price: a.price, value: a.value,
  }));
  const total = assets.reduce((s, a) => s + (a.value || 0), 0);
  const sig = portfolioSig(state.accounts.map((a) => a.address));
  const snap = { t: Date.now(), sig, total, assets };
  const last = snaps.list[snaps.list.length - 1];
  if (last && last.sig === sig && Date.now() - last.t < SNAP_THROTTLE) {
    snaps.list[snaps.list.length - 1] = snap; // rolling update within window
  } else {
    snaps.list.push(snap);
  }
  saveSnaps();
  if (state.tab === 'assets') renderHistory();
}

function renderHistory() {
  const sig = portfolioSig(state.accounts.map((a) => a.address));
  const series = snaps.list.filter((s) => s.sig === sig);
  const el = $('pl-stats');
  if (!series.length) {
    el.innerHTML = '<span class="muted small">No snapshots yet for these accounts — a point is recorded each time your portfolio refreshes (every 30s).</span>';
    if (charts['pl-chart']) charts['pl-chart'].clear();
    return;
  }
  const first = series[0], cur = series[series.length - 1];
  const pl = cur.total - first.total;
  const plPct = first.total > 0 ? (pl / first.total) * 100 : null;
  const cls = pl > 0 ? 'green' : pl < 0 ? 'red' : '';
  el.innerHTML = `
    <span class="pl-big ${cls}">${fmt.usdAuto(cur.total)}</span>
    <span class="pl-chg ${cls}">${pl >= 0 ? '+' : '−'}${fmt.usdAuto(Math.abs(pl))}${plPct != null ? ` (${plPct >= 0 ? '+' : '−'}${Math.abs(plPct).toFixed(2)}%)` : ''} since first snapshot</span>
    <span class="muted small">${series.length} snapshot${series.length !== 1 ? 's' : ''} · since ${fmt.date(first.t)}${snaps.list.length !== series.length ? ` · ${snaps.list.length - series.length} stored for other account sets` : ''}</span>`;
  if (series.length < 2) {
    if (charts['pl-chart']) charts['pl-chart'].clear();
    return;
  }
  chart('pl-chart').setOption({
    grid: { left: 64, right: 14, top: 14, bottom: 24 },
    xAxis: { type: 'time', ...axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...axisCommon, scale: true, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.usdAuto(v) } },
    tooltip: { ...tooltipCommon, trigger: 'axis', valueFormatter: (v) => fmt.usd(v) },
    series: [areaSeries(series.map((s) => [s.t, s.total]), '#9ece6a', 'Portfolio')],
  });
}

/* ---------- CSV export ---------- */
function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
const dayStamp = () => new Date().toISOString().slice(0, 10);

$('csv-assets').onclick = () => {
  const assets = allAssets();
  if (!assets.length) return toast('Nothing to export yet');
  const rows = [
    ['Asset', 'Code', 'Token address', 'Price USD', 'Balance', 'Value USD', 'Held in accounts'],
    ...assets.map((a) => [a.name || 'Unknown', a.code || '', a.address, a.price ?? '', a.amount, a.value ?? '', a.holders.length]),
  ];
  downloadCSV(`dashkee-assets-${dayStamp()}.csv`, rows);
  toast('Assets CSV downloaded');
};

$('csv-history').onclick = () => {
  const series = snaps.list;
  if (!series.length) return toast('No snapshots recorded yet');
  const rows = [['Snapshot time (ISO)', 'Portfolio total USD', 'Asset', 'Code', 'Token address', 'Balance', 'Price USD', 'Value USD']];
  for (const s of series) {
    const when = new Date(s.t).toISOString();
    for (const a of s.assets) rows.push([when, s.total.toFixed(2), a.name || 'Unknown', a.code || '', a.token, a.amount, a.price ?? '', a.value ?? '']);
  }
  downloadCSV('dashkee-portfolio-history.csv', rows);
  toast('History CSV downloaded');
};

$('snap-clear').onclick = () => {
  if (!snaps.list.length) return toast('History is already empty');
  if (!confirm(`Delete all ${snaps.list.length} portfolio snapshots from this browser?`)) return;
  snaps.list = [];
  saveSnaps();
  renderHistory();
  toast('Snapshot history cleared');
};

/* ---------- historical P&L (reconstructed from chain) ---------- */
function hplRange() {
  const preset = $('hpl-preset').value;
  const now = new Date();
  const to = now.toISOString();
  if (preset === 'custom') {
    const f = $('hpl-from').value, t = $('hpl-to').value;
    if (!f || !t) { toast('Pick both dates for a custom range'); return null; }
    return { from: f + 'T00:00:00Z', to: t + 'T23:59:59Z' };
  }
  const start = new Date(now);
  if (preset === 'this-month') { start.setDate(1); start.setUTCHours(0, 0, 0, 0); }
  else if (preset === 'last-month') {
    start.setDate(1); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    start.setUTCMonth(start.getUTCMonth() - 1);
    return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
  }
  else if (preset === '30d') start.setUTCDate(start.getUTCDate() - 30);
  else if (preset === '90d') start.setUTCDate(start.getUTCDate() - 90);
  else if (preset === 'ytd') start.setUTCMonth(0, 1), start.setUTCHours(0, 0, 0, 0);
  else if (preset === '2026') return { from: '2026-01-01T00:00:00Z', to };
  else if (preset === '2025') return { from: '2025-01-01T00:00:00Z', to: '2025-12-31T23:59:59Z' };
  return { from: start.toISOString(), to };
}

async function computeHPL() {
  const range = hplRange();
  if (!range) return;
  const addrs = [...state.accounts.map((a) => a.address), ...(state.storage?.storageAccounts || []).map((s) => s.address)];
  if (!addrs.length) return toast('Connect an account first');
  const btn = $('hpl-compute');
  btn.disabled = true; btn.textContent = 'Replaying chain…';
  try {
    const data = await getJSON('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses: addrs, from: range.from, to: range.to }),
    });
    renderHPL(data);
  } catch (e) {
    toast('P&L computation failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false; btn.textContent = 'Compute P&L';
  }
}
$('hpl-compute').onclick = computeHPL;
$('hpl-preset').onchange = () => {
  const custom = $('hpl-preset').value === 'custom';
  $('hpl-from').classList.toggle('hidden', !custom);
  $('hpl-to').classList.toggle('hidden', !custom);
};

function renderHPL(data) {
  const s = data.summary;
  const cls = s.pnl > 0 ? 'green' : s.pnl < 0 ? 'red' : '';
  const flowCls = s.netFlowUsd > 0 ? 'green' : s.netFlowUsd < 0 ? 'red' : '';
  const period = `${fmt.date(data.from)} → ${fmt.date(data.to)}`;
  $('hpl-summary').classList.remove('hidden');
  $('hpl-summary').innerHTML = `
    <span class="pl-big ${cls}">${s.pnl >= 0 ? '+' : '−'}${fmt.usdAuto(Math.abs(s.pnl))}</span>
    <span class="pl-chg ${cls}">P&amp;L${s.pnlPct != null ? ` (${s.pnl >= 0 ? '+' : '−'}${Math.abs(s.pnlPct).toFixed(2)}%)` : ''}</span>
    <span class="muted small">${period}</span>
    <span class="muted small">value ${fmt.usdAuto(s.startTotal)} → ${fmt.usdAuto(s.endTotal)}</span>
    <span class="muted small">net transfers <span class="${flowCls}">${s.netFlowUsd >= 0 ? '+' : '−'}${fmt.usdAuto(Math.abs(s.netFlowUsd))}</span></span>`;
  $('hpl-chart').classList.remove('hidden');
  chart('hpl-chart').setOption({
    grid: { left: 64, right: 14, top: 14, bottom: 24 },
    xAxis: { type: 'time', ...axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...axisCommon, scale: true, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.usdAuto(v) } },
    tooltip: { ...tooltipCommon, trigger: 'axis', valueFormatter: (v) => fmt.usd(v) },
    series: [{
      name: 'Portfolio value', type: 'line', step: 'end', symbol: 'none',
      data: (data.points || []).map((p) => [p.t, p.total]),
      lineStyle: { width: 2, color: '#7aa2f7' }, itemStyle: { color: '#7aa2f7' },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: '#7aa2f733' }, { offset: 1, color: '#7aa2f703' },
        ]),
      },
    }],
  });
  const KIND = { historical: 'historical price', current: 'current price', unpriced: 'no price', unknown: 'no price' };
  $('hpl-table-wrap').classList.remove('hidden');
  $('hpl-body').innerHTML = (data.tokens || []).map((t) => `<tr>
      <td><div class="asset-cell">${assetIcon(t)}<div><div class="mini-name">${t.name || 'Unknown token'}</div><div class="muted small mono">${fmt.short(t.token, 10, 5)}</div></div></div></td>
      <td><span class="muted small">${KIND[t.priceKind] || t.priceKind}</span></td>
      <td class="right small">${fmt.compact(t.startBal, Math.abs(t.startBal) < 1 ? 6 : 2)} → <span class="strong">${fmt.compact(t.endBal, Math.abs(t.endBal) < 1 ? 6 : 2)}</span></td>
      <td class="right small">${t.startVal || t.endVal ? `${fmt.usdAuto(t.startVal)} → <span class="strong">${fmt.usdAuto(t.endVal)}</span>` : '<span class="muted">—</span>'}</td>
      <td class="right small ${t.netFlowUsd > 0 ? 'green' : t.netFlowUsd < 0 ? 'red' : 'muted'}">${t.netFlowUsd ? (t.netFlowUsd > 0 ? '+' : '−') + fmt.usdAuto(Math.abs(t.netFlowUsd)) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted empty">No token movements found in this range</td></tr>';
  const notes = [];
  if (data.clamped) notes.push('CoinGecko free tier only provides 364 days of price history — the range was clamped');
  if (data.truncated) notes.push(`some accounts have more chain history than was scanned — send/receive events before ${fmt.date(data.chainStart)} may be missing`);
  if (s.unpricedTokens) notes.push(`${s.unpricedTokens} token${s.unpricedTokens !== 1 ? 's' : ''} without a known price are excluded from USD totals`);
  notes.push('P&L = end value − start value − net transfers (transfers priced at their own dates)');
  $('hpl-note').textContent = notes.join(' · ');
}

function renderAssets() {
  const assets = allAssets();
  const total = assets.reduce((a, b) => a + (b.value ?? 0), 0);
  const priced = assets.filter((a) => a.value != null);
  $('assets-sub').textContent = `${assets.length} tokens · total ${fmt.usd(total)}`;
  $('assets-body').innerHTML = assets.map((a, i) => {
    const share = a.value != null && total > 0 ? (a.value / total) * 100 : null;
    return `<tr>
      <td><div class="asset-cell">${assetIcon(a)}<div><div class="mini-name">${a.name || 'Unknown token'}${a.kind ? ` <span class="muted small">(${a.kind === 'stablecoin' ? 'stablecoin peg' : a.kind === 'fiat-token' ? 'fiat peg' : ''}${a.kind === 'stablecoin' || a.kind === 'fiat-token' ? ', unverified reserves' : ''})</span>` : ''}</div><div class="muted small mono">${fmt.short(a.address, 12, 6)}</div></div></div></td>
      <td>${a.price != null ? fmt.usdAuto(a.price) : '<span class="muted">—</span>'}</td>
      <td>${fmt.compact(a.amount, Math.abs(a.amount) < 1 ? 6 : 4)}</td>
      <td class="strong">${a.value != null ? fmt.usdAuto(a.value) : '<span class="muted">—</span>'}</td>
      <td>${share != null ? `<div class="bar-row"><div class="bar" style="width:${Math.min(100, share)}%;background:${ACCENT[i % ACCENT.length]}"></div></div><span class="muted small">${share.toFixed(1)}%</span>` : '<span class="muted small">—</span>'}</td>
      <td class="muted small">${a.holders.length} account${a.holders.length !== 1 ? 's' : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted empty">No assets yet</td></tr>';
}

function opDesc(op) {
  switch (op.typeLabel) {
    case 'SEND': return { tag: 'Sent', cls: 'op-out' };
    case 'RECEIVE': return { tag: 'Received', cls: 'op-in' };
    case 'SET_INFO': return { tag: 'Info updated', cls: 'op-info' };
    case 'SET_REP': return { tag: 'Rep changed', cls: 'op-info' };
    case 'TOKEN_ADMIN_SUPPLY': return { tag: 'Supply change', cls: 'op-info' };
    case 'TOKEN_ADMIN_MODIFY_BALANCE': return { tag: 'Mint/Burn', cls: 'op-info' };
    case 'MANAGE_CERTIFICATE': return { tag: 'Certificate', cls: 'op-info' };
    case 'MODIFY_PERMISSIONS': return { tag: 'Permissions', cls: 'op-info' };
    case 'CREATE_IDENTIFIER': return { tag: 'Identifier', cls: 'op-info' };
    default: return { tag: op.typeLabel || 'Op', cls: 'op-info' };
  }
}

function renderActivityInto(tbody, limit) {
  const blocks = (state.activity?.blocks || []).slice(0, limit);
  if (!blocks.length) {
    tbody.innerHTML = '<tr><td class="muted empty">No activity found for your accounts</td></tr>';
    return;
  }
  const kta = state.lookups?.ktaAddress;
  tbody.innerHTML = blocks.map((b) => {
    const sendOp = (b.operations || []).find((o) => o.typeLabel === 'SEND');
    const recvOp = (b.operations || []).find((o) => o.typeLabel === 'RECEIVE');
    const other = (b.operations || []).find((o) => o.typeLabel !== 'SEND' && o.typeLabel !== 'RECEIVE');
    let main = other ? opDesc(other) : null;
    let amountHtml = '';
    if (sendOp) {
      main = { tag: 'Sent', cls: 'op-out' };
      const isKta = !sendOp.token || sendOp.token === kta;
      const amt = sendOp.amount != null ? Number(BigInt(sendOp.amount)) / 1e18 : null;
      if (amt != null) amountHtml = isKta ? `−${fmt.compact(amt, 6)} KTA` : `−${fmt.compact(amt, 6)}`;
    } else if (recvOp) {
      main = { tag: 'Received', cls: 'op-in' };
      const isKta = !recvOp.token || recvOp.token === kta;
      const amt = recvOp.amount != null ? Number(BigInt(recvOp.amount)) / 1e18 : null;
      if (amt != null) amountHtml = isKta ? `+${fmt.compact(amt, 6)} KTA` : `+${fmt.compact(amt, 6)}`;
    } else if (!main) {
      main = { tag: 'Block', cls: 'op-info' };
    }
    return `<tr>
      <td><div class="op-cell"><span class="op-dot ${main.cls}"></span><div><div class="mini-name">${main.tag}</div><div class="muted small mono">${b.hash ? fmt.short(b.hash, 10, 5) : ''} · ${b.account ? fmt.short(b.account, 8, 4) : ''}</div></div></div></td>
      <td class="strong right ${amountHtml.startsWith('+') ? 'green' : amountHtml.startsWith('−') ? 'red' : ''}">${amountHtml || '—'}</td>
      <td class="muted right">${fmt.date(b.date)}</td>
    </tr>`;
  }).join('');
}

function renderActivity() {
  renderActivityInto($('activity-body'), 50);
}

/* ---------- market polling (for KTA line) ---------- */
async function pollMarket() {
  try { state.market = await getJSON('/api/market'); } catch { /* best effort */ }
}

/* ---------- network tab (previous explorer, light theme) ---------- */
let netTimer = null, feedTimer = null, tpsSeries = [], prevTx = null, prevTxAt = null;

function startNetworkPolling() {
  if (netTimer) return;
  pollNetworkTab();
  pollFeed();
  netTimer = setInterval(pollNetworkTab, 3000);
  feedTimer = setInterval(pollFeed, 5000);
}
function stopNetworkPolling() {
  clearInterval(netTimer); clearInterval(feedTimer);
  netTimer = feedTimer = null;
}
/* keep polling cheap: only fetch while the tab is visible */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && netTimer) stopNetworkPolling();
  else if (!document.hidden && state.tab === 'network') startNetworkPolling();
});

async function pollNetworkTab() {
  try {
    const net = await getJSON('/api/network');
    $('live-dot').className = 'live-dot on';
    $('tx-count').textContent = fmt.compact(net.transactionCount);
    $('block-count').textContent = fmt.compact(net.blockCount) + ' blocks';
    pushTpsSample(net);
    renderSettlement(net.settlementTimes);
    renderReps(net);
    $('nd-version').textContent = net.version || '—';
    $('nd-peers').textContent = net.peers != null ? net.peers : '—';
    $('nd-netaddr').textContent = fmt.short(net.networkAddress, 12, 6);
    $('supply').textContent = fmt.compact(net.baseToken.supply, 2) + ' KTA';
    const freshest = (net.ledgers || []).map((l) => l.moment).sort().pop();
    if (freshest) $('chain-time').textContent = new Date(freshest).toLocaleTimeString('en-US', { hour12: false }) + ' UTC';
  } catch {
    $('live-dot').className = 'live-dot err';
  }
}

function pushTpsSample(net) {
  const now = Date.now();
  if (prevTx != null && net.transactionCount >= prevTx) {
    const dt = (now - prevTxAt) / 1000;
    if (dt > 0.5) {
      const tps = (net.transactionCount - prevTx) / dt;
      tpsSeries.push([now, Math.max(0, tps)]);
      while (tpsSeries.length && tpsSeries[0][0] < now - 5 * 60_000) tpsSeries.shift();
      $('tps').textContent = fmt.compact(tpsSeries[tpsSeries.length - 1][1]);
      $('tps-window').textContent = '5 min window';
      chart('chart-tps').setOption({
        grid: { left: 48, right: 14, top: 14, bottom: 24 },
        xAxis: { type: 'time', ...axisCommon, splitLine: { show: false } },
        yAxis: { type: 'value', ...axisCommon },
        tooltip: { ...tooltipCommon, trigger: 'axis', valueFormatter: (v) => fmt.compact(v, 1) + ' tx/s' },
        series: [areaSeries(tpsSeries, '#7aa2f7', 'TPS')],
      });
    }
  }
  prevTx = net.transactionCount; prevTxAt = now;
}

function renderSettlement(st) {
  if (!st) return;
  const skip = ['-1ms', '0ms', 'ExtraLong'];
  const buckets = Object.entries(st).filter(([k]) => !skip.includes(k))
    .sort((a, b) => parseInt(a[1].range[0]) - parseInt(b[1].range[0]));
  const total = buckets.reduce((a, [, v]) => a + v.count, 0);
  if (total > 0) {
    let cum = 0, p50 = null, p90 = null;
    buckets.forEach(([, v]) => {
      cum += v.count;
      const mid = (v.range[0] + Math.min(v.range[1], 30000)) / 2;
      if (p50 == null && cum >= total * 0.5) p50 = mid;
      if (p90 == null && cum >= total * 0.9) p90 = mid;
    });
    if (p50 != null) $('settle-median').textContent = Math.round(p50) + ' ms';
    if (p90 != null) $('settle-p90').textContent = 'p90 ≈ ' + Math.round(p90) + ' ms';
  }
  chart('chart-settle').setOption({
    grid: { left: 48, right: 14, top: 14, bottom: 44 },
    xAxis: { type: 'category', data: buckets.map(([k]) => k), ...axisCommon, axisLabel: { ...axisCommon.axisLabel, rotate: 40 } },
    yAxis: { type: 'value', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => fmt.compact(v, 0) } },
    tooltip: { ...tooltipCommon, trigger: 'axis' },
    series: [{
      type: 'bar', data: buckets.map(([, v]) => v.count), barCategoryGap: '25%',
      itemStyle: {
        borderRadius: [4, 4, 0, 0],
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#0db9d7' }, { offset: 1, color: '#7aa2f7' }]),
      },
    }],
  });
}

const REP_COLORS = ['#7aa2f7', '#0db9d7', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e'];
function renderReps(net) {
  const reps = net.reps || [];
  chart('chart-reps').setOption({
    tooltip: { ...tooltipCommon, formatter: (p) => `${p.data.full}<br/>${(p.data.share ?? 0).toFixed(2)}%` },
    series: [{
      type: 'pie', radius: ['58%', '82%'],
      data: reps.map((r, i) => ({
        name: fmt.short(r.representative, 12, 5), value: Number(r.weight),
        full: r.representative, share: r.share,
        itemStyle: { color: REP_COLORS[i % REP_COLORS.length] },
      })),
      label: { show: false }, itemStyle: { borderColor: '#24283b', borderWidth: 2 },
    }],
  });
  $('rep-body').innerHTML = reps.map((r, i) => {
    const w = BigInt(r.weight);
    return `<tr><td class="mono small">${fmt.short(r.representative, 12, 5)}</td><td class="right">${r.share != null ? r.share.toFixed(1) + '%' : '—'}</td></tr>`;
  }).join('') || '<tr><td class="muted">—</td></tr>';
}

async function pollFeed() {
  try {
    const data = await getJSON('/api/recent');
    $('feed-state').textContent = 'live';
    const rows = (data.blocks || []).slice(0, 25).map((b) => {
      const ops = (b.operations || []).map((o) => {
        const known = ['SEND', 'RECEIVE'].includes(o.typeLabel);
        let label = o.typeLabel;
        if (known && o.amount != null) label = o.typeLabel + ' ' + fmt.compact(Number(BigInt(o.amount)) / 1e18, 4) + ' KTA';
        return `<span class="tag ${known ? (o.typeLabel === 'SEND' ? 'tag-out' : 'tag-in') : 'tag-info'}">${label}</span>`;
      }).join(' ') || '<span class="muted small">—</span>';
      return `<tr>
        <td class="mono small">${b.hash ? fmt.short(b.hash, 10, 5) : '—'}</td>
        <td class="mono small">${fmt.short(b.account, 10, 5)}</td>
        <td>${ops}</td>
        <td class="muted right small">${fmt.ago(b.date)}</td>
      </tr>`;
    }).join('');
    $('feed-body').innerHTML = rows || '<tr><td class="muted empty">No blocks observed in window</td></tr>';
  } catch { $('feed-state').textContent = 'reconnecting'; }
}

/* price chart in network tab */
async function renderPriceChart() {
  if (!state.market?.sparkline?.length) return;
  const data = state.market.sparkline.filter((p) => p[1] != null);
  chart('chart-price').setOption({
    grid: { left: 56, right: 14, top: 14, bottom: 24 },
    xAxis: { type: 'time', ...axisCommon, splitLine: { show: false } },
    yAxis: { type: 'value', ...axisCommon, scale: true, axisLabel: { ...axisCommon.axisLabel, formatter: (v) => '$' + v.toFixed(3) } },
    tooltip: { ...tooltipCommon, trigger: 'axis', valueFormatter: (v) => fmt.usd(v, 4) },
    series: [areaSeries(data, '#7aa2f7', 'KTA')],
  });
  $('kta-changes').textContent = '7d ' + fmt.pct(state.market.change7d) + ' · 30d ' + fmt.pct(state.market.change30d);
}

/* ---------- boot ---------- */
pollMarket();
refreshPortfolio();
setInterval(pollMarket, 60_000);
setInterval(() => { pollMarket().then(renderPriceChart); }, 65_000);
setInterval(refreshPortfolio, 30_000);
pollMarket().then(renderPriceChart);
