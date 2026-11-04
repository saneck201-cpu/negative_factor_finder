// Тот же прокси, но как обычная Node.js-программа (Node 18+, без зависимостей).
// Запускать на российском компьютере или VPS: node server.js
// Переменные: PORT (по умолчанию 8787), HOST (по умолчанию 127.0.0.1), ALLOWED_ORIGIN (по умолчанию *).
const http = require('http');

const ALLOWED_HOSTS = [
  'egrul.nalog.ru', 'pb.nalog.ru', 'bo.nalog.gov.ru',
  'bankrot.fedresurs.ru', 'fedresurs.ru', 'zakupki.gov.ru',
  'kad.arbitr.ru', 'fssp.gov.ru',
];
const PORT = +process.env.PORT || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';


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

const cors = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // нужно, чтобы сайт на https мог обращаться к локальному прокси в Chrome
  'Access-Control-Allow-Private-Network': 'true',
};
const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(status, { ...cors, 'Content-Type': type });
  res.end(body);
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const sp = new URL(req.url, 'http://x').searchParams;
  if (sp.get('ping')) return send(res, 200, '{"ok":true}', 'application/json');

  let u;
  try { u = new URL(sp.get('url')); } catch (e) { return send(res, 400, 'bad url'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.includes(u.hostname)) return send(res, 403, 'host not allowed');
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, 'method not allowed');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; negative-factor-finder)' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  try {
    const up = await fetchFollow(u, {
      method: req.method, headers,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(20000),
    }, ALLOWED_HOSTS);
    send(res, up.status, Buffer.from(await up.arrayBuffer()), up.headers.get('content-type') || 'application/octet-stream');
  } catch (e) {
    const c = e.cause ? ` [${e.cause.code || ''} ${e.cause.message || e.cause}]` : '';
    console.error('Ошибка запроса к', u.hostname, e.message + c);
    send(res, 502, JSON.stringify({ error: 'upstream fetch failed: ' + e.message + c }), 'application/json');
  }
}).listen(PORT, HOST, () => console.log(`Прокси запущен: http://${HOST}:${PORT}/?url=`));
