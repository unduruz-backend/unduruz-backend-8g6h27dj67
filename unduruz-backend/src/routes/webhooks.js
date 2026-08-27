import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, logEvent } from '../db.js';
import { push } from '../notify.js';

export const webhooks = express.Router();

// Raw body is required to verify a signature; parse it ourselves.
const raw = express.raw({ type: '*/*', limit: '1mb' });

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function recordSale({ provider, externalId, cents, currency, email, product, rawBody }) {
  const { rowCount } = await q(
    `INSERT INTO sales (provider, external_id, amount_cents, currency, email, product, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider, external_id) DO NOTHING`,
    [provider, externalId, cents, currency, email, product, rawBody]
  );
  if (rowCount > 0) {
    await logEvent('Processor', 'Sale: ' + product + ' $' + (cents / 100).toFixed(2), 'sale');
    await push('Sale! $' + (cents / 100).toFixed(2), product + ' via ' + provider,
      { tags: 'moneybag', priority: 'high' });
  }
  return rowCount > 0;
}

// ---- Lemon Squeezy: HMAC-SHA256 over the raw body -----------------------
webhooks.post('/lemon', raw, async (req, res) => {
  try {
    if (!config.lemonSecret) return res.status(503).send('not configured');
    const sig = req.get('X-Signature') || '';
    const digest = crypto.createHmac('sha256', config.lemonSecret).update(req.body).digest('hex');
    if (!timingSafeEqual(digest, sig)) return res.status(401).send('bad signature');

    const evt = JSON.parse(req.body.toString('utf8'));
    const name = evt?.meta?.event_name;
    if (name === 'order_created') {
      const a = evt.data.attributes;
      await recordSale({
        provider: 'lemonsqueezy',
        externalId: String(evt.data.id),
        cents: a.total,                       // already in cents
        currency: a.currency || 'USD',
        email: a.user_email,
        product: a.first_order_item?.product_name || 'unknown',
        rawBody: evt,
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[lemon]', e.message);
    res.status(400).send('bad request');
  }
});

// ---- Gumroad Ping: no signature, so verify the seller id ----------------
webhooks.post('/gumroad', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const b = req.body || {};
    if (config.gumroadSellerId && b.seller_id !== config.gumroadSellerId) {
      return res.status(401).send('unknown seller');
    }
    await recordSale({
      provider: 'gumroad',
      externalId: String(b.sale_id || b.order_number || ''),
      cents: Number(b.price || 0),            // Gumroad sends cents
      currency: b.currency ? String(b.currency).toUpperCase() : 'USD',
      email: b.email,
      product: b.product_name || 'unknown',
      rawBody: b,
    });
    res.status(200).send('ok');               // must be 200 or Gumroad retries
  } catch (e) {
    console.error('[gumroad]', e.message);
    res.status(200).send('ok');               // never make them retry a bug
  }
});
