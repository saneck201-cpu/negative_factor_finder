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
  for (const p of Object.values(PROVIDERS)) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.title; $('provider').appendChild(o);
  }
  $('provider').value = LS.get('nff.provider') || 'checko';
  $('key').value = LS.get('nff.key') || '';
  $('remember').checked = !!LS.get('nff.key');
  $('proxy').value = LS.get('nff.proxy') || '';
  $('factorList').innerHTML = FACTORS.map((f) =>
    `<label><input type="checkbox" value="${f.id}" checked> ${f.title}</label>`).join('');

  function refreshProvider() {
    const p = PROVIDERS[$('provider').value];
    $('keyBox').style.display = p.needsKey ? '' : 'none';
    $('hint').textContent = p.needsKey
      ? 'Ключ берётся в личном кабинете провайдера (Checko.ru, есть бесплатный тариф с лимитом запросов). На одну организацию тратится до 8 запросов — отключите ненужные факторы, чтобы экономить лимит.'
      : 'Демо-режим: данные выдуманные, нужен только чтобы посмотреть, как выглядит таблица.';
  }
  $('provider').addEventListener('change', refreshProvider);
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
    const provider = PROVIDERS[$('provider').value];
    const key = $('key').value.trim();
    if (provider.needsKey && !key) { $('status').textContent = 'Введите API-ключ.'; return; }
    const factors = FACTORS.filter((f) => document.querySelector(`#factorList input[value="${f.id}"]`).checked);
    if (!factors.length) { $('status').textContent = 'Выберите хотя бы один фактор.'; return; }

    LS.set('nff.provider', provider.id);
    LS.set('nff.proxy', $('proxy').value.trim());
    if ($('remember').checked && key) LS.set('nff.key', key); else LS.del('nff.key');

    const opts = { key, factors, months: Math.max(1, +$('months').value || 12), proxy: $('proxy').value.trim() };
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
      const name = r.found ? `${esc(r.name)}<span class="src">ИНН ${esc(r.inn || '—')}</span>` : `${esc(r.query)}<span class="src">${esc(r.error || 'организация не найдена')}</span>`;
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
        { v: r.found ? r.name : `${r.query} (не найдена${r.error ? ': ' + r.error : ''})`, s: 5 },
        { v: r.inn || '', s: 2 },
        { v: r.ogrn || '', s: 2 },
        ...lastFactors.map((f) => {
          const c = r.cells[f.id];
          const st = !c || c.state === 'none' ? 2 : c.state === 'hit' ? 3 : 4;
          return { v: cellText(c), s: st };
        }),
        { v: hitsCount(r), s: 2 },
      ]);
    }
    const src = [[H('Сокр.'), H('Источник'), H('Ссылка')]];
    for (const [k, s] of Object.entries(SOURCES_LIST)) src.push([{ v: k, s: 2 }, { v: s.name, s: 2 }, { v: s.url({ inn: '' }), s: 2 }]);
    src.push([null], [{ v: 'Красная ячейка — фактор найден; жёлтая — проверить не удалось (это не означает «чисто»); пустая — фактор не обнаружен.', s: 0 }]);

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
