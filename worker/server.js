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
    const up = await fetch(u, {
      method: req.method, headers,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    send(res, up.status, Buffer.from(await up.arrayBuffer()), up.headers.get('content-type') || 'application/octet-stream');
  } catch (e) {
    const c = e.cause ? ` [${e.cause.code || ''} ${e.cause.message || e.cause}]` : '';
    console.error('Ошибка запроса к', u.hostname, e.message + c);
    send(res, 502, JSON.stringify({ error: 'upstream fetch failed: ' + e.message + c }), 'application/json');
  }
}).listen(PORT, HOST, () => console.log(`Прокси запущен: http://${HOST}:${PORT}/?url=`));
