import { networkSnapshot, cached } from './_lib.mjs';

export default async function handler(req, res) {
  try {
    res.status(200).json(await cached('network', 2000, networkSnapshot));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}
