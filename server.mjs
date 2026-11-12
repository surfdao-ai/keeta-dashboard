/* DashKee local dev server — a thin Express wrapper around the shared logic
   in api/_lib.mjs, which is also used by the Vercel serverless functions
   (api/*.js). The two stay in sync by construction. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { networkSnapshot, recentFeed, marketData, lookupAddresses, ownedStorageAccounts, activityFor, historicalPL, fiatUsdRates, tokenRegistry, KTA_TOKEN, NETWORK, cached } from './api/_lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json({ ok: true, network: NETWORK, kta: KTA_TOKEN() }));
app.get('/api/network', async (_req, res) => {
  try { res.json(await cached('network', 2000, networkSnapshot)); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/recent', async (_req, res) => {
  try { res.json(await recentFeed(60)); }
  catch (e) { res.status(503).json({ error: e.message }); }
});
app.get('/api/market', async (_req, res) => {
  try { res.json(await marketData()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/pricing', async (_req, res) => {
  try {
    const [rates, registry] = await Promise.all([fiatUsdRates(), tokenRegistry()]);
    res.json({ rates, registry: [...registry.entries()].map(([token, v]) => ({ token, ...v })) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/lookup', async (req, res) => {
  try {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    if (!addresses.length) { res.status(400).json({ error: 'addresses[] required' }); return; }
    res.json(await lookupAddresses(addresses));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/owned', async (req, res) => {
  try {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    if (!addresses.length) { res.status(400).json({ error: 'addresses[] required' }); return; }
    res.json(await ownedStorageAccounts(addresses));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/activity', async (req, res) => {
  try {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    if (!addresses.length) { res.status(400).json({ error: 'addresses[] required' }); return; }
    res.json(await activityFor(addresses, Math.min(Number(req.body?.depth) || 12, 50)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/history', async (req, res) => {
  try {
    const addresses = Array.isArray(req.body?.addresses) ? req.body.addresses : [];
    if (!addresses.length) { res.status(400).json({ error: 'addresses[] required' }); return; }
    if (!req.body?.from || !req.body?.to) { res.status(400).json({ error: 'from and to (ISO dates) required' }); return; }
    res.json(await historicalPL(addresses, req.body.from, req.body.to));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DashKee dev server → http://localhost:${PORT} (network: ${NETWORK})`));
