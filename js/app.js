(function () {
  const $ = (id) => document.getElementById(id);
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  let lastResults = null;
  let lastFactors = null;

  // --- init UI
  const params = new URLSearchParams(location.search);
  const dev = params.get('dev') === '1';
  const MODE_TEXT = {
    open: ['Открытые источники', 'без ключа; ЕГРЮЛ — автоматически, остальные реестры — ссылки для ручной проверки'],
    spark: ['СПАРК', 'по вашему API-ключу'],
    checko: ['Checko (тест)', 'по API-ключу'],
    demo: ['Демо', 'выдуманные данные'],
  };
  const ids = Object.keys(PROVIDERS).filter((id) => dev || id === 'open' || id === 'spark');
  let mode = LS.get('nff.provider');
  if (!ids.includes(mode)) mode = ids[0];
  $('modes').innerHTML = ids.map((id) =>
    `<label class="mode" data-id="${id}"><input type="radio" name="mode" value="${id}"><b>${MODE_TEXT[id][0]}</b><span>${MODE_TEXT[id][1]}</span></label>`).join('');
  const getMode = () => document.querySelector('input[name=mode]:checked').value;
  document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;

  $('key').value = LS.get('nff.key') || '';
  $('remember').checked = !!LS.get('nff.key');
  $('proxy').value = LS.get('nff.proxy') || '';
  $('factorList').innerHTML = FACTORS.map((f) =>
    `<label><input type="checkbox" value="${f.id}" checked> ${f.title}</label>`).join('');

  function refreshProvider() {
    const p = PROVIDERS[getMode()];
    document.querySelectorAll('.mode').forEach((el) => el.classList.toggle('on', el.dataset.id === p.id));
    $('keyBox').style.display = p.needsKey ? '' : 'none';
    $('proxyBox').style.display = p.needsProxy ? '' : 'none';
    $('hint').textContent = {
      open: 'Без ключа браузер не может обращаться к госреестрам напрямую, поэтому нужен свой бесплатный прокси. Автоматически проверяется статус в ЕГРЮЛ; по остальным факторам в таблице будут ссылки для ручной проверки.',
      spark: 'Подключение к СПАРК в работе: пока выбрать этот режим можно, но проверка не запустится.',
      checko: 'Тестовый режим разработчика.',
      demo: 'Демо-режим: данные выдуманные.',
    }[p.id];
  }
  document.querySelectorAll('input[name=mode]').forEach((el) => el.addEventListener('change', refreshProvider));
  refreshProvider();

  // --- прокси: нормализация адреса и проверка
  function normProxy(v) {
    v = v.trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    if (!/[?&]url=/.test(v)) v = v.replace(/[?\/]*$/, '') + '/?url=';
    return v;
  }
  $('checkProxy').addEventListener('click', async () => {
    const proxy = normProxy($('proxy').value);
    const out = $('proxyStatus');
    if (!proxy) { out.textContent = 'Введите адрес прокси.'; return; }
    $('proxy').value = proxy;
    out.textContent = 'Проверяю…';
    try { await fetch(proxy.replace(/\?url=.*$/, '?ping=1')); }
    catch (e) { out.textContent = 'Прокси недоступен: проверьте адрес Worker (должен открываться в браузере) и что он развёрнут (Deploy).'; return; }
    try {
      const r = await fetch(proxy + encodeURIComponent('https://egrul.nalog.ru/'));
      let extra = '';
      try { const j = await r.clone().json(); if (j.error) extra = ' ' + j.error; } catch (e) { /* html */ }
      out.textContent = r.ok
        ? 'Прокси работает, ЕГРЮЛ отвечает.'
        : `Прокси работает, но до ЕГРЮЛ не дошёл (HTTP ${r.status}${extra}). Скорее всего ФНС блокирует зарубежные адреса Cloudflare.`;
    } catch (e) {
      out.textContent = 'Прокси ответил без CORS-заголовков: обновите код Worker из worker/worker.js и нажмите Deploy.';
    }
  });

  // --- run
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    }));
  }

  $('run').addEventListener('click', async () => {
    const queries = [...new Set($('orgs').value.split('\n').map((s) => s.trim()).filter(Boolean))];
    if (!queries.length) { $('status').textContent = 'Введите хотя бы одну организацию.'; return; }
    const provider = PROVIDERS[getMode()];
    if (provider.ready === false) { $('status').textContent = provider.notReadyMessage; return; }
    if (provider.needsProxy && !$('proxy').value.trim()) { $('status').textContent = 'Укажите адрес вашего прокси (см. worker/README.md).'; return; }
    const key = $('key').value.trim();
    if (provider.needsKey && !key) { $('status').textContent = 'Введите API-ключ.'; return; }
    const factors = FACTORS.filter((f) => document.querySelector(`#factorList input[value="${f.id}"]`).checked);
    if (!factors.length) { $('status').textContent = 'Выберите хотя бы один фактор.'; return; }

    LS.set('nff.provider', provider.id);
    LS.set('nff.proxy', normProxy($('proxy').value));
    if ($('remember').checked && key) LS.set('nff.key', key); else LS.del('nff.key');

    const opts = { key, factors, months: Math.max(1, +$('months').value || 12), proxy: normProxy($('proxy').value) };
    const results = new Array(queries.length);
    let done = 0;
    $('run').disabled = true; $('download').disabled = true;
    $('status').textContent = `Проверено 0 из ${queries.length}…`;

    await pool(queries, 2, async (q, idx) => {
      try { results[idx] = await provider.check(q, opts); }
      catch (e) {
        const cells = {};
        factors.forEach((f) => { cells[f.id] = { state: 'unknown', text: 'Не удалось проверить: ' + e.message }; });
        results[idx] = { query: q, inn: '', ogrn: '', name: q, found: false, error: e.message, cells };
      }
      $('status').textContent = `Проверено ${++done} из ${queries.length}…`;
    });

    lastResults = results; lastFactors = factors;
    render(results, factors);
    $('status').textContent = `Готово: ${queries.length} орг.`;
    $('run').disabled = false; $('download').disabled = false;
  });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function cellText(c) {
    if (!c || c.state === 'none') return '';
    return c.source ? `${c.text}\nИсточник: ${c.source}` : c.text;
  }
  const hitsCount = (r) => Object.values(r.cells).filter((c) => c.state === 'hit').length;

  function render(results, factors) {
    const head = `<tr><th>Организация</th>${factors.map((f) => `<th>${esc(f.title)}</th>`).join('')}<th>Факторов найдено</th></tr>`;
    const body = results.map((r) => {
      const name = r.found ? `${esc(r.name)}<span class="src">ИНН ${esc(r.inn || '—')}${r.note ? ' · ' + esc(r.note) : ''}</span>` : `${esc(r.query)}<span class="src">${esc(r.error || 'организация не найдена')}</span>`;
      const tds = factors.map((f) => {
        const c = r.cells[f.id];
        if (!c || c.state === 'none') return '<td></td>';
        return `<td class="${c.state}">${esc(c.text)}${c.source ? `<span class="src">Источник: ${esc(c.source)}</span>` : ''}</td>`;
      }).join('');
      return `<tr><td>${name}</td>${tds}<td>${hitsCount(r)}</td></tr>`;
    }).join('');
    $('preview').innerHTML = head + body;
    $('result').hidden = false;
  }

  // --- Excel
  $('download').addEventListener('click', () => {
    if (!lastResults) return;
    const H = (v) => ({ v, s: 1 });
    const matrix = [[H('Организация'), H('ИНН'), H('ОГРН'), ...lastFactors.map((f) => H(f.title)), H('Факторов найдено')]];
    for (const r of lastResults) {
      matrix.push([
        { v: r.found ? r.name + (r.note ? " (" + r.note + ")" : "") : `${r.query} (не найдена${r.error ? ': ' + r.error : ''})`, s: 5 },
        { v: r.inn || '', s: 2 },
        { v: r.ogrn || '', s: 2 },
        ...lastFactors.map((f) => {
          const c = r.cells[f.id];
          const st = !c || c.state === 'none' ? 2 : c.state === 'hit' ? 3 : 4; // hit — красная, остальное — жёлтая
          return { v: cellText(c), s: st };
        }),
        { v: hitsCount(r), s: 2 },
      ]);
    }
    const src = [[H('Сокр.'), H('Источник'), H('Ссылка')]];
    for (const [k, s] of Object.entries(SOURCES_LIST)) src.push([{ v: k, s: 2 }, { v: s.name, s: 2 }, { v: s.url({ inn: '' }), s: 2 }]);
    src.push([null], [{ v: 'Красная ячейка — фактор найден; жёлтая — автоматически проверить не удалось или нужна ручная проверка по ссылке (это не означает «чисто»); пустая — фактор не обнаружен.', s: 0 }]);

    const blob = buildXlsx([
      { name: 'Факторы', rows: matrix, widths: [34, 14, 16, ...lastFactors.map(() => 38), 12], freeze: { col: 1, row: 1 }, headerHeight: 62 },
      { name: 'Источники', rows: src, widths: [10, 60, 70] },
    ]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `negative_factors_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
})();
