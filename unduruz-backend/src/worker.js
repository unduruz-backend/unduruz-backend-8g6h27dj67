// The agent loop. Drafts work, never publishes it.
// Run under systemd:  systemctl --user start unduruz-worker
import { config } from './config.js';
import { q, logEvent } from './db.js';
import { ask, askJSON } from './claude.js';
import { policyBlock, TASK_KINDS, kindByCat } from './policy.js';
import { claim, finish, fail, enqueue } from './queue.js';
import { summarise } from './chat.js';
import { generate as genImage, promptFor, imagesEnabled } from './images.js';
import { build as buildFile } from './files.js';
import { makeMockups } from './mockups.js';
import { checkDuplicate, dedupeEnabled } from './dedupe.js';
import { push } from './notify.js';

const AGENTS = ['Lin', 'Otto', 'Priya', 'Zeke'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a));

// ---- guard rails -------------------------------------------------------
async function pendingReviewCount() {
  const { rows } = await q(`SELECT count(*)::int AS n FROM tasks WHERE status IN ('review','rework')`);
  return rows[0].n;
}
async function draftsToday() {
  const { rows } = await q(`SELECT drafts FROM usage_day WHERE day = CURRENT_DATE`);
  return rows[0] ? rows[0].drafts : 0;
}
async function bumpDrafts() {
  await q(
    `INSERT INTO usage_day (day, drafts) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET drafts = usage_day.drafts + 1`
  );
}

// ---- handlers ----------------------------------------------------------

// Create a task. Either from your order, or self-directed when idle.
async function handleCreateTask(payload) {
  const pendings = await pendingReviewCount();
  if (pendings >= config.maxPendingReview) {
    await logEvent('HQ', 'Paused: ' + pendings + ' drafts already waiting on you', 'pause');
    return;
  }
  const used = await draftsToday();
  if (used >= config.dailyDraftLimit) {
    await logEvent('HQ', 'Daily draft limit reached (' + used + ')', 'pause');
    return;
  }

  let kind = payload.category ? kindByCat(payload.category) : null;
  let title = payload.title || null;

  // An order in plain words becomes a niche-specific task.
  if (payload.order) {
    try {
      const j = await askJSON({
        cheap: true,
        maxTokens: 250,
        system:
          policyBlock() +
          '\n\nYou convert a manager order into one small, NICHE-SPECIFIC task. ' +
          'The title must name a specific audience, not a broad category. ' +
          'Reply with ONLY JSON, no markdown fences: ' +
          '{"title":"<max 9 words>","category":"<one of: ' +
          TASK_KINDS.map((k) => k.cat).join(', ') + '>"}',
        user: 'Order: ' + payload.order,
      });
      title = j.title || title;
      kind = kindByCat(j.category) || kind;
    } catch (e) {
      await logEvent('HQ', 'Could not parse order, using it verbatim', 'warn');
    }
  }

  kind = kind || pick(TASK_KINDS);
  title = title || pick(kind.titles);
  const agent = payload.agent || pick(AGENTS);
  const [lo, hi] = kind.valueCents;

  const { rows } = await q(
    `INSERT INTO tasks (title, category, channel, brief, disclosure, agent,
                        status, est_value_cents, source)
     VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8) RETURNING id`,
    [title, kind.cat, kind.channel, kind.brief, JSON.stringify(kind.disclosure),
     agent, hi > 0 ? randInt(lo, hi) : 0, payload.order ? 'order' : 'auto']
  );
  const id = rows[0].id;
  await logEvent(agent, 'Started "' + title + '"', 'task');
  await enqueue('draft_task', { taskId: id });
}

