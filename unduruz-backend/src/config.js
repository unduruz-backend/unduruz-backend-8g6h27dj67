import 'dotenv/config';

function need(key) {
  const v = process.env[key];
  if (!v) throw new Error('Missing ' + key + '. Copy .env.example to .env and fill it in.');
  return v;
}

export const config = {
  anthropicKey: need('ANTHROPIC_API_KEY'),
  modelCheap: process.env.MODEL_CHEAP || 'claude-haiku-4-5-20251001',
  modelMain: process.env.MODEL_MAIN || 'claude-sonnet-4-6',
  databaseUrl: need('DATABASE_URL'),
  dashboardToken: need('DASHBOARD_TOKEN'),
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '127.0.0.1',
  lemonSecret: process.env.LEMON_WEBHOOK_SECRET || '',
  gumroadSellerId: process.env.GUMROAD_SELLER_ID || '',
  cfAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cfApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  imageModel: process.env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell',
  dailyImageLimit: Number(process.env.DAILY_IMAGE_LIMIT || 20),
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: process.env.NTFY_SERVER || 'https://ntfy.sh',
  dupeThreshold: Number(process.env.DUPE_THRESHOLD || 0.92),
  publicUrl: process.env.PUBLIC_URL || '',
  maxPendingReview: Number(process.env.MAX_PENDING_REVIEW || 8),
  dailyDraftLimit: Number(process.env.DAILY_DRAFT_LIMIT || 12),
};
