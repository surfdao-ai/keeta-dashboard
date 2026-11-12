import express from 'express';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const NETWORK = process.env.KEETA_NETWORK || 'main';

/* ---------------- Keeta client (read-only throwaway signer) ---------------- */
const signer = KeetaNet.lib.Account.fromSeed(KeetaNet.lib.Account.generateRandomSeed({ asString: true }), 0);
const uc = KeetaNet.UserClient.fromNetwork(NETWORK, signer);
const client = uc.client;
const KTA = uc.baseToken.publicKeyString.get();

/* Known mainnet tokens (docs.keeta.com — fiat anchors) */
const USDC_TOKEN = 'keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna'; // Keeta USD (USDC-converted)
const EUR_TOKEN = 'keeta_anutgo4o3yp5tvc6wjt4vzsehjbn7t2wylpxmam4d4ojtdkjj2yca2qoinfcs';

/* ---- ACL permission decoding (BaseFlag offsets) ---- */
const BASE_FLAGS = {
  0: 'ACCESS', 1: 'OWNER', 2: 'ADMIN', 3: 'UPDATE_INFO', 4: 'SEND_ON_BEHALF',
  5: 'TOKEN_ADMIN_CREATE', 6: 'TOKEN_ADMIN_SUPPLY', 7: 'TOKEN_ADMIN_MODIFY_BALANCE',
  8: 'STORAGE_CREATE', 9: 'STORAGE_CAN_HOLD', 10: 'STORAGE_DEPOSIT',
  11: 'PERMISSION_DELEGATE_ADD', 12: 'PERMISSION_DELEGATE_REMOVE',
  13: 'MANAGE_CERTIFICATE', 14: 'MULTISIG_SIGNER',
};
function decodeBaseBitfield(mask) {
  const flags = [];
  try {
    const n = BigInt(mask);
    for (let i = 0; i <= 14; i++) {
      if (n & (1n << BigInt(i))) flags.push(BASE_FLAGS[i] ?? 'FLAG_' + i);
    }
  } catch { /* ignore */ }
  return flags;
}
const OWNER_BIT = 1n << 1n; // OWNER is BaseFlag offset 1

/* ---------------- helpers ---------------- */
const withTimeout = (promise, ms, label = 'operation') =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms)),
  ]);

const S = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
  if (typeof x === 'bigint') return String(x);
  if (x && typeof x === 'object' && typeof x.publicKeyString?.get === 'function') return x.publicKeyString.get();
  return x;
}));

const cache = new Map();
const cached = async (key, ttlMs, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    if (hit) return hit.value;
    throw e;
  }
};

const isAddress = (s) => {
  try { KeetaNet.lib.Account.fromPublicKeyString(s); return true; } catch { return false; }
};

/* ---------------- token metadata + pricing ---------------- */
const METADATA_TTL = 5 * 60_000;

