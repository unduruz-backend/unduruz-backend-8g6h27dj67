// Per-agent conversation with memory.
//
// Recent turns are kept verbatim. Older ones are folded into a rolling
// summary by a background job, so an agent still remembers a decision from
// last month without us replaying a thousand messages at it.

import { q } from './db.js';
import { ask } from './claude.js';
import { policyBlock } from './policy.js';
import { enqueue } from './queue.js';

const VERBATIM = 20;      // recent turns sent in full
const SUMMARISE_AFTER = 40;  // unsummarised turns before we condense

const PERSONAS = {
  Director:
    'You are The Director of Unduruz Industries: second-in-charge to the owner. ' +
    'You think about priorities, margins and what the team should focus on. ' +
    'Decisive, brief, happy to disagree with the owner when you think they are wrong.',
  Lin: 'You are Lin, a board member. Analytical and blunt. You like numbers and hate vague plans.',
  Otto: 'You are Otto, a board member. Creative and fast. You pitch angles others miss.',
  Priya: 'You are Priya, a board member. Careful and thorough. You catch the risks early.',
  Zeke: 'You are Zeke, a board member. Practical and shippy. You want the smallest thing that works.',
};

export function isAgent(name) {
  return Object.prototype.hasOwnProperty.call(PERSONAS, name);
}

async function memoryOf(agent) {
  const { rows } = await q(`SELECT * FROM agent_memory WHERE agent = $1`, [agent]);
  if (rows[0]) return rows[0];
  await q(`INSERT INTO agent_memory (agent) VALUES ($1) ON CONFLICT DO NOTHING`, [agent]);
  return { agent, summary: '', last_summarised_id: 0 };
}

export async function history(agent, limit = VERBATIM) {
  const { rows } = await q(
    `SELECT role, content, created_at FROM messages
     WHERE agent = $1 ORDER BY id DESC LIMIT $2`,
    [agent, limit]
  );
  return rows.reverse();
}

// What this agent is currently responsible for, so it can talk about its work.
async function workContext(agent) {
  const { rows } = await q(
    `SELECT title, category, status FROM tasks
     WHERE agent = $1 AND status <> 'archived' ORDER BY id DESC LIMIT 6`,
    [agent]
  );
  if (!rows.length) return 'You have no tasks on your plate right now.';
  return 'Your current tasks:\n' +
    rows.map((r) => '- ' + r.title + ' (' + r.category + ') [' + r.status + ']').join('\n');
}

export async function reply(agent, userText) {
  const mem = await memoryOf(agent);
  const past = await history(agent);
  const work = await workContext(agent);

  const system = [
    policyBlock(),
    '',
    PERSONAS[agent] || 'You are ' + agent + ', a board member at Unduruz Industries.',
    'Unduruz Industries is a small Australian digital business run by the owner ' +
      'you are speaking to. You draft work; the owner approves it before anything ' +
      'is published.',
    '',
    mem.summary
      ? 'What you remember from earlier conversations:\n' + mem.summary
      : 'You have not spoken with the owner before.',
    '',
    work,
    '',
    'Talk like a colleague, not a chatbot. Be concise: a few sentences unless ' +
      'asked for detail. Never invent progress or sales. If you agree to do ' +
      'something, say so plainly so it can be turned into a task.',
  ].join('\n');

  await q(`INSERT INTO messages (agent, role, content) VALUES ($1,'user',$2)`, [agent, userText]);

  const answer = await ask({
    system,
    maxTokens: 700,
    user: past.map((m) => (m.role === 'user' ? 'Owner: ' : 'You: ') + m.content)
      .concat('Owner: ' + userText)
      .join('\n\n'),
  });

  const { rows } = await q(
    `INSERT INTO messages (agent, role, content) VALUES ($1,'assistant',$2) RETURNING id`,
    [agent, answer]
  );

  // Fold older turns into the summary once there are enough of them.
  const { rows: cnt } = await q(
    `SELECT count(*)::int AS n FROM messages WHERE agent=$1 AND id > $2`,
    [agent, mem.last_summarised_id]
  );
  if (cnt[0].n > SUMMARISE_AFTER) await enqueue('summarise_agent', { agent });

  return { answer, id: rows[0].id };
}

// Background: condense everything except the most recent turns.
export async function summarise(agent) {
  const mem = await memoryOf(agent);
  const { rows: recent } = await q(
    `SELECT id FROM messages WHERE agent=$1 ORDER BY id DESC LIMIT $2`,
    [agent, VERBATIM]
  );
  if (!recent.length) return;
  const cutoff = recent[recent.length - 1].id;

  const { rows: older } = await q(
    `SELECT role, content FROM messages
     WHERE agent=$1 AND id > $2 AND id < $3 ORDER BY id`,
    [agent, mem.last_summarised_id, cutoff]
  );
  if (!older.length) return;

  const summary = await ask({
    cheap: true,
    maxTokens: 700,
    system:
      'You maintain one agent\'s long-term memory of working with the owner of ' +
      'a small business. Merge the existing memory with the new conversation ' +
      'into a single set of durable notes. Keep decisions, standing preferences, ' +
      'named projects, deadlines and anything the owner asked to be remembered. ' +
      'Drop small talk and anything superseded. Under 300 words. Write plain ' +
      'notes, no headings, no preamble.',
    user:
      'Existing memory:\n' + (mem.summary || '(none)') +
      '\n\nNew conversation:\n' +
      older.map((m) => (m.role === 'user' ? 'Owner: ' : 'Agent: ') + m.content).join('\n'),
  });

  await q(
    `UPDATE agent_memory SET summary=$2, last_summarised_id=$3, updated_at=now()
     WHERE agent=$1`,
    [agent, summary, cutoff]
  );
}
