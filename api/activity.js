import { activityFor } from './_lib.mjs';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100_000) break;
  }
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST required' });
    return;
  }
  try {
    const body = await readBody(req);
    const addresses = Array.isArray(body.addresses) ? body.addresses : [];
    const depth = Math.min(Number(body.depth) || 12, 50);
    if (!addresses.length) {
      res.status(400).json({ error: 'addresses[] required' });
      return;
    }
    res.status(200).json(await activityFor(addresses, depth));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