async function handleDraftTask(payload) {
  const { rows } = await q(`SELECT * FROM tasks WHERE id = $1`, [payload.taskId]);
  const t = rows[0];
  if (!t) return;

  await q(`UPDATE tasks SET status='drafting', updated_at=now() WHERE id=$1`, [t.id]);
  await logEvent(t.agent, 'Drafting "' + t.title + '"', 'draft');

  const disclosure = (t.disclosure || []).map((d) => '- ' + d).join('\n');
  const out = await ask({
    maxTokens: 1000,
    system:
      policyBlock() +
      '\n\nYou are ' + t.agent + ', a board member at Unduruz Industries, a ' +
      'small Australian digital business. You produce concise, genuinely ' +
      'useful work with a specific point of view. No preamble, no apologies. ' +
      'Short headings and bullets. Under 450 words.\n\n' +
      'End with a section titled "Compliance notes" listing exactly what must ' +
      'be disclosed and checked before this is published.',
    user:
      t.brief + '\n\nTask: ' + t.title + '\nCategory: ' + t.category +
      '\nPublishing channel: ' + (t.channel || 'internal') +
      '\nRequired disclosures for this channel:\n' + disclosure +
      '\n\nProduce the actual deliverable now.',
  });

  await q(
    `UPDATE tasks SET output=$2, status='review', updated_at=now() WHERE id=$1`,
    [t.id, out]
  );
  await bumpDrafts();
  await logEvent(t.agent, '"' + t.title + '" is ready for your review', 'review');

  // Near-duplicate check before you waste time reading it.
  let dupe = null;
  if (dedupeEnabled()) {
    try { dupe = await checkDuplicate({ ...t, output: out }); }
    catch (e) { await logEvent(t.agent, 'Dupe check skipped: ' + e.message, 'warn'); }
  }
  if (dupe) {
    await logEvent(t.agent,
      'Looks ' + Math.round(dupe.score * 100) + '% like "' + dupe.title + '"', 'warn');
  }

  // The actual sellable file, for things a customer downloads.
  if (['Niche Digital Product', 'Ops & Research'].includes(t.category)) {
    await enqueue('make_file', { taskId: t.id });
  }

  // A picture helps you judge the draft. Optional, and never blocking.
  const visual = ['Niche Digital Product', 'Short-Form Video', 'Marketing Asset'];
  if (imagesEnabled() && visual.includes(t.category)) {
    await enqueue('make_image', { taskId: t.id });
  }

  await push(
    'Draft ready for review',
    t.agent + ' finished "' + t.title + '"' +
      (dupe ? '\n\nHeads up: similar to "' + dupe.title + '"' : ''),
    { tags: dupe ? 'warning' : 'memo',
      click: config.publicUrl ? config.publicUrl + '/game' : undefined }
  );
}

async function handleMakeFile(payload) {
  const { rows } = await q(`SELECT * FROM tasks WHERE id = $1`, [payload.taskId]);
  const t = rows[0];
  if (!t) return;
  try {
    const rel = await buildFile(t);
    await logEvent(t.agent, 'Built the file for "' + t.title + '"', 'file');
    console.log('[worker] file', rel);
  } catch (e) {
    await logEvent(t.agent, 'File build failed: ' + e.message, 'warn');
  }
}

async function handleMakeImage(payload) {
  const { rows } = await q(`SELECT * FROM tasks WHERE id = $1`, [payload.taskId]);
  const t = rows[0];
  if (!t) return;
  try {
    const prompt = payload.prompt || (await promptFor(t));
    const rel = await genImage(t.id, prompt);
    await logEvent(t.agent, 'Made an image for "' + t.title + '"', 'image');
    try {
      await makeMockups(t.id, rel, t.title);
      await logEvent(t.agent, 'Cut mockups at platform sizes', 'image');
    } catch (e) {
      await logEvent(t.agent, 'Mockups skipped: ' + e.message, 'warn');
    }
  } catch (e) {
    // Never fail a task over a picture.
    await logEvent(t.agent, 'Image skipped: ' + e.message, 'warn');
  }
}

async function handleRework(payload) {
  const { rows } = await q(`SELECT * FROM tasks WHERE id = $1`, [payload.taskId]);
  const t = rows[0];
  if (!t) return;
  await logEvent(t.agent, 'Reworking "' + t.title + '"', 'draft');

  const out = await ask({
    maxTokens: 1000,
    system:
      policyBlock() +
      '\n\nYou are ' + t.agent + ' at Unduruz Industries. The owner sent this ' +
      'work back. Address their note directly. Make it more specific, more ' +
      'genuinely useful, and more clearly niche. Under 450 words. ' +
      'End with "Compliance notes".',
    user:
      'Task: ' + t.title +
      "\nOwner's note: " + (t.review_note || '(none given)') +
      '\n\nPrevious draft:\n' + (t.output || '(none)'),
  });

  await q(
    `UPDATE tasks SET output=$2, status='review', updated_at=now() WHERE id=$1`,
    [t.id, out]
  );
  await bumpDrafts();
  await logEvent(t.agent, 'Resubmitted "' + t.title + '"', 'review');
}

