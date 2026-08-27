import { q } from './db.js';

export async function enqueue(type, payload = {}, delaySeconds = 0) {
  const { rows } = await q(
    `INSERT INTO jobs (type, payload, run_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
     RETURNING id`,
    [type, payload, String(delaySeconds)]
  );
  return rows[0].id;
}

// Claim one job atomically. SKIP LOCKED means two workers never take the same
// row, so you can run more than one worker later without changing anything.
export async function claim() {
  const { rows } = await q(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return rows[0] || null;
}

export async function finish(id) {
  await q(`UPDATE jobs SET status = 'done' WHERE id = $1`, [id]);
}

export async function fail(job, err) {
  const msg = String(err && err.message ? err.message : err).slice(0, 500);
  if (job.attempts >= job.max_attempts) {
    await q(`UPDATE jobs SET status = 'failed', last_error = $2 WHERE id = $1`, [job.id, msg]);
    return false;
  }
  // exponential backoff: 1m, 4m, 9m
  const backoff = 60 * job.attempts * job.attempts;
  await q(
    `UPDATE jobs SET status = 'pending', last_error = $2,
       run_at = now() + ($3 || ' seconds')::interval
     WHERE id = $1`,
    [job.id, msg, String(backoff)]
  );
  return true;
}
