'use strict';
/* Экран входа показательной версии (корневой backend.js) с подключённым Supabase.
   Когда вход через Google срывается, Supabase возвращает человека на склад
   с ошибкой в адресе. Раньше программа молча показывала кнопку «Войти» —
   и хозяин решил, что вошёл, хотя вход трижды падал из-за неверного ключа. */
const test = require('node:test');
const assert = require('node:assert/strict');

// Поддельные окно и Supabase: сессии нет, значит, программа покажет экран входа
function загрузить({ search = '', hash = '' } = {}) {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, style: {}, innerHTML: '', textContent: '', onclick: null });
  const заменено = [];
  global.window = global;
  global.document = { readyState: 'complete', getElementById: el, addEventListener() {}, body: { appendChild() {} }, createElement: () => ({}) };
  global.location = { search, hash, pathname: '/', href: 'https://skladgo.vercel.app/' + search + hash };
  global.history = { replaceState: (a, b, url) => заменено.push(url) };
  global.SKLAD_CONFIG = { url: 'https://example.supabase.co', anonKey: 'sb_publishable_test' };
  global.supabase = {
    createClient: () => ({
      auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange() {} },
      from() {}, rpc() {}, channel() {}, removeChannel() {},
    }),
  };
  delete require.cache[require.resolve('../../backend.js')];
  require('../../backend.js');
  return { els, заменено };
}
const дождаться = () => new Promise((r) => setImmediate(r));

test('сорвавшийся обмен ключа с Google — человек видит, что вход не удался', async () => {
  const { els, заменено } = загрузить({
    search: '?error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code%3A+4%2F0A',
  });
  await дождаться();
  assert.match(els.ae.textContent, /Google не подтвердил вход/);
  assert.match(els.ae.textContent, /хозяину/, 'человек понимает, к кому идти');
  assert.deepEqual(заменено, ['/'], 'ошибка убрана из адреса, после обновления не висит');
});

test('Supabase кладёт ошибку и в хвост адреса, с двойной кодировкой — тоже узнаём', async () => {
  const { els } = загрузить({
    hash: '#error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code%253A+4%252F0A&sb=',
  });
  await дождаться();
  assert.match(els.ae.textContent, /Google не подтвердил вход/);
});

test('человек сам нажал «Отмена» у Google — так и говорим', async () => {
  const { els } = загрузить({ hash: '#error=access_denied&error_description=The+user+denied' });
  await дождаться();
  assert.match(els.ae.textContent, /Вход отменён/);
});

test('чужая разметка из адреса на экран не попадает', async () => {
  const { els } = загрузить({
    search: '?error=server_error&error_description=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%3Ca%20href%3Dhttps%3A%2F%2Fevil.example%3E%D0%92%D0%BE%D0%B9%D1%82%D0%B8',
  });
  await дождаться();
  assert.equal(els.ae.textContent, 'Не удалось войти через Google. Попробуйте ещё раз.', 'своими словами, а не текстом из адреса');
  // своя картинка (логотип) в экране входа есть — ищем то, чего в честной разметке не бывает
  assert.ok(!/onerror|evil\.example/.test(els.auth.innerHTML), 'в разметку экрана чужое не вставлено');
  assert.ok(!/onerror|evil/.test(els.ae.textContent));
});

test('обычный вход без ошибки — экран чистый, адрес не трогаем', async () => {
  const { els, заменено } = загрузить();
  await дождаться();
  assert.ok(!els.ae || els.ae.textContent === '', 'поле сообщения пустое');   // без ошибки программа его и не трогает
  assert.match(els.auth.innerHTML, /Войти через Google/);
  assert.deepEqual(заменено, []);
});
