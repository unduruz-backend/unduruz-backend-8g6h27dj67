// Image generation via Cloudflare Workers AI.
//
// FLUX.1 Schnell is Apache-2.0, so what comes out is commercially usable.
// Optional: if the account is not configured, everything else still runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { q } from './db.js';
import { ask } from './claude.js';
import { policyBlock } from './policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, 'public', 'media');

export const imagesEnabled = () =>
  Boolean(config.cfAccountId && config.cfApiToken);

async function imagesToday() {
  const { rows } = await q(`SELECT images FROM usage_day WHERE day = CURRENT_DATE`);
  return rows[0] ? rows[0].images : 0;
}
async function bumpImages() {
  await q(
    `INSERT INTO usage_day (day, images) VALUES (CURRENT_DATE, 1)
     ON CONFLICT (day) DO UPDATE SET images = usage_day.images + 1`
  );
}

// Let the agent describe its own image, inside the policy.
export async function promptFor(task) {
  return ask({
    cheap: true,
    maxTokens: 220,
    system:
      policyBlock() +
      '\n\nYou write image-generation prompts. Reply with ONLY the prompt, one ' +
      'paragraph, no preamble or quotes. Describe subject, composition, ' +
      'lighting and style concretely. Never name a living artist, brand, ' +
      'trademark or copyrighted character. No text or lettering in the image ' +
      '(models render it badly). No real people.',
    user:
      'Make a prompt for a promotional image for this work.\n' +
      'Title: ' + task.title + '\nCategory: ' + task.category +
      '\nChannel: ' + (task.channel || 'internal'),
  });
}

export async function generate(taskId, prompt) {
  if (!imagesEnabled()) throw new Error('Cloudflare not configured');
  const used = await imagesToday();
  if (used >= config.dailyImageLimit) throw new Error('daily image limit reached');

  const url =
    'https://api.cloudflare.com/client/v4/accounts/' + config.cfAccountId +
    '/ai/run/' + config.imageModel;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.cfApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, steps: 4 }),
  });
  if (!res.ok) throw new Error('Cloudflare ' + res.status + ': ' + (await res.text()).slice(0, 200));

  // FLUX returns JSON with base64; SDXL returns raw PNG bytes.
  let buf;
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const j = await res.json();
    const b64 = j?.result?.image;
    if (!b64) throw new Error('no image in response');
    buf = Buffer.from(b64, 'base64');
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }

  await fs.mkdir(MEDIA_DIR, { recursive: true });
  const name = 'task' + taskId + '-' + Date.now() + '.png';
  await fs.writeFile(path.join(MEDIA_DIR, name), buf);
  const rel = 'media/' + name;

  await q(
    `INSERT INTO assets (task_id, kind, path, prompt, model)
     VALUES ($1,'image',$2,$3,$4)`,
    [taskId, rel, prompt, config.imageModel]
  );
  await bumpImages();
  return rel;
}
