import { marketData } from './_lib.mjs';

export default async function handler(req, res) {
  try {
    res.status(200).json(await marketData());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
