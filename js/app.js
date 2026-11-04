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
    spark: ['СПАРК', 'полная автоматическая проверка по API-ключу (подключится после выдачи ключа)'],
    checko: ['Checko (тест)', 'по API-ключу'],
    demo: ['Демо для показа', 'вымышленные данные: так будет выглядеть итоговая таблица'],
  };
  const ids = Object.keys(PROVIDERS).filter((id) => dev || id === 'demo' || id === 'spark');
  let mode = LS.get('nff.provider');
  if (!ids.includes(mode)) mode = ids[0];
  $('modes').innerHTML = ids.map((id) =>
    `<label class="mode" data-id="${id}"><input type="radio" name="mode" value="${id}"><b>${MODE_TEXT[id][0]}</b><span>${MODE_TEXT[id][1]}</span></label>`).join('');
  const getMode = () => document.querySelector('input[name=mode]:checked').value;
  document.querySelector(`input[name=mode][value="${mode}"]`).checked = true;

  $('key').value = LS.get('nff.key') || '';
  $('remember').checked = !!LS.get('nff.key');
  $('factorList').innerHTML = FACTORS.map((f) =>
    `<label><input type="checkbox" value="${f.id}" checked> ${f.title}</label>`).join('');

  function refreshProvider() {
    const p = PROVIDERS[getMode()];
    document.querySelectorAll('.mode').forEach((el) => el.classList.toggle('on', el.dataset.id === p.id));
    $('demoBanner').hidden = p.id !== 'demo';
    $('keyBox').style.display = p.needsKey ? '' : 'none';
    $('hint').textContent = {
      spark: 'Подключение к СПАРК в работе: пока выбрать этот режим можно, но проверка не запустится.',
      checko: 'Тестовый режим разработчика.',
      demo: 'Демо-режим: данные вымышленные. Введите любые названия или ИНН, чтобы увидеть, как выглядит таблица.',
    }[p.id];
  }
  document.querySelectorAll('input[name=mode]').forEach((el) => el.addEventListener('change', refreshProvider));
  refreshProvider();

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
    const key = $('key').value.trim();
    if (provider.needsKey && !key) { $('status').textContent = 'Введите API-ключ.'; return; }
    const factors = FACTORS.filter((f) => document.querySelector(`#factorList input[value="${f.id}"]`).checked);
    if (!factors.length) { $('status').textContent = 'Выберите хотя бы один фактор.'; return; }

    LS.set('nff.provider', provider.id);
    if ($('remember').checked && key) LS.set('nff.key', key); else LS.del('nff.key');

    const opts = { key, factors, months: Math.max(1, +$('months').value || 12) };
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
    const matrix = [[H(getMode() === 'demo' ? 'Организация (ДЕМО: данные вымышленные)' : 'Организация'), H('ИНН'), H('ОГРН'), ...lastFactors.map((f) => H(f.title)), H('Факторов найдено')]];
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
    a.download = `${getMode() === 'demo' ? 'DEMO_' : ''}negative_factors_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
})();
