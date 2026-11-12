/* DashKee shared backend logic — used by both the local Express server
   (server.mjs) and the Vercel serverless functions (api/*.js).
   Client + caches are singletons (globalThis) so warm lambda instances reuse them. */

import * as KeetaNet from '@keetanetwork/keetanet-client';

const NETWORK = process.env.KEETA_NETWORK || 'main';

/* ---------------- singleton app state ---------------- */
function state() {
  const g = globalThis;
  if (!g.__dashkee) {
    const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed({ asString: true }), 0);
    const uc = KeetaNet.UserClient.fromNetwork(NETWORK, signer);
    g.__dashkee = {
      signer, uc,
      client: uc.client,
      KTA: uc.baseToken.publicKeyString.get(),
      cache: new Map(),
    };
  }
  return g.__dashkee;
}
export const KTA_TOKEN = () => state().KTA;

export { NETWORK };

const withTimeout = (promise, ms, label = 'operation') =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);

export const S = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
  if (typeof x === 'bigint') return String(x);
  if (x && typeof x === 'object' && typeof x.publicKeyString?.get === 'function') return x.publicKeyString.get();
  return x;
}));

export const isAddress = (s) => {
  try { KeetaNet.lib.Account.fromPublicKeyString(s); return true; } catch { return false; }
};

const cache = () => state().cache;
export const cached = async (key, ttlMs, fn) => {
  const c = cache();
  const hit = c.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    c.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return hit.value;
    throw e;
  }
};

/* Known mainnet tokens (docs.keeta.com — fiat anchors) */
export const USDC_TOKEN = 'keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna';
export const EUR_TOKEN = 'keeta_anutgo4o3yp5tvc6wjt4vzsehjbn7t2wylpxmam4d4ojtdkjj2yca2qoinfcs';

/* ---- ACL permission decoding (BaseFlag offsets) ---- */
const BASE_FLAGS = {
  0: 'ACCESS', 1: 'OWNER', 2: 'ADMIN', 3: 'UPDATE_INFO', 4: 'SEND_ON_BEHALF',
  5: 'TOKEN_ADMIN_CREATE', 6: 'TOKEN_ADMIN_SUPPLY', 7: 'TOKEN_ADMIN_MODIFY_BALANCE',
  8: 'STORAGE_CREATE', 9: 'STORAGE_CAN_HOLD', 10: 'STORAGE_DEPOSIT',
  11: 'PERMISSION_DELEGATE_ADD', 12: 'PERMISSION_DELEGATE_REMOVE',
  13: 'MANAGE_CERTIFICATE', 14: 'MULTISIG_SIGNER',
};
export function decodeBaseBitfield(mask) {
  const flags = [];
  try {
    const n = BigInt(mask);
    for (let i = 0; i <= 14; i++) {
      if (n & (1n << BigInt(i))) flags.push(BASE_FLAGS[i] ?? 'FLAG_' + i);
    }
  } catch { /* ignore */ }
  return flags;
}

/* ---------------- token metadata + pricing ---------------- */
const METADATA_TTL = 5 * 60_000;

export async function tokenMeta(tokenAddr) {
  return cached('tok:' + tokenAddr, METADATA_TTL, async () => {
    const reg = await tokenRegistry().catch(() => null);
    const regEntry = reg?.get(tokenAddr) ?? null;
    const { client } = state();
    const info = await withTimeout(client.getAccountInfo(KeetaNet.lib.Account.fromPublicKeyString(tokenAddr)), 12000, 'token info')
      .then((i) => S(i))
      .catch(() => null);
    const meta = S(info?.info?.metadata ?? null);
    let decimals = null, logo = null;
    if (meta) {
      try {
        const m = JSON.parse(Buffer.from(meta, 'base64').toString('utf8'));
        if (typeof m.decimalPlaces === 'number') decimals = m.decimalPlaces;
        const logoField = m.logoURI ?? m.logoUrl ?? m.logoURL;
        if (typeof logoField === 'string' && logoField.length < 300_000) logo = logoField;
      } catch { /* ignore */ }
    }
    return {
      address: tokenAddr,
      name: info?.info?.name ?? regEntry?.name ?? null,
      description: info?.info?.description ?? null,
      code: regEntry?.code ?? null,
      kind: regEntry?.kind ?? null,
      issuer: regEntry?.issuer ?? null,
      decimals: decimals ?? regEntry?.decimals ?? null,
      logo,
      supply: info?.info?.supply != null ? String(info.info.supply) : null,
    };
  });
}

