/* Демо-режим: включается, когда config.js не заполнен. Сервера здесь нет — данные
   магазина кладутся в localStorage до загрузки app.js (программа читает их при старте),
   а владелец, команда и лента живут в памяти страницы. */
(function () {
  'use strict';

  /* ---------- Демо-данные магазина одежды (сомони) ----------
     Если пользователь уже что-то менял — не трогаем. */
  (function () {
    var SEED = 'skladgo.demo.v1';
    if (location.search.indexOf('reset') > -1) { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0) localStorage.removeItem(k); }); } catch (e) {} }
    try { if (localStorage.getItem(SEED)) return; } catch (e) { return; }

    var DAY = 864e5, now = Date.now(), n = 0;
    var uid = function () { return 'd' + (++n) + Date.now().toString(36); };
    function item(name, cat, color, size, price, qty) {
      return { id: uid(), name: name, cat: cat, size: size, color: color, price: price, qty: qty, ar: qty <= 0, u: 'шт', pk: 1, pb: 'pcs', ab: 'Ганӣ', ad: now - 30 * DAY };
    }
    var items = [
      item('Футболка хлопок', 'Одежда', 'Чёрный', 'M', 85, 14),
      item('Футболка хлопок', 'Одежда', 'Чёрный', 'L', 85, 9),
      item('Футболка хлопок', 'Одежда', 'Белый', 'L', 85, 2),
      item('Джинсы классика', 'Одежда', 'Синий', '32', 220, 6),
      item('Джинсы классика', 'Одежда', 'Синий', '34', 220, 3),
      item('Куртка зимняя', 'Одежда', 'Чёрный', 'L', 450, 4),
      item('Куртка зимняя', 'Одежда', 'Серый', 'XL', 450, 0),
      item('Рубашка офисная', 'Одежда', 'Белый', 'M', 160, 11),
      item('Носки упаковка', 'Аксессуары', '', '', 15, 48),
      item('Ремень кожаный', 'Аксессуары', 'Коричневый', '', 60, 7),
      item('Кепка', 'Аксессуары', 'Чёрный', '', 40, 1),
      item('Порошок стиральный', 'Хозтовары', '', '', 45, 22),
      item('Шампунь 400мл', 'Хозтовары', '', '', 28, 16)
    ];
    var lab = function (i) { return i.name + (i.size ? ' · ' + i.size : '') + (i.color ? ' · ' + i.color : ''); };
    var log = [];
    function op(i, type, qty, daysAgo, hour, by, note) {
      log.push({ by: by, t: now - daysAgo * DAY + hour * 36e5, type: type, id: items[i].id, name: lab(items[i]), qty: qty, sum: items[i].price * qty, note: note || '' });
    }
    op(0, 'out', 3, 0, -2, 'Алишер'); op(3, 'out', 1, 0, -4, 'Ганӣ'); op(8, 'out', 6, 0, -5, 'Алишер');
    op(11, 'out', 2, 0, -7, 'Ганӣ'); op(1, 'out', 2, 1, -3, 'Алишер'); op(5, 'out', 1, 1, -6, 'Ганӣ');
    op(7, 'out', 4, 2, -4, 'Алишер'); op(0, 'in', 20, 3, -8, 'Ганӣ', 'Поставка с базара');
    op(3, 'in', 10, 3, -8, 'Ганӣ', 'Поставка с базара'); op(9, 'out', 2, 4, -5, 'Алишер');
    op(12, 'out', 5, 5, -6, 'Ганӣ'); op(2, 'out', 7, 6, -4, 'Алишер');
    op(5, 'in', 6, 8, -9, 'Ганӣ', 'Зимний завоз'); op(10, 'out', 3, 9, -5, 'Алишер');
    log.sort(function (a, b) { return b.t - a.t; });

    var people = [
      { id: uid(), name: 'Фируз', phone: '+992901112233' },
      { id: uid(), name: 'Мадина', phone: '+992937778899' },
      { id: uid(), name: 'Сафар', phone: '+992505554433' },
      { id: uid(), name: 'Поставщик Рахим', phone: '+992918889900' }
    ];
    var ops = [], dstr = function (d) { return new Date(now + d * DAY).toISOString().slice(0, 10); };
    function debt(p, type, amt, daysAgo, note, due) {
      ops.push({ id: uid(), pid: people[p].id, type: type, amt: amt, t: now - daysAgo * DAY, due: due || '', note: note, calc: '', by: 'Ганӣ', at: now - daysAgo * DAY });
    }
    debt(0, 'give', 450, 12, 'Куртка зимняя', dstr(-4));
    debt(0, 'get', 150, 5, 'Частично вернул');
    debt(1, 'give', 220, 3, 'Джинсы', dstr(7));
    debt(2, 'give', 85, 1, 'Футболка', dstr(14));
    debt(2, 'get', 85, 0, 'Вернул полностью');
    debt(3, 'get', 1200, 6, 'Товар на реализацию', dstr(10));

    try {
      localStorage.setItem('skladgo.v1', JSON.stringify({ items: items, log: log, cats: ['Одежда', 'Аксессуары', 'Хозтовары', 'Другое'], biz: 'Магазин Ганӣ' }));
      localStorage.setItem('skladgo.debts', JSON.stringify({ people: people, ops: ops }));
      localStorage.setItem('skladgo.me', JSON.stringify({ name: 'Ганӣ', phone: '+992 90 000 00 01', mail: 'demo@sklad.go' }));
      localStorage.setItem(SEED, '1');
    } catch (e) {}
  })();

  /* ---------- Владелец, команда и лента — без сервера ---------- */
  window.skladLoadJS('app.js').then(function () {
    isOwn = true;
    myId = 'demo-owner';
    staff = [
      { _id: 'demo-owner', uid: 'demo-owner', name: 'Ганӣ', phone: '+992 90 000 00 01', mail: 'demo@sklad.go', owner: true, status: 'active', t: Date.now() },
      { _id: 'demo-s1', uid: 'demo-s1', name: 'Алишер', phone: '+992 90 000 00 02', mail: 'alisher@sklad.go', owner: false, status: 'active', t: Date.now() },
      { _id: 'demo-s2', uid: 'demo-s2', name: 'Нигина', phone: '+992 90 000 00 03', mail: 'nigina@sklad.go', owner: false, status: 'pending', t: Date.now() }
    ];
    var t0 = Date.now();
    actList = [
      { t: t0 - 36e5, by: 'Алишер', txt: 'записал долг: Мадина · 220 сом' },
      { t: t0 - 72e5, by: 'Алишер', txt: 'продал 3 × Футболка хлопок · M · Чёрный' },
      { t: t0 - 108e5, by: 'Ганӣ', txt: 'добавил товар «Куртка зимняя · L · Чёрный»' }
    ];
    // В демо подтверждение и блокировка сотрудника меняют список на месте, без сервера.
    setSt = function (id, st) {
      staff.forEach(function (x) { if (x._id === id) x.status = st; });
      logAct(st === 'active' ? 'разрешил доступ сотруднику' : 'заблокировал сотрудника');
      toast(st === 'active' ? '✓ Доступ разрешён' : '⛔ Доступ закрыт');
      render();
    };
    // Лента изменений в демо пополняется локально (на сервере это делает сам сервер).
    logAct = function (txt) { actList.unshift({ t: Date.now(), by: ME ? ME.name : '', txt: txt }); };

    var wipe = function () {
      try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('skladgo.') === 0) localStorage.removeItem(k); }); } catch (e) {}
    };
    // «Сбросить» — вернуть показательные данные магазина
    document.getElementById('demoreset').onclick = function () { wipe(); location.reload(); };
    // «Начать свой склад» — пустой склад вместо чужих курток: метку засева ставим,
    // а данные не кладём, поэтому при перезагрузке демо-товары не вернутся
    document.getElementById('democlean').onclick = function () {
      if (this.dataset.ok !== '1') { this.dataset.ok = '1'; this.textContent = 'Точно? Нажмите ещё раз'; return; }
      wipe();
      try {
        localStorage.setItem('skladgo.demo.v1', '1');
        localStorage.setItem('skladgo.me', JSON.stringify({ name: 'Хозяин', phone: '', mail: '' }));
      } catch (e) {}
      location.href = location.pathname;   // уходим с ?reset, иначе демо-данные вернутся
    };

    render();
    setTimeout(function () { toast('Это демо: меняйте остатки и долги — всё сохранится в браузере', true); }, 400);
  });
})();
