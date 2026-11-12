import { KTA_TOKEN, NETWORK } from './_lib.mjs';

export default async function handler(req, res) {
  res.status(200).json({ ok: true, network: NETWORK, kta: KTA_TOKEN() });
}
