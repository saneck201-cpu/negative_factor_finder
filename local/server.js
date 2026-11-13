// Локальная программа: отдаёт сайт на http://localhost:8787 и сама ходит в реестры с вашего компьютера.
// Запуск: node local/server.js (или start.bat / start.command). Нужен Node.js 18+. Зависимостей нет.
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
for (const f of ['factors', 'providers']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8'));
// после этого доступны глобально: FACTORS, SOURCES_LIST, OPEN_SRC

const PORT = +process.env.PORT || 8787;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- HTTP-клиент с cookie и ручной обработкой редиректов ---------- */
const jars = {};
function saveCookies(host, r) {
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  jars[host] = jars[host] || {};
  for (const c of list) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jars[host][kv.slice(0, i).trim()] = kv.slice(i + 1); }
}
async function req(url, { method = 'GET', headers = {}, body } = {}) {
  let u = new URL(url);
  for (let i = 0; i < 6; i++) {
    const jar = jars[u.hostname];
    const h = { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9', ...headers };
    if (jar && Object.keys(jar).length) h.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(u, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    saveCookies(u.hostname, r);
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      u = new URL(loc, u); u.protocol = 'https:'; u.port = '';  // всегда https (порт 80 может быть закрыт)
      if ([301, 302, 303].includes(r.status)) { method = 'GET'; body = undefined; }
      continue;
    }
    return r;
  }
  throw new Error('слишком много редиректов');
}
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
const errText = (e) => e.message + (e.cause ? ` [${e.cause.code || ''} ${e.cause.message || e.cause}]` : '');

/* ---------- ЕГРЮЛ (ФНС) ---------- */
async function egrulSearch(q) {
  const r = await req('https://egrul.nalog.ru/', { method: 'POST', headers: FORM,
    body: form({ vyp3CaptchaToken: '', page: '', query: q, region: '', PreventChromeAutocomplete: '' }) });
  const t = (await r.json()).t;
  if (!t) throw new Error('ЕГРЮЛ не вернул токен поиска');
  for (let i = 0; i < 8; i++) {
    const j = await (await req('https://egrul.nalog.ru/search-result/' + t)).json();
    if (j && Array.isArray(j.rows)) return j.rows;
    await sleep(700);
  }
  throw new Error('ЕГРЮЛ не ответил вовремя');
}

/* ---------- РНП (zakupki.gov.ru): разбор HTML эвристикой, точные маркеры уточним по диагностике ---------- */
async function rnpSearch(inn) {
  const url = 'https://zakupki.gov.ru/epz/dishonestsupplier/search/results.html?' +
    form({ searchString: inn, morphology: 'on', recordsPerPage: '_10', pageNumber: '1', fz44: 'on', fz223: 'on', ppRf615: 'on' });
  const r = await req(url);
  const html = await r.text();
  if (!r.ok) throw new Error('zakupki.gov.ru: HTTP ' + r.status);
  const entries = (html.match(/registry-entry__body-href/g) || []).length;
  if (entries) return { count: entries, html };
  const m = html.match(/([\d\s]+)\s*(?:результат|записей|запис)/i);
  if (m && parseInt(m[1].replace(/\s/g, ''), 10) >= 0 && /search-results|registry-entry|dishonest/i.test(html)) {
    return { count: parseInt(m[1].replace(/\s/g, ''), 10), html };
  }
  if (/Ничего не найдено|ничего не найдено|не найдено/.test(html)) return { count: 0, html };
  return { count: null, html };
}

/* ---------- Проверка одной организации ---------- */
async function check(query, factorIds) {
  const factors = FACTORS.filter((f) => !factorIds || factorIds.includes(f.id));
  const base = { query, inn: '', ogrn: '', name: '', found: false, cells: {} };
  const rows = await egrulSearch(query);
  if (!rows.length) return base;
  const isId = /^\d{10,13}$/.test(query);
  const row = (isId && rows.find((x) => x.i === query || x.o === query)) || rows[0];
  base.found = true; base.inn = String(row.i || ''); base.ogrn = String(row.o || ''); base.name = String(row.n || query);
  if (rows.length > 1 && !isId) base.note = `найдено совпадений: ${rows.length}, взято первое — сверьте ИНН`;
  const o = { inn: base.inn };
  const src = (k) => `${SOURCES_LIST[k].name}: ${SOURCES_LIST[k].url(o)}`;

  for (const f of factors) {
    base.cells[f.id] = { state: 'manual', text: `Проверьте вручную по ИНН ${base.inn || '—'}`, source: src(OPEN_SRC[f.id]) };
  }
  if (base.cells.status) {
    base.cells.status = row.e
      ? { state: 'hit', text: `Деятельность прекращена ${row.e}`, source: src('egrul') }
      : { state: 'none' };
  }
  if (base.cells.rnp && base.inn) {
    try {
      const { count } = await rnpSearch(base.inn);
      base.cells.rnp = count === null
        ? { state: 'unknown', text: 'РНП: не удалось разобрать ответ сайта, проверьте вручную', source: src('rnp') }
        : count > 0 ? { state: 'hit', text: `В реестре недобросовестных поставщиков найдено записей: ${count}`, source: src('rnp') }
          : { state: 'none' };
    } catch (e) { base.cells.rnp = { state: 'unknown', text: 'Не удалось проверить РНП: ' + errText(e), source: src('rnp') }; }
  }
  return base;
}

/* ---------- Диагностика: сохраняем сырые ответы реестров, чтобы по ним допилить разбор ---------- */
const cut = (s, n = 6000) => (typeof s === 'string' ? s.slice(0, n) : s);
async function probe(inn) {
  const out = { inn, at: new Date().toISOString(), node: process.version, steps: {} };
  const step = async (name, fn) => {
    try { out.steps[name] = await fn(); } catch (e) { out.steps[name] = { error: errText(e) }; }
    await sleep(800);
  };
  const dump = async (r) => ({ status: r.status, type: r.headers.get('content-type'), body: cut(await r.text()) });

  await step('egrul', async () => { const rows = await egrulSearch(inn); return { rows: rows.slice(0, 3) }; });
  await step('rnp_zakupki', async () => {
    const x = await rnpSearch(inn);
    const i = x.html.search(/registry-entry|search-results|Найдено|найдено/i);
    return { count: x.count, htmlLength: x.html.length, snippetAroundMarker: cut(x.html.slice(Math.max(0, i - 200)), 3000), head: cut(x.html, 1500) };
  });
  await step('pb_search', async () => {
    const r = await req('https://pb.nalog.ru/search-proc.json', { method: 'POST', headers: { ...FORM, Referer: 'https://pb.nalog.ru/', Origin: 'https://pb.nalog.ru', 'X-Requested-With': 'XMLHttpRequest' },
      body: form({ page: '1', pageSize: '10', pbCaptchaToken: '', token: '', mode: 'search-all', queryAll: inn }) });
    const d = await dump(r);
    try { out._pbToken = JSON.parse(await Promise.resolve(d.body)).ul.data[0].token; } catch (e) { /* ignore */ }
    return d;
  });
  if (out._pbToken) {
    await step('pb_company_request', async () => {
      const r = await req('https://pb.nalog.ru/company-proc.json', { method: 'POST', headers: { ...FORM, Referer: 'https://pb.nalog.ru/', 'X-Requested-With': 'XMLHttpRequest' },
        body: form({ token: out._pbToken, method: 'get-request' }) });
      const d = await dump(r);
      try { out._pbId = JSON.parse(d.body).id; } catch (e) { /* ignore */ }
      return d;
    });
    if (out._pbId) {
      await step('pb_company_response', async () => {
        await sleep(1500);
        const r = await req('https://pb.nalog.ru/company-proc.json', { method: 'POST', headers: { ...FORM, Referer: 'https://pb.nalog.ru/', 'X-Requested-With': 'XMLHttpRequest' },
          body: form({ id: out._pbId, method: 'get-response' }) });
        const d = await dump(r); d.body = cut(d.body, 20000); return d;
      });
    }
  }
  delete out._pbToken; delete out._pbId;
  await step('fedresurs_search', async () => dump(await req('https://fedresurs.ru/backend/companies?' + form({ searchString: inn, limit: '15', offset: '0' }), { headers: { Referer: 'https://fedresurs.ru/', Accept: 'application/json' } })));
  await step('efrsb_search', async () => dump(await req('https://bankrot.fedresurs.ru/backend/prsnbankrupts?' + form({ searchString: inn, limit: '15', offset: '0' }), { headers: { Referer: 'https://bankrot.fedresurs.ru/', Accept: 'application/json' } })));
  await step('kad_search', async () => dump(await req('https://kad.arbitr.ru/Kad/SearchInstances', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/javascript, */*', 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://kad.arbitr.ru/', Origin: 'https://kad.arbitr.ru' },
    body: JSON.stringify({ Page: 1, Count: 25, Courts: [], DateFrom: null, DateTo: null, Sides: [{ Name: inn, Type: -1, ExactMatch: false }], Judges: [], CaseNumbers: [], WithVKSInstances: false }) })));
  await step('fssp_page', async () => { const r = await req('https://fssp.gov.ru/iss/ip'); const d = await dump(r); d.body = cut(d.body, 1500); return d; });

  fs.writeFileSync(path.join(__dirname, 'probe-output.json'), JSON.stringify(out, null, 2));
  return out;
}

/* ---------- Сервер ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req_, res) => {
  const u = new URL(req_.url, 'http://localhost');
  try {
    if (u.pathname === '/api/check') {
      const q = (u.searchParams.get('q') || '').trim();
      const ids = (u.searchParams.get('factors') || '').split(',').filter(Boolean);
      if (!q) return json(res, 400, { error: 'пустой запрос' });
      return json(res, 200, await check(q, ids.length ? ids : null));
    }
    if (u.pathname === '/api/probe') {
      const inn = (u.searchParams.get('inn') || '').trim();
      if (!/^\d{10,12}$/.test(inn)) return json(res, 400, { error: 'нужен ИНН (10 или 12 цифр)' });
      return json(res, 200, await probe(inn));
    }
    // статика (только из корня проекта, без скрытых файлов и без папки local)
    let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    const rel = path.relative(ROOT, file);
    if (rel.startsWith('..') || rel.split(path.sep).some((s) => s.startsWith('.')) || rel.startsWith('local')) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  } catch (e) {
    console.error(u.pathname, errText(e));
    json(res, 502, { error: errText(e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Готово. Откройте в браузере: http://localhost:${PORT}`));
