import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,                       // a Pi does not need more
  idleTimeoutMillis: 30000,
});

export const q = (text, params) => pool.query(text, params);

export async function logEvent(actor, text, icon = '*') {
  await q('INSERT INTO events (actor, text, icon) VALUES ($1,$2,$3)', [actor, text, icon]);
}