/* USD value of one unit of a fiat currency (peg rates) */
const STATIC_USD_FIAT = { AED: 1 / 3.6725 }; // hard peg, not in ECB list
export async function fiatUsdRates() {
  return cached('fiat', 3_600_000, async () => {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY,CNY,GBP,CAD,MXN,HKD');
    if (!res.ok) throw new Error('frankfurter ' + res.status);
    const j = await res.json();
    const inv = {};
    for (const [cur, rate] of Object.entries(j.rates || {})) inv[cur] = 1 / rate;
    return { ...inv, ...STATIC_USD_FIAT };
  });
}

/* ---------------- KeeSpecs (keespecs.xyz) free reads ---------------- */
const KS = 'https://keespecs.xyz';

export async function ksPrice() {
  return cached('ks:price', 60_000, async () => {
    const res = await fetch(`${KS}/api/price`);
    if (!res.ok) throw new Error('keespecs price ' + res.status);
    const j = await res.json();
    return { priceUsd: j.priceUsd ?? null, change1hPct: j.change1hPct ?? null, change24hPct: j.change24hPct ?? null, source: 'keespecs/dexscreener (Base pool)', asOf: j.asOf ?? null };
  });
}

export async function ksStablecoins() {
  return cached('ks:stables', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/stablecoins`);
    if (!res.ok) throw new Error('keespecs stablecoins ' + res.status);
    const j = await res.json();
    return (j.coins || []).map((c) => ({ code: c.code, currency: c.currency, token: c.token, name: c.name, decimals: c.decimals, supply: c.supply }));
  });
}

export async function ksDirectory() {
  return cached('ks:dir', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/directory`);
    if (!res.ok) throw new Error('keespecs directory ' + res.status);
    const j = await res.json();
    return (j.tokens || []).map((t) => ({ code: t.code, name: t.name, token: t.token, decimals: t.decimals, supply: t.supply }));
  });
}

export async function ksSupply() {
  return cached('ks:supply', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/supply`);
    if (!res.ok) throw new Error('keespecs supply ' + res.status);
    const j = await res.json();
    return (j.assets || []).map((a) => ({ code: a.code, token: a.token, name: a.name, decimals: a.decimals, supply: a.supply }));
  });
}

export async function ksUsername(address) {
  return cached('ks:user:' + address, 10 * 60_000, async () => {
    const res = await fetch(`${KS}/api/username?account=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const j = await res.json();
    return j.username || j.global_username || null;
  });
}

export async function tokenRegistry() {
  return cached('ks:registry', 6 * 3_600_000, async () => {
    const [stables, dir, supply] = await Promise.all([
      ksStablecoins().catch(() => []),
      ksDirectory().catch(() => []),
      ksSupply().catch(() => []),
    ]);
    const reg = new Map();
    const rates = await fiatUsdRates().catch(() => ({}));
    const fiatCodes = new Set([...Object.keys(rates), 'USD']);
    for (const s of stables) reg.set(s.token, { code: s.code, currency: s.currency, name: s.name, decimals: s.decimals, kind: 'stablecoin', issuer: 'Bivo (KeeSpecs, unverified reserves)' });
    for (const t of dir) if (!reg.has(t.token)) {
      const isFiat = fiatCodes.has(t.code);
      reg.set(t.token, { code: t.code, currency: isFiat ? t.code : null, name: t.name, decimals: t.decimals, kind: isFiat ? 'fiat-token' : 'asset' });
    }
    for (const a of supply) {
      const cur = reg.get(a.token) || {};
      reg.set(a.token, { ...cur, code: a.code, name: a.name, decimals: a.decimals, kind: cur.kind ?? 'asset' });
    }
    return reg;
  });
}

