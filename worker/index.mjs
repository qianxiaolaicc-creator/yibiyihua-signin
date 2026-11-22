import parentPage from '../ui/app.html';
import adminPage from '../ui/admin.html';
import { handleApi } from '../server/api.mjs';
import { saveScheduledBackup } from '../server/backup.mjs';

const headers = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    const page = { '/': parentPage, '/admin': adminPage, '/admin/': adminPage }[url.pathname];
    if (page && ['GET', 'HEAD'].includes(request.method)) {
      return new Response(request.method === 'HEAD' ? null : page, { headers });
    }
    return new Response('页面不存在。', { status: 404, headers });
  },
  async scheduled(event, env) {
    await saveScheduledBackup(env, new Date(event.scheduledTime));
  },
};
