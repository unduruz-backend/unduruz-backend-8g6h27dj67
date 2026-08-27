// Push to your phone via ntfy.sh. Free, no account, no SDK.
// Set NTFY_TOPIC in .env to something nobody would guess, then subscribe
// to that topic in the ntfy app.
import { config } from './config.js';

export async function push(title, message, opts = {}) {
  if (!config.ntfyTopic) return;
  try {
    await fetch(config.ntfyServer + '/' + config.ntfyTopic, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: opts.priority || 'default',
        Tags: opts.tags || 'briefcase',
        ...(opts.click ? { Click: opts.click } : {}),
      },
      body: message.slice(0, 900),
    });
  } catch (e) {
    console.error('[notify]', e.message);   // never let a push break a job
  }
}