export async function cgSimple(id) {
  return cached('cg:' + id, 5 * 60_000, async () => {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error('coingecko ' + res.status);
    const j = await res.json();
    return j[id]?.usd ?? null;
  });
}

/* Historical daily price series from CoinGecko (free tier: last 365 days). */
const CG_HIST_IDS = { KTA: 'keeta', CBTC: 'bitcoin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cgPriceHistory(id, fromSec, toSec) {
  const day = 86_400_000;
  const key = `cghist:${id}:${Math.floor(fromSec * 1000 / day)}:${Math.floor(toSec * 1000 / day)}`;
  return cached(key, 10 * 60_000, async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${fromSec}&to=${toSec}`);
        if (res.status === 429) { lastErr = new Error('coingecko rate limited'); await sleep(1500 * (attempt + 1)); continue; }
        if (!res.ok) throw new Error('coingecko range ' + res.status);
        const j = await res.json();
        return (j.prices || []).map(([t, p]) => [t, p]);
      } catch (e) { lastErr = e; await sleep(1200); }
    }
    // fallback: days= endpoint (works when the window ends near "now")
    try {
      const days = Math.max(1, Math.ceil((toSec * 1000 - fromSec * 1000) / 86_400_000) + 1);
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`);
      if (res.ok) {
        const j = await res.json();
        const prices = (j.prices || []).filter(([t]) => t >= fromSec * 1000 - 86_400_000 && t <= toSec * 1000 + 86_400_000);
        if (prices.length) return prices;
      }
    } catch { /* fallthrough */ }
    throw lastErr ?? new Error('coingecko range failed');
  });
}
function priceAtSeries(series, tsMs) {
  if (!series?.length) return null;
  let lo = 0, hi = series.length - 1, best = series[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= tsMs) { best = series[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (best[0] > tsMs && series[0][0] > tsMs) return series[0][1]; // earliest known
  return best[1];
}

/* ---------------- historical P&L (reconstructed from chain) ---------------- */
/* Balances at any past date T are derived by replaying SEND/RECEIVE events
   backward from the current balance: bal(T) = bal(now) − Σ_{events after T} delta.
   Only events inside [from, to] matter, so the account's full history depth
   only needs to cover that window. USD values use historical KTA/BTC prices
   (CoinGecko range) and constant peg prices for stablecoins/fiat tokens. */
const HIST_CHAIN_DEPTH = 250;

export async function historicalPL(addresses, fromISO, toISO) {
  const now = Date.now();
  let from = new Date(fromISO), to = new Date(toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Invalid dates');
  if (to.getTime() > now + 5 * 60_000) to = new Date(now);
  if (from.getTime() >= to.getTime()) throw new Error('"from" must be before "to"');
  const CG_MAX_DAYS = 364;
  let clamped = false;
  if (now - from.getTime() > CG_MAX_DAYS * 86_400_000) {
    from = new Date(now - CG_MAX_DAYS * 86_400_000);
    clamped = true;
  }
  const fromMs = from.getTime(), toMs = to.getTime();

  const uniq = [...new Set(addresses.filter(isAddress))].slice(0, MAX_ADDRESSES);
  if (!uniq.length) throw new Error('addresses[] required');
  const { client } = state();

  // current balances + token metadata (human units)
  const lookups = await lookupAddresses(uniq);
  const accounts = lookups.accounts;
  const existsSet = new Set(accounts.filter((a) => a.exists).map((a) => a.address));

  // fetch chains (desc by date after we sort)
  const chains = await Promise.all(accounts.map(async (a) => {
    if (!a.exists) return { address: a.address, blocks: [] };
    try {
      const chain = await withTimeout(client.getChain(KeetaNet.lib.Account.fromPublicKeyString(a.address), { depth: HIST_CHAIN_DEPTH }), 15000, 'chain');
      return { address: a.address, blocks: S(chain) };
    } catch { return { address: a.address, blocks: [] }; }
  }));

  // token metadata (decimals/names) for every token seen in balances or events
  const tokenSet = new Set();
  for (const a of accounts) for (const b of a.balances || []) tokenSet.add(b.address);
  const rawEvents = []; // { date, account, token, rawDelta } — scaled after decimals known
  for (const c of chains) {
    const blocks = [...c.blocks].sort((x, y) => new Date(y.date) - new Date(x.date));
    for (const blk of blocks) {
      const bd = blk.date ? new Date(blk.date).getTime() : null;
      if (bd == null || bd <= fromMs || bd > toMs) continue; // window is (from, to]
      for (const o of blk.operations || []) {
        const type = KeetaNet.lib.Block.OperationType[o.type] ?? String(o.type);
        if (type !== 'SEND' && type !== 'RECEIVE') continue;
        const token = o.token || KTA_TOKEN();
        tokenSet.add(token);
        rawEvents.push({ date: bd, account: c.address, token, rawDelta: (type === 'SEND' ? -1 : 1) * Number(BigInt(o.amount)) });
      }
    }
  }
  const metas = await Promise.all([...tokenSet].map((t) => tokenMeta(t).catch(() => null)));
  const metaBy = Object.fromEntries(metas.filter(Boolean).map((m) => [m.address, m]));
  const events = rawEvents.map((e) => ({
    ...e,
    delta: e.rawDelta / Math.pow(10, metaBy[e.token]?.decimals ?? 18), // human units, same as balances
  }));

  // USD price source per token: historical series where possible,
  // otherwise constant current price (labeled so the UI can warn)
  const fromSec = Math.floor(fromMs / 1000), toSec = Math.floor(toMs / 1000);
  const priceSources = new Map(); // token -> { series, fallback } | { constant }
  for (const t of tokenSet) {
    const code = metaBy[t]?.code?.toUpperCase();
    const histId = t === KTA_TOKEN() ? CG_HIST_IDS.KTA : CG_HIST_IDS[code ?? ''] ?? null;
    if (histId) {
      const series = await cgPriceHistory(histId, fromSec, toSec).catch(() => null);
      if (series?.length) {
        priceSources.set(t, { series, fallback: false });
        continue;
      }
    }
    priceSources.set(t, { constant: await priceFor(t).catch(() => null) });
  }
  const priceAt = (token, tsMs) => {
    const src = priceSources.get(token);
    if (!src) return null;
    if (src.series) return src.series.length ? priceAtSeries(src.series, tsMs) : null;
    return src.constant ?? null;
  };
  const priceKind = (token) => {
    const src = priceSources.get(token);
    if (!src) return 'unknown';
    if (src.series) return 'historical';
    return src.constant != null ? 'current' : 'unpriced';
  };

  // current balances per account per token (human units), plus zero for event-only tokens
  const current = new Map(); // `${account}|${token}` -> amount
  for (const a of accounts) for (const b of a.balances || []) current.set(`${a.address}|${b.address}`, b.amount);
  for (const e of events) {
    const k = `${e.account}|${e.token}`;
    if (!current.has(k)) current.set(k, 0);
  }

  // balances at time T: walk events after T in reverse
  const balancesAt = (T) => {
    const out = new Map(current);
    for (const e of events) {
      if (e.date > T) {
        const k = `${e.account}|${e.token}`;
        out.set(k, (out.get(k) ?? 0) - e.delta);
      }
    }
    return out;
  };

  // sample points: from, each event date inside window (asc), to
  const pointTimes = [...new Set(events.filter((e) => e.date > fromMs && e.date <= toMs).map((e) => e.date))].sort((a, b) => a - b);
  const samples = [fromMs, ...pointTimes, toMs];
  const points = samples.map((T) => {
    const bal = balancesAt(T);
    const perToken = {};
    let total = 0;
    for (const t of tokenSet) {
      let amt = 0;
      for (const a of accounts) amt += bal.get(`${a.address}|${t}`) ?? 0;
      if (!amt) continue;
      const p = priceAt(t, T);
      const v = p != null ? amt * p : null;
      if (v != null) total += v;
      perToken[t] = { amount: amt, price: p, value: v };
    }
    return { t: T, total, perToken };
  });
  const start = points[0], end = points[points.length - 1];

  // per-token summary + net transfer flow (flows priced at their own date)
  const tokenRows = [...tokenSet].map((t) => {
    const startBal = start.perToken[t]?.amount ?? 0;
    const endBal = end.perToken[t]?.amount ?? 0;
    const flow = events
      .filter((e) => e.token === t && e.date > fromMs && e.date <= toMs)
      .reduce((s, e) => s + e.delta * (priceAt(t, e.date) ?? 0), 0);
    return {
      token: t,
      name: metaBy[t]?.name ?? null,
      code: metaBy[t]?.code ?? null,
      priceKind: priceKind(t),
      startBal, endBal,
      startVal: start.perToken[t]?.value ?? 0,
      endVal: end.perToken[t]?.value ?? 0,
      netFlowUsd: flow,
    };
  }).filter((r) => r.startBal || r.endBal || r.netFlowUsd);

  const netFlow = tokenRows.reduce((s, r) => s + r.netFlowUsd, 0);
  const pnl = end.total - start.total - netFlow;
  // an account whose chain was cut off by fetch depth before "from" means we
  // may be missing events inside the window → flag insufficient coverage
  const truncated = chains.some((c) => {
    if (c.blocks.length < HIST_CHAIN_DEPTH) return false;
    const oldest = Math.min(...c.blocks.map((b) => new Date(b.date).getTime()));
    return oldest > fromMs;
  });
  const chainStart = chains.reduce((min, c) => {
    const dates = c.blocks.map((b) => new Date(b.date).getTime()).filter((x) => !Number.isNaN(x));
    return dates.length ? Math.min(min, ...dates) : min;
  }, Infinity);

  return S({
    from: from.toISOString(), to: to.toISOString(),
    clamped, truncated,
    chainStart: Number.isFinite(chainStart) ? new Date(chainStart).toISOString() : null,
    points: points.map((p) => ({ t: p.t, total: p.total })),
    summary: {
      startTotal: start.total, endTotal: end.total,
      netFlowUsd: netFlow, pnl, pnlPct: start.total > 0 ? (pnl / (start.total + Math.max(0, netFlow))) * 100 : null,
      unpricedTokens: tokenRows.filter((r) => r.priceKind === 'unpriced').length,
    },
    tokens: tokenRows,
  });
}


export async function priceFor(tokenAddr) {
  if (tokenAddr === KTA_TOKEN()) {
    const m = await marketData().catch(() => null);
    return m?.price ?? (await ksPrice().catch(() => null))?.priceUsd ?? null;
  }
  if (tokenAddr === USDC_TOKEN) return 1.0;
  if (tokenAddr === EUR_TOKEN) {
    const rates = await fiatUsdRates().catch(() => null);
    return rates?.EUR ?? null;
  }
  const reg = await tokenRegistry().catch(() => null);
  const entry = reg?.get(tokenAddr);
  if (entry) {
    if (entry.code?.toUpperCase() === 'CBTC' || entry.code === 'BTC' || entry.code === 'BTCB') {
      return await cgSimple('bitcoin').catch(() => null);
    }
    if (entry.currency && entry.kind !== 'asset') {
      const rates = await fiatUsdRates().catch(() => null);
      if (rates?.[entry.currency] != null) return rates[entry.currency];
    }
  }
  return null;
}

/* ---------------- market data (CoinGecko) ---------------- */
export async function marketData() {
  return cached('market', 60_000, async () => {
    const [coinRes, chartRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/coins/keeta?localization=false&tickers=false&community_data=false&developer_data=false'),
      fetch('https://api.coingecko.com/api/v3/coins/keeta/market_chart?vs_currency=usd&days=7').catch(() => null),
    ]);
    if (!coinRes.ok) throw new Error(`CoinGecko ${coinRes.status}`);
    const j = await coinRes.json();
    const m = j.market_data || {};
    let sparkline = [];
    try {
      if (chartRes?.ok) {
        const c = await chartRes.json();
        sparkline = (c.prices || []).map(([t, p]) => [t, p]);
      }
    } catch { /* optional */ }
    const dex = await ksPrice().catch(() => null);
    return {
      price: m.current_price?.usd ?? null,
      marketCap: m.market_cap?.usd ?? null,
      volume24h: m.total_volume?.usd ?? null,
      change24h: m.price_change_percentage_24h_in_currency?.usd ?? m.price_change_percentage_24h ?? null,
      change7d: m.price_change_percentage_7d_in_currency?.usd ?? null,
      change30d: m.price_change_percentage_30d_in_currency?.usd ?? null,
      high24h: m.high_24h?.usd ?? null,
      low24h: m.low_24h?.usd ?? null,
      ath: m.ath?.usd ?? null,
      atl: m.atl?.usd ?? null,
      circulating: m.circulating_supply ?? null,
      total: m.total_supply ?? null,
      max: m.max_supply ?? null,
      rank: j.market_cap_rank ?? null,
      dex,
      sparkline,
      lastUpdated: m.last_updated ?? null,
    };
  });
}

/* ---------------- portfolio lookup ---------------- */
const MAX_ADDRESSES = 60;

export async function lookupAddresses(addresses) {
  const uniq = [...new Set(addresses.filter(isAddress))].slice(0, MAX_ADDRESSES);
  const { client } = state();
  const accounts = await Promise.all(uniq.map(async (address) => {
    const acct = KeetaNet.lib.Account.fromPublicKeyString(address);
    const keyType = acct.keyType;
    const type = KeetaNet.lib.Account.AccountKeyAlgorithm[keyType] ?? String(keyType);
    const username = await ksUsername(address).catch(() => null);

    const [infoRes, balancesRes] = await Promise.all([
      withTimeout(client.getAccountInfo(acct), 15000, 'account info')
        .then((i) => S(i))
        .catch(() => null),
      withTimeout(client.getAllBalances(acct).then(S), 15000, 'balances').catch(() => []),
    ]);

    const exists = infoRes != null;
    const tokenAddrs = [...new Set((balancesRes || []).map((b) => b.token))];
    const metas = await Promise.all(tokenAddrs.map((t) => tokenMeta(t).catch(() => null)));
    const metaBy = Object.fromEntries(metas.filter(Boolean).map((m) => [m.address, m]));

    const balances = await Promise.all((balancesRes || []).map(async (b) => {
      const decimals = metaBy[b.token]?.decimals ?? 18;
      const amount = Number(b.balance) / Math.pow(10, decimals);
      const price = await priceFor(b.token).catch(() => null);
      const meta = metaBy[b.token] ?? { address: b.token, name: null, description: null, decimals, logo: null, supply: null };
      return {
        ...meta,
        raw: String(b.balance),
        amount,
        price,
        value: price != null ? amount * price : null,
        isKta: b.token === KTA_TOKEN(),
        known: b.token === KTA_TOKEN() || b.token === USDC_TOKEN || b.token === EUR_TOKEN,
      };
    }));

    return {
      address,
      keyType,
      type,
      username,
      isToken: type === 'TOKEN',
      isStorage: type === 'STORAGE',
      exists,
      name: infoRes?.info?.name ?? null,
      description: infoRes?.info?.description ?? null,
      representative: infoRes?.representative ?? null,
      headBlock: infoRes?.currentHeadBlock ?? null,
      headHeight: infoRes?.currentHeadBlockHeight ?? null,
      balances: balances.sort((a, b) => (b.value ?? -1) - (a.value ?? -1)),
      totalUsd: balances.reduce((a, b) => a + (b.value ?? 0), 0) || null,
    };
  }));
  return { accounts, ktaAddress: KTA_TOKEN() };
}

/* ---------------- storage accounts known to an account (via ACLs) ---------------- */
/* An ACL entry means the account has SOME permission on the entity — it does
   NOT mean the account created it. To answer "who owns this?", we read the
   storage account's own ACL (by-entity) and look for the OWNER bit. */
export async function ownedStorageAccounts(addresses) {
  const userSet = new Set(addresses.filter(isAddress));
  const uniq = [...userSet].slice(0, MAX_ADDRESSES);
  const { client } = state();
  const results = await Promise.all(uniq.map(async (address) => {
    try {
      const acls = await withTimeout(client.listACLsByPrincipal(KeetaNet.lib.Account.fromPublicKeyString(address)).then(S), 15000, 'acls');
      const perEntity = new Map();
      for (const acl of acls || []) {
        if (!acl?.entity) continue;
        const perms = decodeBaseBitfield(acl.permissions?.[0] ?? 0);
        const cur = perEntity.get(acl.entity) || [];
        perEntity.set(acl.entity, [...new Set([...cur, ...perms])]);
      }
      const storage = [...perEntity.entries()]
        .filter(([e]) => { try { return KeetaNet.lib.Account.fromPublicKeyString(e).keyType === 4; } catch { return false; } })
        .map(([e, perms]) => ({ address: e, permissions: perms }));
      const others = [...perEntity.keys()].filter((e) => !storage.some((s) => s.address === e));
      return { address, storage, others };
    } catch {
      return { address, storage: [], others: [] };
    }
  }));

  const storageMap = new Map();
  for (const r of results) for (const s of r.storage) {
    const cur = storageMap.get(s.address) || { address: s.address, permissions: [], heldBy: [] };
    cur.permissions = [...new Set([...cur.permissions, ...s.permissions])];
    if (!cur.heldBy.includes(r.address)) cur.heldBy.push(r.address);
    storageMap.set(s.address, cur);
  }
  const storageAddrs = [...storageMap.keys()].slice(0, 40);

  const enriched = await Promise.all(storageAddrs.map(async (addr) => {
    const [lookup, ownerRes] = await Promise.all([
      lookupAddresses([addr]).then((r) => r.accounts[0]).catch(() => null),
      (async () => {
        try {
          const entityAcls = S(await withTimeout(client.listACLsByEntity(KeetaNet.lib.Account.fromPublicKeyString(addr)), 15000, 'entity acls'));
          let owner = null;
          for (const acl of entityAcls || []) {
            const flags = decodeBaseBitfield(acl.permissions?.[0] ?? 0);
            if (flags.includes('OWNER') && acl.principal) owner = acl.principal;
          }
          let ownerName = null;
          if (owner) {
            try {
              const oi = S(await withTimeout(client.getAccountInfo(KeetaNet.lib.Account.fromPublicKeyString(owner)), 12000, 'owner info'));
              ownerName = oi?.info?.name ?? null;
            } catch { /* ignore */ }
          }
          return owner ? { address: owner, name: ownerName, isYours: userSet.has(owner) } : null;
        } catch {
          return null;
        }
      })(),
    ]);
    return {
      ...storageMap.get(addr),
      balances: lookup?.balances ?? [],
      totalUsd: lookup?.totalUsd ?? null,
      owner: ownerRes,
    };
  }));

  return {
    byOwner: results.map((r) => ({ address: r.address, storage: r.storage.map((s) => s.address), others: r.others })),
    storageAccounts: enriched,
  };
}

/* ---------------- account activity (merged chains) ---------------- */
export async function activityFor(addresses, depth = 12) {
  const uniq = [...new Set(addresses.filter(isAddress))].slice(0, MAX_ADDRESSES);
  const { client } = state();
  const per = await Promise.all(uniq.map(async (address) => {
    try {
      const chain = await withTimeout(client.getChain(KeetaNet.lib.Account.fromPublicKeyString(address), { depth }), 12000, 'chain');
      return S(chain).map((blk) => ({
        hash: blk?.$hash ?? null,
        date: blk?.date ?? null,
        account: address,
        operations: (blk?.operations || []).map((o) => ({
          type: o.type,
          typeLabel: KeetaNet.lib.Block.OperationType[o.type] ?? String(o.type),
          to: o.to ?? null,
          token: o.token ?? null,
          amount: o.amount ?? null,
        })),
      }));
    } catch {
      return [];
    }
  }));
  const merged = per.flat().filter((b) => b.date).sort((a, b) => new Date(b.date) - new Date(a.date));
  return { blocks: merged.slice(0, 50) };
}

/* ---------------- network snapshot ---------------- */
export async function networkSnapshot() {
  const { client } = state();
  const [status, reps, version, supply] = await Promise.all([
    withTimeout(client.getNetworkStatus(8000), 12000, 'network status'),
    withTimeout(client.getAllRepresentativeInfo(), 10000, 'representatives'),
    cached('version', 60_000, () => withTimeout(client.getVersion(), 8000, 'version')),
    cached('supply', 300_000, () => withTimeout(client.getTokenSupply(state().uc.baseToken), 10000, 'supply')),
  ]);

  const repWeights = S(reps);
  const totalWeight = repWeights.reduce((a, r) => a + BigInt(r.weight || 0), 0n);
  const statusJ = S(status);
  const ledgers = (Array.isArray(statusJ) ? statusJ : [])
    .filter((s) => s && s.ledger)
    .map((s) => ({
      moment: s.ledger.moment,
      blockCount: s.ledger.blockCount,
      transactionCount: s.ledger.transactionCount,
      representativeCount: s.ledger.representativeCount,
      dbRetries: s.ledger.db?.retries ?? null,
      settlementTimes: s.ledger.settlementTimes || null,
      online: s.online !== false,
      rep: s.rep?.key ?? null,
    }));

  let peers = null;
  try {
    const p = S(await withTimeout(client.getPeers(), 8000, 'peers'));
    peers = p?.peers?.length ?? null;
  } catch { /* ignore */ }

  const settled = ledgers.find((l) => l.settlementTimes) || null;
  return S({
    network: NETWORK,
    fetchedAt: Date.now(),
    ledgers,
    reps: repWeights.map((r) => ({ ...r, share: totalWeight > 0n ? Number(BigInt(r.weight) * 10000n / totalWeight) / 100 : null })),
    totalWeight: totalWeight.toString(),
    version: version?.node ?? version ?? null,
    peers,
    baseToken: {
      address: KTA_TOKEN(),
      name: 'KTA',
      description: 'Keeta',
      supplyRaw: String(supply),
      supply: Number(supply) / 1e18,
      decimals: 18,
    },
    networkAddress: state().uc.networkAddress.publicKeyString.get(),
    settlementTimes: settled?.settlementTimes ?? null,
    transactionCount: ledgers.reduce((a, l) => Math.max(a, l.transactionCount || 0), 0),
    blockCount: ledgers.reduce((a, l) => Math.max(a, l.blockCount || 0), 0),
  });
}

/* ---------------- recent staples feed ---------------- */
const feedState = { list: [], seen: new Set(), lastFetch: 0, seeded: false };

export async function recentFeed(limit = 60) {
  const { client } = state();
  if (Date.now() - feedState.lastFetch >= 3500) {
    feedState.lastFetch = Date.now();
    try {
      const windowMs = feedState.seeded ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const staples = await withTimeout(client.getVoteStaplesAfter(new Date(Date.now() - windowMs), 50), 10000, 'staples');
      feedState.seeded = true;
      for (const s of staples) {
        for (const b of (s.blocks ?? [])) {
          const hash = b.$hash || null;
          const id = hash + (b.idempotent ?? '');
          if (!id || feedState.seen.has(id)) continue;
          feedState.seen.add(id);
          feedState.list.unshift({
            hash,
            date: b.date,
            account: typeof b.account === 'string' ? b.account : b.account?.publicKeyString?.get?.() ?? null,
            purpose: b.purpose,
            operations: (b.operations || []).map((o) => ({
              type: o.type,
              typeLabel: KeetaNet.lib.Block.OperationType[o.type] ?? String(o.type),
              to: typeof o.to === 'string' ? o.to : o.to?.publicKeyString?.get?.() ?? null,
              token: typeof o.token === 'string' ? o.token : o.token?.publicKeyString?.get?.() ?? null,
              amount: typeof o.amount === 'bigint' ? o.amount.toString() : (o.amount != null ? String(o.amount) : null),
            })),
          });
        }
      }
      if (feedState.list.length > 200) feedState.list.length = 200;
      if (feedState.seen.size > 4000) {
        feedState.seen.clear();
        feedState.list.forEach((b) => b.hash && feedState.seen.add(b.hash));
      }
    } catch { /* best-effort */ }
  }
  return { blocks: feedState.list.slice(0, limit), fetchedAt: Date.now() };
}
