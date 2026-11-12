import { recentFeed } from './_lib.mjs';

export default async function handler(req, res) {
  try {
    res.status(200).json(await recentFeed(60));
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}
