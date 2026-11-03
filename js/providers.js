/* Провайдеры данных. Каждый реализует check(query, opts) ->
   { inn, ogrn, name, found, cells: { [factorId]: {state:'hit'|'none'|'unknown', text, source} } }  */
(function (global) {
  const SRC = {
    egrul:  { name: 'ЕГРЮЛ (ФНС России)',                    url: (o) => 'https://egrul.nalog.ru/' },
    pb:     { name: 'ФНС «Прозрачный бизнес»',               url: (o) => 'https://pb.nalog.ru/' },
    fssp:   { name: 'Банк данных исполнительных производств ФССП', url: (o) => 'https://fssp.gov.ru/iss/ip' },
    kad:    { name: 'Картотека арбитражных дел (kad.arbitr.ru)',  url: (o) => 'https://kad.arbitr.ru/' },
    efrsb:  { name: 'ЕФРСБ (bankrot.fedresurs.ru)',          url: (o) => 'https://bankrot.fedresurs.ru/' },
    fedres: { name: 'Федресурс (fedresurs.ru)',              url: (o) => 'https://fedresurs.ru/' },
    rnp:    { name: 'РНП, ЕИС закупки (zakupki.gov.ru)',     url: (o) => 'https://zakupki.gov.ru/epz/dishonestsupplier/search/results.html?searchString=' + (o.inn || '') },
    gir:    { name: 'ГИР БО / Росстат (отчётность)',         url: (o) => 'https://bo.nalog.gov.ru/' },
    insp:   { name: 'ФГИС ЕРКНМ (проверки)',                 url: (o) => 'https://proverki.gov.ru/' },
  };

  /* ---------- вспомогательное ---------- */
  const isObj = (x) => x && typeof x === 'object';
  function deepFind(obj, keyRe, pred, depth = 0) {
    if (!isObj(obj) || depth > 6) return undefined;
    for (const [k, v] of Object.entries(obj)) {
      if (keyRe.test(k) && (!pred || pred(v))) return { key: k, value: v };
      const r = deepFind(v, keyRe, pred, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  const truthy = (v) => {
    if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (isObj(v)) return Object.keys(v).length > 0;
    return true;
  };
  function listOf(data) {
    if (Array.isArray(data)) return data;
    if (!isObj(data)) return [];
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
    return [];
  }
  function parseDate(s) {
    if (!s) return null;
    s = String(s);
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    return null;
  }
  const fmtDate = (d) => d.toLocaleDateString('ru-RU');
  const fmtMoney = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
  function sumByKey(list, re) {
    let s = 0;
    for (const it of list) {
      const f = isObj(it) && deepFind(it, re, (v) => typeof v === 'number' || /^[\d\s.,]+$/.test(String(v)));
      if (f) s += parseFloat(String(f.value).replace(/\s/g, '').replace(',', '.')) || 0;
    }
    return s;
  }
  const textOf = (o) => JSON.stringify(o || '');
  const dateOfEvent = (e) => {
    const f = isObj(e) && deepFind(e, /дата|date/i, (v) => parseDate(v));
    return f ? parseDate(f.value) : null;
  };

  /* ---------- Checko API v2 ---------- */
  const checko = {
    id: 'checko',
    title: 'Checko API (api.checko.ru)',
    needsKey: true,

    async call(ep, params, opts) {
      const qs = new URLSearchParams({ key: opts.key, ...params });
      let url = `https://api.checko.ru/v2/${ep}?${qs}`;
      if (opts.proxy) url = opts.proxy + encodeURIComponent(url);
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (j.meta && j.meta.status && j.meta.status !== 'ok') throw new Error(j.meta.message || 'ошибка API');
      return j.data !== undefined ? j.data : j;
    },

    async resolve(query, opts) {
      if (/^\d{10}$|^\d{13}$/.test(query)) return { inn: query.length === 10 ? query : '', ogrn: query.length === 13 ? query : '' };
      const data = await this.call('search', { by: 'name', obj: 'org', query }, opts);
      const list = listOf(data);
      const first = list.find((x) => isObj(x) && (x.ИНН || x.inn)) || list[0];
      if (!first) return null;
      return {
        inn: String(first.ИНН || first.inn || ''),
        ogrn: String(first.ОГРН || first.ogrn || ''),
        name: first.НазвСокр || first.НаимСокр || first.НазвПолн || first.name || '',
      };
    },

    async check(query, opts) {
      const base = { query, inn: '', ogrn: '', name: '', found: false, cells: {} };
      const res = await this.resolve(query, opts);
      if (!res || !(res.inn || res.ogrn)) return base;
      const id = res.inn ? { inn: res.inn } : { ogrn: res.ogrn };

      const need = new Set(opts.factors.map((f) => f.needs));
      need.add('company');
      const raw = {};
      await Promise.all([...need].map(async (ep) => {
        try {
          const params = { ...id };
          if (ep === 'legal-cases') params.role = 'defendant';
          raw[ep] = { data: await this.call(ep, params, opts) };
        } catch (e) { raw[ep] = { error: e.message }; }
      }));

      const co = raw.company && raw.company.data;
      base.inn = res.inn || (co && String(co.ИНН || '')) || '';
      base.ogrn = res.ogrn || (co && String(co.ОГРН || '')) || '';
      base.name = (co && (co.НазвСокр || co.НазвПолн)) || res.name || query;
      base.found = true;
      const o = { inn: base.inn };

      const unknown = (ep) => ({ state: 'unknown', text: `Не удалось проверить: ${raw[ep] ? raw[ep].error : 'нет данных'}` });
      const mk = (ep, srcKey, fn) => {
        if (!raw[ep] || raw[ep].error) return unknown(ep);
        const text = fn(raw[ep].data);
        const src = SRC[srcKey];
        return text
          ? { state: 'hit', text, source: `${src.name}: ${src.url(o)}` }
          : { state: 'none' };
      };
      const since = new Date(); since.setMonth(since.getMonth() - opts.months);
      const events = (ep) => {
        const d = raw[ep] && raw[ep].data;
        return listOf(d).filter((e) => { const dt = dateOfEvent(e); return dt && dt >= since; });
      };

      const C = base.cells;
      C.status = mk('company', 'egrul', (d) => {
        const st = d.Статус && (d.Статус.Наим || d.Статус);
        return typeof st === 'string' && /ликвид|реорганиз|банкрот|исключ|прекращ/i.test(st) ? `Статус в ЕГРЮЛ: ${st}` : '';
      });
      C.unreliable = mk('company', 'egrul', (d) => {
        const f = deepFind(d, /недост/i, truthy);
        return f ? `В ЕГРЮЛ есть отметка о недостоверности сведений (${f.key}): ${typeof f.value === 'string' ? f.value : textOf(f.value).slice(0, 200)}` : '';
      });
      C.massaddr = mk('company', 'pb', (d) => {
        const f = deepFind(d, /масс.*адр|адр.*масс/i, truthy);
        return f ? 'Юридический адрес числится как адрес массовой регистрации' : '';
      });
      C.massperson = mk('company', 'pb', (d) => {
        const f = deepFind(d, /масс.*(руковод|учред)|(руковод|учред).*масс/i, truthy);
        return f ? `Руководитель/учредитель значится «массовым» (${f.key})` : '';
      });
      C.rnp = mk('company', 'rnp', (d) => {
        const f = deepFind(d, /недобпост|рнп/i, truthy);
        return f ? 'Организация числится в реестре недобросовестных поставщиков' : '';
      });
      C.taxdebt = mk('company', 'pb', (d) => {
        const f = deepFind(d, /недоим|задолж/i, (v) => parseFloat(v) > 0);
        return f ? `Налоговая задолженность/недоимка: ${fmtMoney(parseFloat(f.value))}` : '';
      });

      const ch = (re, label) => (d) => {
        const ev = events('timeline').filter((e) => re.test(textOf(e)));
        if (!ev.length) return '';
        const last = ev.map(dateOfEvent).sort((a, b) => b - a)[0];
        return `${label}: ${ev.length} изм. за ${opts.months} мес., последнее ${fmtDate(last)}`;
      };
      C.chdir = mk('timeline', 'egrul', ch(/руковод|директор|генеральн/i, 'Смена руководителя'));
      C.chowner = mk('timeline', 'egrul', ch(/учредител|участник|собственник|доля|долей/i, 'Смена учредителей/собственника'));
      C.chaddr = mk('timeline', 'egrul', ch(/адрес/i, 'Смена адреса'));

      C.fssp = mk('enforcements', 'fssp', (d) => {
        const l = listOf(d);
        if (!l.length) return '';
        const sum = sumByKey(l, /сумм|остаток/i);
        return `Исполнительных производств: ${l.length}${sum ? `, сумма ≈ ${fmtMoney(sum)}` : ''}`;
      });
      C.courts = mk('legal-cases', 'kad', (d) => {
        const l = listOf(d).filter((e) => {
          const role = deepFind(e, /роль|role|сторона/i);
          return !role || /ответч|defend/i.test(String(role.value));
        });
        if (!l.length) return '';
        const lost = l.filter((e) => /удовлетвор/i.test(textOf(e)) && !/отказ/i.test(textOf(e))).length;
        const sum = sumByKey(l, /сумм/i);
        return `Дел в роли ответчика: ${l.length}${lost ? `, с признаками удовлетворения иска: ${lost}` : ''}${sum ? `, сумма исков ≈ ${fmtMoney(sum)}` : ''}`;
      });
      C.bankr = mk('bankruptcy-messages', 'efrsb', (d) => {
        const l = listOf(d);
        return l.length ? `Сообщений о банкротстве в ЕФРСБ: ${l.length}` : '';
      });
      C.fedres = mk('fedresurs', 'fedres', (d) => {
        const l = listOf(d).filter((e) => /ликвидац|реорганиз|несостоятельн|банкрот|уменьшен.*капитал|недостовер|исключен/i.test(textOf(e)));
        return l.length ? `Тревожных сообщений на Федресурсе: ${l.length}` : '';
      });
      C.inspect = mk('inspections', 'insp', (d) => {
        const l = listOf(d).filter((e) => deepFind(e, /наруш/i, truthy));
        return l.length ? `Проверок с выявленными нарушениями: ${l.length}` : '';
      });
      C.fin = mk('finances', 'gir', (d) => {
        const years = isObj(d) ? Object.keys(d).filter((k) => /^\d{4}$/.test(k)).sort() : [];
        const last = years[years.length - 1];
        if (!last) return '';
        const y = d[last];
        const prof = parseFloat(y['2400']);
        const cap = parseFloat(y['1300']);
        const t = [];
        if (prof < 0) t.push(`чистый убыток ${fmtMoney(-prof)}`);
        if (cap < 0) t.push(`отрицательный капитал ${fmtMoney(cap)}`);
        return t.length ? `За ${last} г.: ${t.join('; ')}` : '';
      });

      return base;
    },
  };

  /* ---------- Демо-режим (выдуманные данные, чтобы проверить интерфейс и выгрузку) ---------- */
  const demo = {
    id: 'demo',
    title: 'Демо (выдуманные данные, без ключа)',
    needsKey: false,
    async check(query, opts) {
      let h = 0;
      for (const ch of query) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const inn = String(7700000000 + (h % 99999999)).slice(0, 10);
      const base = { query, inn, ogrn: String(1027700000000 + (h % 99999999)), name: query, found: true, cells: {} };
      opts.factors.forEach((f, i) => {
        const r = ((h >>> (i % 16)) + i * 7) % 10;
        if (r < 3) {
          const srcKey = { company: 'egrul', timeline: 'egrul', enforcements: 'fssp', 'legal-cases': 'kad',
            'bankruptcy-messages': 'efrsb', fedresurs: 'fedres', inspections: 'insp', finances: 'gir' }[f.needs];
          base.cells[f.id] = { state: 'hit', text: `[ДЕМО] Условная расшифровка: ${f.title}`, source: `${SRC[srcKey].name}: ${SRC[srcKey].url({ inn })}` };
        } else if (r === 9) base.cells[f.id] = { state: 'unknown', text: '[ДЕМО] Не удалось проверить' };
        else base.cells[f.id] = { state: 'none' };
      });
      await new Promise((r) => setTimeout(r, 150));
      return base;
    },
  };

  /* ---------- Открытые источники (без ключа, через свой прокси) ---------- */
  const OPEN_SRC = {
    status: 'egrul', unreliable: 'pb', massaddr: 'pb', massperson: 'pb', rnp: 'rnp', taxdebt: 'pb',
    chdir: 'egrul', chowner: 'egrul', chaddr: 'egrul', fssp: 'fssp', courts: 'kad', bankr: 'efrsb',
    fedres: 'fedres', inspect: 'insp', fin: 'gir',
  };
  const open = {
    id: 'open',
    title: 'Открытые источники (без ключа)',
    needsKey: false,
    needsProxy: true,

    async viaProxy(url, init, proxy) {
      const r = await fetch(proxy + encodeURIComponent(url), init);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },

    /* ЕГРЮЛ ФНС: поиск по названию/ИНН/ОГРН */
    async searchEgrul(query, proxy) {
      const t = await this.viaProxy('https://egrul.nalog.ru/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'vyp3CaptchaToken=&page=&query=' + encodeURIComponent(query) + '&region=&PreventChromeAutocomplete=',
      }, proxy);
      if (!t || !t.t) throw new Error('ЕГРЮЛ не вернул токен поиска');
      for (let i = 0; i < 6; i++) {
        const j = await this.viaProxy('https://egrul.nalog.ru/search-result/' + t.t, {}, proxy);
        if (j && Array.isArray(j.rows)) return j.rows;
        await new Promise((r) => setTimeout(r, 700));
      }
      throw new Error('ЕГРЮЛ не ответил вовремя');
    },

    async check(query, opts) {
      const base = { query, inn: '', ogrn: '', name: '', found: false, cells: {} };
      if (!opts.proxy) throw new Error('не указан адрес прокси');
      const rows = await this.searchEgrul(query, opts.proxy);
      if (!rows.length) return base;
      const row = rows[0];
      base.found = true;
      base.inn = String(row.i || '');
      base.ogrn = String(row.o || '');
      base.name = String(row.n || query);
      if (rows.length > 1) base.note = `найдено совпадений: ${rows.length}, взято первое — сверьте ИНН`;
      const o = { inn: base.inn };

      for (const f of opts.factors) {
        const srcKey = OPEN_SRC[f.id];
        const src = SRC[srcKey];
        base.cells[f.id] = {
          state: 'manual',
          text: `Проверьте вручную по ИНН ${base.inn || '—'}`,
          source: `${src.name}: ${src.url(o)}`,
        };
      }
      if (opts.factors.some((f) => f.id === 'status')) {
        base.cells.status = row.e
          ? { state: 'hit', text: `Деятельность прекращена ${row.e}`, source: `${SRC.egrul.name}: ${SRC.egrul.url(o)}` }
          : { state: 'none' };
      }
      return base;
    },
  };

  /* ---------- СПАРК (заготовка: подключение появится, когда будет документация API) ---------- */
  const spark = {
    id: 'spark',
    title: 'СПАРК (по API-ключу)',
    needsKey: true,
    ready: false,
    notReadyMessage: 'Подключение к СПАРК ещё не настроено: нужны адрес API, способ авторизации и пример ответа из документации Интерфакса.',
    async check() { throw new Error(this.notReadyMessage); },
  };

  global.PROVIDERS = { open, spark, checko, demo };
  global.SOURCES_LIST = SRC;
})(typeof window !== 'undefined' ? window : globalThis);
