# DashKee — Personal Keeta Dashboard

A **read-only personal dashboard** for the Keeta Network in an omarchy-style
(tokyo-night) dark theme: your accounts, subaccounts, storage accounts, assets
and stablecoins — live on mainnet, with a network-explorer tab on the side.

Installable as a **PWA** (manifest + service worker): add it to your phone's
home screen and it opens standalone with an offline shell, showing the last
successfully loaded data when the network is down. The layout is responsive
from phone to desktop.

Portfolio history is built from **local snapshots** (localStorage only — a
point is recorded each time your portfolio refreshes) and charted on the
Assets tab with a P/L summary; assets and full history export to CSV.

The Assets tab also has **Historical P&L for any past date range** (e.g.
"last month" or "all of 2026"): balances at past dates are reconstructed by
replaying each account's send/receive chain backward from its current
balance, and USD values use historical KTA/BTC prices (CoinGecko, up to 364
days) with constant peg prices for stablecoins/fiat tokens. Deposits and
withdrawals are valued separately from gains, so moving funds doesn't show
up as profit or loss.

## Data sources

- **Keeta mainnet** via `@keetanetwork/keetanet-client` (all account/chain data)
- **keespecs.xyz** (free reads): DEX pool price for KTA, the nine $KB
  stablecoins, the token/currency-map directory, cbBTC/KTA/USDC supply, and
  keeta.xyz username resolution
- **CoinGecko**: KTA price + 7-day series, BTC price (for cbBTC)
- **Frankfurter (ECB)**: fiat peg rates (EUR, JPY, CNY, GBP, CAD, MXN, HKD;
  AED hard-pegged at 3.6725)

## What it shows

**Personal banking (Overview / Accounts / Assets / Activity):**

- **Total balance hero** — USD value across all your connected accounts,
  with allocation donut and quick stats
- **Wallet accounts** — cards per account: balances, USD value, token
  chips, on-chain name/height, link to the official explorer
- **Subaccounts** — derived *in your browser* from a seed (indices 0..N);
  the seed never leaves the browser, only public `keeta_…` addresses are sent
- **Storage accounts** — discovered via on-chain access-control lists
  (`listACLsByPrincipal`, `entity.isStorage()`), with their balances.
  Each card shows your granted permissions (decoded from the ACL bitfield,
  e.g. `513` → `ACCESS + STORAGE_CAN_HOLD`) **and the true owner**, resolved
  by reading the storage account's own ACL for the `OWNER` bit. Accounts
  you don't own are marked "MANAGED"; zero-balance accounts you don't own
  collapse into an expandable list. This answers the common surprise:
  seeing many storage accounts does **not** mean you created them —
  anchors and token issuers grant your account access to storage accounts
  that hold your token balances.
- **Assets table** — every token you hold, aggregated across accounts, with
  token logos & decimals decoded from on-chain metadata (`logoURI`,
  `decimalPlaces`), live prices where known, allocation bars
- **Stablecoins** — Keeta's native USD token (USDC-converted, pegged ≈ $1)
  and EUR token (live ECB reference rate via Frankfurter)
- **Activity** — merged, sorted chain history across all accounts with
  Sent/Received amounts and operation labels
- **Identity (KYC)** — every watched account is checked for on-chain
  identity certificates (`getAllCertificates`): a green "KYC verified"
  line shows the issuing anchors (e.g. Footprint KYC, Keeta Personal)
  and the validity window. Sensitive attributes (name, DOB…) are
  encrypted on-chain and are never displayed.
- **Banking** — for KYC-verified accounts, DashKee can fetch the
  fiat-anchor checking account (US account & routing numbers for USD→USDC
  deposits, via e.g. Bridge or Keeta Personal). This runs **entirely in
  the browser**: the anchor API requires the account's signature, so the
  seed is typed per fetch, held in memory for the duration of the call,
  never stored and never sent to DashKee's server. If the account hasn't
  shared its KYC with the anchor yet, DashKee does the encrypted
  attribute share locally (the anchor only receives a commitment, not
  the raw PII).

**Network tab** (kept from the explorer build): live TPS, settlement-time
histogram with median/p90, voting-power donut, KTA 7-day price chart,
representatives, and a recent-blocks feed.

## Security model

- Everything is **read-only**; the server uses a throwaway random signer
- Seed input is processed **client-side only** with the official SDK
  (self-hosted `keetanet-browser.js`); only derived public addresses
  are transmitted, and nothing is stored server-side
- **Banking goes further**: the seed is never even *kept* for the
  session — it is used for a single anchor request and discarded
- **Strict CSP** (`script-src 'self'`, no inline script, `base-uri`,
  `form-action`, `frame-ancestors` all locked): even injected markup
  cannot execute code that could read a seed. Anchor/node endpoints
  stay reachable via `connect-src https: wss:`
- Watched addresses and derived addresses are saved in `localStorage`

## Run it

```bash
npm install
npm start          # → http://localhost:3000
```

Options: `PORT=8080 npm start` · `KEETA_NETWORK=test npm start`

## API

```
POST /api/lookup     {addresses}      info, type (standard/token/storage),
                                      balances + token metadata + prices + @usernames
POST /api/owned      {addresses}      storage accounts via ACLs, decoded
                                      permissions, and true OWNER resolution
POST /api/activity   {addresses}      merged chain history
POST /api/history    {addresses,      historical P&L for a date range:
                      from, to}       balances replayed from send/receive
                                      events, priced with historical rates
GET  /api/network                     reps, status, settlement histogram
GET  /api/recent                      recent vote-staple blocks feed
GET  /api/market                      CoinGecko KTA data + 7d series + DEX mark
GET  /api/pricing                     fiat peg rates + full token registry
```

Pricing: KTA from CoinGecko (fallback: KeeSpecs DEX pool) · USDC and KBUSD
pegged $1 · KB stablecoins & fiat tokens at peg via ECB rates (unverified
reserves) · cbBTC via BTC spot · other tokens show balance only.

## Deploy (Vercel)

The backend is split into serverless functions under `api/` sharing
`api/_lib.mjs` (a globalThis-scoped singleton client + caches, so warm
lambda instances reuse the Keeta connection and caches). `server.mjs` is a
thin Express wrapper around the same module for local dev — endpoints are
identical either way.

1. Push to GitHub (auto-deploys on every push once imported)
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. Done — no env vars needed (`KEETA_NETWORK` defaults to main)

Function limits are set in `vercel.json` (`maxDuration: 30s`). First hit
after a cold start is the slowest (SDK load + P2P connect); warm calls are
fast thanks to the in-memory caches.


