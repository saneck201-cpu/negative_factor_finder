// Cloudflare Worker: прокси с белым списком хостов, добавляет CORS-заголовки.
// Использование: https://<worker>/?url=<закодированный адрес>
const ALLOWED_HOSTS = [
  'egrul.nalog.ru', 'pb.nalog.ru', 'bo.nalog.gov.ru',
  'bankrot.fedresurs.ru', 'fedresurs.ru', 'zakupki.gov.ru',
  'kad.arbitr.ru', 'fssp.gov.ru',
];

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

    const target = new URL(request.url).searchParams.get('url');
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
    const upstream = await fetch(u.toString(), {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    });
    const out = new Headers(cors);
    out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