async function tokenMeta(tokenAddr) {
  return cached('tok:' + tokenAddr, METADATA_TTL, async () => {
    const reg = await tokenRegistry().catch(() => null);
    const regEntry = reg?.get(tokenAddr) ?? null;
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

async function eurUsd() {
  return cached('eurusd', 3_600_000, async () => {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD');
    if (!res.ok) throw new Error('frankfurter ' + res.status);
    const j = await res.json();
    return j.rates?.USD ?? null;
  });
}

/* ---------------- KeeSpecs (keespecs.xyz) free reads ---------------- */
const KS = 'https://keespecs.xyz';

async function ksPrice() {
  return cached('ks:price', 60_000, async () => {
    const res = await fetch(`${KS}/api/price`);
    if (!res.ok) throw new Error('keespecs price ' + res.status);
    const j = await res.json();
    return { priceUsd: j.priceUsd ?? null, change1hPct: j.change1hPct ?? null, change24hPct: j.change24hPct ?? null, source: 'keespecs/dexscreener (Base pool)', asOf: j.asOf ?? null };
  });
}

async function ksStablecoins() {
  return cached('ks:stables', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/stablecoins`);
    if (!res.ok) throw new Error('keespecs stablecoins ' + res.status);
    const j = await res.json();
    return (j.coins || []).map((c) => ({ code: c.code, currency: c.currency, token: c.token, name: c.name, decimals: c.decimals, supply: c.supply }));
  });
}

async function ksDirectory() {
  return cached('ks:dir', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/directory`);
    if (!res.ok) throw new Error('keespecs directory ' + res.status);
    const j = await res.json();
    return (j.tokens || []).map((t) => ({ code: t.code, name: t.name, token: t.token, decimals: t.decimals, supply: t.supply }));
  });
}

async function ksSupply() {
  return cached('ks:supply', 6 * 3_600_000, async () => {
    const res = await fetch(`${KS}/api/supply`);
    if (!res.ok) throw new Error('keespecs supply ' + res.status);
    const j = await res.json();
    return (j.assets || []).map((a) => ({ code: a.code, token: a.token, name: a.name, decimals: a.decimals, supply: a.supply }));
  });
}

async function ksUsername(address) {
  return cached('ks:user:' + address, 10 * 60_000, async () => {
    const res = await fetch(`${KS}/api/username?account=${encodeURIComponent(address)}`);
    if (!res.ok) return null;
    const j = await res.json();
    return j.username || j.global_username || null;
  });
}

/* USD value of one unit of a fiat currency (peg rates) */
const STATIC_USD_FIAT = { AED: 1 / 3.6725 }; // hard peg, not in ECB list
async function fiatUsdRates() {
  return cached('fiat', 3_600_000, async () => {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,JPY,CNY,GBP,CAD,MXN,HKD');
    if (!res.ok) throw new Error('frankfurter ' + res.status);
    const j = await res.json();
    const inv = {};
    for (const [cur, rate] of Object.entries(j.rates || {})) inv[cur] = 1 / rate;
    return { ...inv, ...STATIC_USD_FIAT };
  });
}

/* token address → { price source } registry built from KeeSpecs reads */
async function tokenRegistry() {
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

async function priceFor(tokenAddr) {
  if (tokenAddr === KTA) {
    const m = await marketData().catch(() => null);
    return m?.price ?? (await ksPrice().catch(() => null))?.priceUsd ?? null;
  }
  if (tokenAddr === USDC_TOKEN) return 1.0; // USD-pegged (USDC-converted)
  if (tokenAddr === EUR_TOKEN) return await eurUsd().catch(() => null);
  const reg = await tokenRegistry().catch(() => null);
  const entry = reg?.get(tokenAddr);
  if (entry) {
    if (entry.code === 'BTC' || entry.code === 'BTCB' || entry.code?.toUpperCase() === 'CBTC') {
      const btc = await cgSimple('bitcoin').catch(() => null);
      return btc;
    }
    if (entry.currency && entry.kind !== 'asset') {
      const rates = await fiatUsdRates().catch(() => null);
      if (rates?.[entry.currency] != null) return rates[entry.currency];
    }
  }
  return null;
}

async function cgSimple(id) {
  return cached('cg:' + id, 5 * 60_000, async () => {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error('coingecko ' + res.status);
    const j = await res.json();
    return j[id]?.usd ?? null;
  });
}

/* ---------------- portfolio lookup ---------------- */
const MAX_ADDRESSES = 60;

async function lookupAddresses(addresses) {
  const uniq = [...new Set(addresses.filter(isAddress))].slice(0, MAX_ADDRESSES);
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
        isKta: b.token === KTA,
        known: b.token === KTA || b.token === USDC_TOKEN || b.token === EUR_TOKEN,
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
  return { accounts, ktaAddress: KTA };
}

/* ---------------- storage accounts known to an account (via ACLs) ---------------- */
/* An ACL entry means the account has SOME permission on the entity — it does
   NOT mean the account created it. To answer "who owns this?", we read the
   storage account's own ACL (by-entity) and look for the OWNER bit. */
async function ownedStorageAccounts(addresses) {
  const userSet = new Set(addresses.filter(isAddress));
  const uniq = [...userSet].slice(0, MAX_ADDRESSES);
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

  // Fetch balances + owner for every storage account discovered
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
async function activityFor(addresses, depth = 12) {
  const uniq = [...new Set(addresses.filter(isAddress))].slice(0, MAX_ADDRESSES);
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

/* ---------------- network snapshot (Network tab) ---------------- */
async function networkSnapshot() {
  const [status, reps, version, supply] = await Promise.all([
    withTimeout(client.getNetworkStatus(8000), 12000, 'network status'),
    withTimeout(client.getAllRepresentativeInfo(), 10000, 'representatives'),
    cached('version', 60_000, () => withTimeout(client.getVersion(), 8000, 'version')),
    cached('supply', 300_000, () => withTimeout(client.getTokenSupply(uc.baseToken), 10000, 'supply')),
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
      address: KTA,
      name: 'KTA',
      description: 'Keeta',
      supplyRaw: String(supply),
      supply: Number(supply) / 1e18,
      decimals: 18,
    },
    networkAddress: uc.networkAddress.publicKeyString.get(),
    settlementTimes: settled?.settlementTimes ?? null,
    transactionCount: ledgers.reduce((a, l) => Math.max(a, l.transactionCount || 0), 0),
    blockCount: ledgers.reduce((a, l) => Math.max(a, l.blockCount || 0), 0),
  });
}

/* ---------------- market data (CoinGecko) ---------------- */
async function marketData() {
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

/* ---------------- recent staples feed (Network tab) ---------------- */
const recentFeed = [];
const seenStaples = new Set();
let feedLastFetch = 0;
let feedSeeded = false;

async function refreshFeed() {
  if (Date.now() - feedLastFetch < 3500) return;
  feedLastFetch = Date.now();
  try {
    const windowMs = feedSeeded ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const staples = await withTimeout(client.getVoteStaplesAfter(new Date(Date.now() - windowMs), 50), 10000, 'staples');
    feedSeeded = true;
    for (const s of staples) {
      for (const b of (s.blocks ?? [])) {
        const hash = b.$hash || null;
        const id = hash + (b.idempotent ?? '');
        if (!id || seenStaples.has(id)) continue;
        seenStaples.add(id);
        recentFeed.unshift({
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
    if (recentFeed.length > 200) recentFeed.length = 200;
    if (seenStaples.size > 4000) {
      seenStaples.clear();
      recentFeed.forEach((b) => b.hash && seenStaples.add(b.hash));
    }
  } catch { /* best-effort */ }
}

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const asAddresses = (body) => {
  const arr = Array.isArray(body?.addresses) ? body.addresses : [];
  return arr.map((a) => String(a || '').trim()).filter(Boolean);
};

app.post('/api/lookup', async (req, res) => {
  try {
    res.json(await lookupAddresses(asAddresses(req.body)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/owned', async (req, res) => {
  try {
    res.json(await ownedStorageAccounts(asAddresses(req.body)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/activity', async (req, res) => {
  try {
    res.json(await activityFor(asAddresses(req.body)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/network', async (req, res) => {
  try {
    res.json(await cached('network', 2000, networkSnapshot));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.get('/api/recent', async (req, res) => {
  await refreshFeed();
  res.json({ blocks: recentFeed.slice(0, 60), fetchedAt: Date.now() });
});

app.get('/api/market', async (req, res) => {
  try {
    res.json(await marketData());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/pricing', async (req, res) => {
  try {
    const [rates, registry] = await Promise.all([fiatUsdRates(), tokenRegistry()]);
    res.json({ rates, registry: [...registry.entries()].map(([token, v]) => ({ token, ...v })) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, network: NETWORK, kta: KTA }));

app.get('/vendor/echarts.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/echarts/dist/echarts.min.js'))
);

process.on('SIGINT', () => { uc.destroy?.(); process.exit(0); });
process.on('SIGTERM', () => { uc.destroy?.(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`DashKee dashboard listening on http://localhost:${PORT} (network: ${NETWORK})`);
});
