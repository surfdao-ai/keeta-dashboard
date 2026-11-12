import { fiatUsdRates, tokenRegistry } from './_lib.mjs';

export default async function handler(req, res) {
  try {
    const [rates, registry] = await Promise.all([fiatUsdRates(), tokenRegistry()]);
    res.status(200).json({ rates, registry: [...registry.entries()].map(([token, v]) => ({ token, ...v })) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
