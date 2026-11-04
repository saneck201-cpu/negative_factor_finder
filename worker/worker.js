// Cloudflare Worker: прокси с белым списком хостов, добавляет CORS-заголовки.
// Использование: https://<worker>/?url=<закодированный адрес>
const ALLOWED_HOSTS = [
  'egrul.nalog.ru', 'pb.nalog.ru', 'bo.nalog.gov.ru',
  'bankrot.fedresurs.ru', 'fedresurs.ru', 'zakupki.gov.ru',
  'kad.arbitr.ru', 'fssp.gov.ru',
];


// Редиректы обрабатываем сами и всегда поднимаем http -> https (ФНС может отправлять на http://, а порт 80 может быть закрыт).
async function fetchFollow(url, init, hosts) {
  let u = new URL(url);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(u, { ...init, redirect: 'manual' });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      u = new URL(loc, u);
      u.protocol = 'https:';
      u.port = '';
      if (!hosts.includes(u.hostname)) throw new Error('redirect to disallowed host ' + u.hostname);
      if (r.status === 301 || r.status === 302 || r.status === 303) { init = { ...init, method: 'GET', body: undefined }; }
      continue;
    }
    return r;
  }
  throw new Error('too many redirects');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin === '*' ? '*' : (origin === allowOrigin ? origin : allowOrigin),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const sp = new URL(request.url).searchParams;
    if (sp.get('ping')) {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const target = sp.get('url');
    let u;
    try { u = new URL(target); } catch (e) { return new Response('bad url', { status: 400, headers: cors }); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.includes(u.hostname)) {
      return new Response('host not allowed', { status: 403, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('method not allowed', { status: 405, headers: cors });
    }

    const headers = new Headers();
    const ct = request.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('User-Agent', 'Mozilla/5.0 (compatible; negative-factor-finder)');
    let upstream;
    try {
      upstream = await fetchFollow(u.toString(), {
        method: request.method,
        headers,
        body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      }, ALLOWED_HOSTS);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream fetch failed: ' + e.message }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const out = new Headers(cors);
    out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
