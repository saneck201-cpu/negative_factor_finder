/* Описание отрицательных факторов (столбцы итоговой таблицы).
   needs — какой запрос к провайдеру нужен, чтобы проверить фактор. */
(function (global) {
  const FACTORS = [
    { id: 'status',     title: 'Ликвидация / реорганизация / исключение из ЕГРЮЛ', needs: 'company' },
    { id: 'unreliable', title: 'Недостоверные сведения в ЕГРЮЛ',                   needs: 'company' },
    { id: 'massaddr',   title: 'Адрес массовой регистрации',                       needs: 'company' },
    { id: 'massperson', title: 'Массовый руководитель / учредитель',               needs: 'company' },
    { id: 'rnp',        title: 'Реестр недобросовестных поставщиков',              needs: 'company' },
    { id: 'taxdebt',    title: 'Налоговая задолженность / штрафы',                 needs: 'company' },
    { id: 'chdir',      title: 'Смена руководителя за период',                     needs: 'timeline' },
    { id: 'chowner',    title: 'Смена собственника / учредителей за период',       needs: 'timeline' },
    { id: 'chaddr',     title: 'Смена адреса за период',                           needs: 'timeline' },
    { id: 'fssp',       title: 'Исполнительные производства (ФССП)',               needs: 'enforcements' },
    { id: 'courts',     title: 'Арбитражные дела в роли ответчика / проигранные',  needs: 'legal-cases' },
    { id: 'bankr',      title: 'Банкротство (ЕФРСБ)',                              needs: 'bankruptcy-messages' },
    { id: 'fedres',     title: 'Тревожные сообщения на Федресурсе',                needs: 'fedresurs' },
    { id: 'inspect',    title: 'Проверки с выявленными нарушениями',               needs: 'inspections' },
    { id: 'fin',        title: 'Убыток / отрицательный капитал (отчётность)',      needs: 'finances' },
  ];
  global.FACTORS = FACTORS;
})(typeof window !== 'undefined' ? window : globalThis);