// A briefing built from real rows, not vibes.
async function handleBriefing() {
  const active = (await q(
    `SELECT title, category, agent, status FROM tasks
     WHERE status IN ('queued','drafting','review','rework') ORDER BY id DESC LIMIT 12`
  )).rows;
  const approved = (await q(
    `SELECT title, est_value_cents FROM tasks WHERE status IN ('approved','published')
     ORDER BY approved_at DESC NULLS LAST LIMIT 8`
  )).rows;
  const realRows = (await q(
    `SELECT coalesce(sum(amount_cents),0)::int AS cents, count(*)::int AS n FROM sales`
  )).rows[0];

  const money = (c) => '$' + (c / 100).toFixed(2);
  const state =
    'Real revenue received: ' + money(realRows.cents) + ' across ' + realRows.n + ' sales\n' +
    'Approved but unsold (projected only): ' +
      money(approved.reduce((s, r) => s + r.est_value_cents, 0)) + '\n' +
    'In flight:\n' +
      (active.length
        ? active.map((r) => '- ' + r.agent + ': ' + r.title + ' [' + r.status + ']').join('\n')
        : '- none') +
    '\nRecently approved:\n' +
      (approved.length ? approved.map((r) => '- ' + r.title).join('\n') : '- none');

  const out = await ask({
    maxTokens: 850,
    system:
      policyBlock() +
      '\n\nYou are The Director of Unduruz Industries reporting to the owner, ' +
      'an Australian sole trader. Be direct and specific and use the real ' +
      'numbers given. Never inflate. Keep PROJECTED value (approved but ' +
      'unsold) strictly separate from REAL revenue (a customer paid). Five ' +
      'short sections: Where we are, What is moving, What is stuck, ' +
      'Compliance watch, What I would do next. Under 260 words. No preamble.',
    user: 'Current company state:\n' + state,
  });
  await q(`INSERT INTO events (actor, text, icon) VALUES ('Director', $1, 'briefing')`, [out]);
  await logEvent('Director', 'Briefing ready', 'briefing');
}

// Self-directed work, but only inside the guard rails.
async function handleTick() {
  const pendings = await pendingReviewCount();
  const used = await draftsToday();
  if (pendings < config.maxPendingReview && used < config.dailyDraftLimit) {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM tasks WHERE status IN ('queued','drafting')`
    );
    if (rows[0].n < 2) await enqueue('create_task', {});
  }
  await enqueue('tick', {}, 900);   // every 15 minutes
}

async function handleSummarise(payload) {
  if (!payload.agent) return;
  await summarise(payload.agent);
  await logEvent(payload.agent, 'Consolidated older conversation into memory', 'memory');
}

const HANDLERS = {
  make_file: handleMakeFile,
  make_image: handleMakeImage,
  summarise_agent: handleSummarise,
  create_task: handleCreateTask,
  draft_task: handleDraftTask,
  rework_task: handleRework,
  briefing: handleBriefing,
  tick: handleTick,
};

async function loop() {
  for (;;) {
    let job = null;
    try {
      job = await claim();
      if (!job) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      const fn = HANDLERS[job.type];
      if (!fn) throw new Error('Unknown job type: ' + job.type);
      await fn(job.payload || {});
      await finish(job.id);
    } catch (err) {
      console.error('[worker]', job && job.type, err.message);
      if (job) {
        const retrying = await fail(job, err);
        if (!retrying) await logEvent('HQ', 'Job ' + job.type + ' failed: ' + err.message, 'warn');
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

// Make sure the heartbeat exists, then run.
await q(
  `INSERT INTO jobs (type, payload) SELECT 'tick', '{}'::jsonb
   WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE type='tick' AND status='pending')`
);
console.log('[worker] running');
loop();
