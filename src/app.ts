import { Hono } from 'hono';
import api from './routes/api';
import type { Env } from './env';

export const app = new Hono<{ Bindings: Env }>();

app.route('/api', api);

// The mounted API router handles /api/*; keep the bare prefix JSON-only too.
app.all('/api', (c) => c.json({ error: 'API endpoint が見つかりません' }, 404));

app.all('*', async (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'サーバーでエラーが発生しました' }, 500);
});
