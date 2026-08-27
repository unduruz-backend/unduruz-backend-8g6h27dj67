import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { q } from './db.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

async function recordUsage(usage) {
  if (!usage) return;
  await q(
    `INSERT INTO usage_day (day, input_tokens, output_tokens)
     VALUES (CURRENT_DATE, $1, $2)
     ON CONFLICT (day) DO UPDATE
       SET input_tokens  = usage_day.input_tokens  + EXCLUDED.input_tokens,
           output_tokens = usage_day.output_tokens + EXCLUDED.output_tokens`,
    [usage.input_tokens || 0, usage.output_tokens || 0]
  );
}

export async function ask({ system, user, maxTokens = 1000, cheap = false }) {
  const res = await client.messages.create({
    model: cheap ? config.modelCheap : config.modelMain,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  await recordUsage(res.usage);
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Ask for JSON and refuse to guess if it comes back malformed.
export async function askJSON(args) {
  const raw = await ask(args);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}
