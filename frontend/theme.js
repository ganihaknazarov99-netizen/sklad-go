/* Вид программы: светлая или тёмная.

   Светлая стоит по умолчанию — в лавке смотрят с яркого экрана при дневном
   свете, да и привычнее она, как бумага. Кому нужна тёмная, тот выберет сам.

   Файл подключается первым, до всего остального: если применить цвет позже,
   экран на миг мигнёт чужим. По той же причине здесь нет ничего лишнего. */
(function () {
  'use strict';
  var KEY = 'skladgo.theme';
  var root = document.documentElement;

  function apply(v) {
    if (v === 'auto') root.removeAttribute('data-theme');   // как на телефоне
    else root.setAttribute('data-theme', v);
  }

  var cur = 'light';
  try { cur = localStorage.getItem(KEY) || 'light'; } catch (e) { /* приватный режим */ }
  if (cur !== 'light' && cur !== 'dark' && cur !== 'auto') cur = 'light';
  apply(cur);

  window.SkladTheme = {
    get: function () { return cur; },
    set: function (v) {
      cur = (v === 'dark' || v === 'auto') ? v : 'light';
      try { localStorage.setItem(KEY, cur); } catch (e) { /* ничего */ }
      apply(cur);
    }
  };
})();
