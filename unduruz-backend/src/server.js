import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');

// Webhooks first: they need raw bodies and must not sit behind auth.
app.use('/webhooks', webhooks);

// The town can be opened as a local file and pointed at this Pi, so allow
// cross-origin API calls. Auth is still the bearer token, and the service is
// only reachable over Tailscale.
app.use('/api', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.get('Origin') || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use('/api', api);

// /game is nicer to type than /game.html
app.get('/game', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

app.get('/healthz', (_req, res) => res.send('ok'));
app.use('/', express.static(path.join(__dirname, 'public')));

app.listen(config.port, config.host, () => {
  console.log('[server] http://' + config.host + ':' + config.port);
});
