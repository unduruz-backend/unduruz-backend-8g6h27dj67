import express from 'express';
import { config } from '../config.js';
import { q, logEvent } from '../db.js';
import { enqueue } from '../queue.js';
import { reply, history, isAgent } from '../chat.js';

export const api = express.Router();

// Single shared token. The service binds to localhost and is reached over
// Tailscale, so this is a second lock rather than the only one.
api.use((req, res, next) => {
  const hdr = req.get('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : req.query.token;
  if (token !== config.dashboardToken) return res.status(401).json({ error: 'unauthorized' });
  next();
});

api.get('/state', async (_req, res) => {
  const tasks = (await q(
    `SELECT id,title,category,channel,agent,status,disclosure,est_value_cents,
            output,review_note,created_at,dupe_of,dupe_score
     FROM tasks WHERE status <> 'archived' ORDER BY id DESC LIMIT 60`
  )).rows;
  const events = (await q(
    `SELECT actor,text,icon,created_at FROM events
     WHERE icon <> 'briefing' ORDER BY id DESC LIMIT 60`
  )).rows;
  const briefing = (await q(
    `SELECT text,created_at FROM events WHERE icon='briefing' ORDER BY id DESC LIMIT 1`
  )).rows[0] || null;
  const sales = (await q(
    `SELECT provider,product,amount_cents,currency,email,created_at
     FROM sales ORDER BY id DESC LIMIT 40`
  )).rows;
  const totals = (await q(
    `SELECT coalesce(sum(amount_cents),0)::int AS real_cents, count(*)::int AS n FROM sales`
  )).rows[0];
  const usage = (await q(
    `SELECT * FROM usage_day WHERE day = CURRENT_DATE`
  )).rows[0] || { drafts: 0, images: 0, input_tokens: 0, output_tokens: 0 };
  const assets = (await q(
    `SELECT id, task_id, path, prompt FROM assets ORDER BY id DESC LIMIT 80`
  )).rows;

  res.json({
    tasks, events, briefing, sales, totals, usage, assets,
    limits: { maxPendingReview: config.maxPendingReview, dailyDraftLimit: config.dailyDraftLimit },
  });
});

api.post('/tasks/:id/approve', async (req, res) => {
  const { rowCount } = await q(
    `UPDATE tasks SET status='approved', approved_at=now(), updated_at=now()
     WHERE id=$1 AND status='review'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(409).json({ error: 'not awaiting review' });
  const t = (await q(`SELECT title FROM tasks WHERE id=$1`, [req.params.id])).rows[0];
  await logEvent('You', 'Approved "' + t.title + '"', 'approve');
  res.json({ ok: true });
});

api.post('/tasks/:id/rework', async (req, res) => {
  const note = (req.body?.note || '').slice(0, 1000);
  const { rowCount } = await q(
    `UPDATE tasks SET status='rework', review_note=$2, updated_at=now()
     WHERE id=$1 AND status='review'`,
    [req.params.id, note]
  );
  if (!rowCount) return res.status(409).json({ error: 'not awaiting review' });
  await enqueue('rework_task', { taskId: Number(req.params.id) });
  await logEvent('You', 'Sent task ' + req.params.id + ' back for rework', 'rework');
  res.json({ ok: true });
});

// Mark approved work as actually published, once YOU have posted it.
api.post('/tasks/:id/published', async (req, res) => {
  const { rowCount } = await q(
    `UPDATE tasks SET status='published', published_at=now(), updated_at=now()
     WHERE id=$1 AND status='approved'`,
    [req.params.id]
  );
  if (!rowCount) return res.status(409).json({ error: 'not approved yet' });
  await logEvent('You', 'Published task ' + req.params.id, 'publish');
  res.json({ ok: true });
});

api.post('/order', async (req, res) => {
  const order = (req.body?.order || '').trim();
  if (!order) return res.status(400).json({ error: 'order required' });
  await enqueue('create_task', { order, agent: req.body?.agent });
  await logEvent('You', 'Ordered: ' + order, 'order');
  res.json({ ok: true });
});

// ---- conversation ------------------------------------------------------
api.get('/chat/:agent', async (req, res) => {
  const { agent } = req.params;
  if (!isAgent(agent)) return res.status(404).json({ error: 'unknown agent' });
  const msgs = await history(agent, 40);
  const mem = (await q(`SELECT summary, updated_at FROM agent_memory WHERE agent=$1`, [agent])).rows[0];
  res.json({ agent, messages: msgs, memory: mem || null });
});

api.post('/chat/:agent', async (req, res) => {
  const { agent } = req.params;
  if (!isAgent(agent)) return res.status(404).json({ error: 'unknown agent' });
  const text = (req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const out = await reply(agent, text);
    await logEvent(agent, 'Replied to you', 'chat');
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Turn what you just agreed on into a tracked task.
api.post('/chat/:agent/task', async (req, res) => {
  const { agent } = req.params;
  if (!isAgent(agent)) return res.status(404).json({ error: 'unknown agent' });
  const recent = await history(agent, 6);
  const gist = recent.map((m) => (m.role === 'user' ? 'Owner: ' : 'Agent: ') + m.content).join('\n');
  await enqueue('create_task', { order: gist, agent });
  await logEvent('You', 'Turned a conversation with ' + agent + ' into a task', 'task');
  res.json({ ok: true });
});

// Ask for a fresh image on a task (optionally with your own prompt).
api.post('/tasks/:id/image', async (req, res) => {
  await enqueue('make_image', {
    taskId: Number(req.params.id),
    prompt: (req.body?.prompt || '').trim() || undefined,
  });
  res.json({ ok: true });
});

api.post('/briefing', async (_req, res) => {
  await enqueue('briefing', {});
  res.json({ ok: true });
});

export default api;
