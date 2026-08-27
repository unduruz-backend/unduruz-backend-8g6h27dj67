// "Have we made this before?"
//
// Fiverr bans bulk-identical delivery and YouTube demonetises mass-produced
// content, so near-duplicates are a compliance problem, not just a quality
// one. Embeddings are free on the same Cloudflare tier as the images.

import { config } from './config.js';
import { q } from './db.js';

const MODEL = '@cf/baai/bge-base-en-v1.5';
export const dedupeEnabled = () => Boolean(config.cfAccountId && config.cfApiToken);

export async function embed(text) {
  const url =
    'https://api.cloudflare.com/client/v4/accounts/' + config.cfAccountId +
    '/ai/run/' + MODEL;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.cfApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text.slice(0, 4000)] }),
  });
  if (!res.ok) throw new Error('embeddings ' + res.status);
  const j = await res.json();
  const v = j?.result?.data?.[0];
  if (!Array.isArray(v)) throw new Error('no vector returned');
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Compare a draft against everything we already committed to.
export async function checkDuplicate(task) {
  if (!dedupeEnabled()) return null;
  const vec = await embed(task.title + '\n\n' + (task.output || ''));
  await q(`UPDATE tasks SET embedding = $2 WHERE id = $1`, [task.id, JSON.stringify(vec)]);

  const { rows } = await q(
    `SELECT id, title, embedding FROM tasks
     WHERE id <> $1 AND embedding IS NOT NULL
       AND status IN ('approved','published','review')
     ORDER BY id DESC LIMIT 200`,
    [task.id]
  );

  let best = null;
  for (const r of rows) {
    const score = cosine(vec, r.embedding);
    if (!best || score > best.score) best = { id: r.id, title: r.title, score };
  }
  if (best && best.score >= config.dupeThreshold) {
    await q(`UPDATE tasks SET dupe_of = $2, dupe_score = $3 WHERE id = $1`,
      [task.id, best.id, best.score.toFixed(3)]);
    return best;
  }
  await q(`UPDATE tasks SET dupe_of = NULL, dupe_score = $2 WHERE id = $1`,
    [task.id, best ? best.score.toFixed(3) : null]);
  return null;
}
