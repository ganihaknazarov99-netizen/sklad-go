'use strict';
/* Экран «Ожидайте подтверждения» (app.js и frontend/app.js: mystatus, render, staffSnap).

   Так было у хозяина при первом входе: заполнил регистрацию — программа показала
   «Ожидайте подтверждения», а база тут же записала его хозяином. Список команды
   приехал, но экран не сменился, пока хозяин сам не нажал «Проверить снова».

   Почему: экран перерисовывается, когда статус меняется, а прошлый статус помнил
   только обработчик списка команды. «Ожидайте» нарисовала форма регистрации мимо
   него, и приход «вы хозяин» выглядел как «было открыто — открыто и осталось».

   Берём настоящие функции из программы, а не их пересказ. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function загрузить(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const взять = (name) => {
    const m = new RegExp('^function ' + name + '\\(.*\\}$', 'm').exec(src)          // в одну строку
      || new RegExp('^function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}', 'm').exec(src);  // до скобки в начале строки
    assert.ok(m, file + ': не нашлась функция ' + name + ' — тест устарел');
    return m[0];
  };
  // Окружение программы: что нарисовано на экране, пишем в «показано»
  return new Function(`
    var staff=[],myId='me',isOwn=false,ME=null,sdb={},lastSt='',tab='stock',staffReady=false,els={},показано=[];
    var window={claude:{}},localStorage={setItem:function(){}};
    function $(id){return els[id]||(els[id]={innerHTML:'',style:{}})}
    function gate(){показано.push('регистрация')}
    function wait(st){показано.push(st==='blocked'?'закрыто':'ожидайте')}
    function booting(){показано.push('загрузка')}
    function nav(){} function hist(){} function debt(){} function botTab(){} function team(){}
    function stock(){показано.push('склад')}
    ${взять('mystatus')}
    ${взять('restore')}
    ${взять('staffSnap')}
    ${взять('render')}
    return {
      список: function (rows) { staffSnap({ docs: rows.map(function (r) { return { id: r.uid, data: function () { return r; } }; }) }); },
      зарегистрироваться: function () { ME = { name: 'Гани', phone: '+992900000000', mail: 'gani@gmail.com', fresh: true }; render(); },
      сейчас: function () { return показано[показано.length - 1]; },
      показано: показано
    };
  `)();
}

for (const file of ['app.js', 'frontend/app.js']) {
  test(file + ': хозяин зарегистрировался — склад открывается сам, без «Проверить снова»', () => {
    const app = загрузить(file);
    app.список([]);                       // вошёл впервые: в команде пока никого
    app.зарегистрироваться();
    assert.equal(app.сейчас(), 'ожидайте', 'пока база не ответила, программа честно ждёт');
    app.список([{ uid: 'me', owner: true, status: 'active' }]);   // база записала хозяином
    assert.equal(app.сейчас(), 'склад', 'экран обязан смениться сам: ' + app.показано.join(' → '));
  });

  test(file + ': продавец ждёт, пока хозяин не разрешит, — и открывается сам', () => {
    const app = загрузить(file);
    app.список([]);
    app.зарегистрироваться();
    app.список([{ uid: 'me', owner: false, status: 'pending' }]);
    assert.ok(!app.показано.includes('склад'), 'до разрешения склад не мелькает: ' + app.показано.join(' → '));
    assert.equal(app.сейчас(), 'ожидайте');
    app.список([{ uid: 'me', owner: false, status: 'active' }]);   // хозяин нажал «Разрешить»
    assert.equal(app.сейчас(), 'склад');
  });

  test(file + ': хозяин закрыл доступ — продавец видит это сразу', () => {
    const app = загрузить(file);
    app.список([]);
    app.зарегистрироваться();
    app.список([{ uid: 'me', owner: false, status: 'active' }]);
    assert.equal(app.сейчас(), 'склад');
    app.список([{ uid: 'me', owner: false, status: 'blocked' }]);
    assert.equal(app.сейчас(), 'закрыто');
  });
}
