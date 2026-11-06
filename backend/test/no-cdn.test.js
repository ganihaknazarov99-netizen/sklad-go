'use strict';
/* Страница не грузит чужие скрипты: supabase-js с jsdelivr убран, CSP закрыта.
   И адрес с url+ключом без библиотеки открывается как демо, а не падает. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const csp = (s) => /Content-Security-Policy"[^>]*content="([^"]+)"/.exec(s)[1];

test('index.html, vercel.json и sw.js не ссылаются на jsdelivr и supabase.co', () => {
  for (const f of ['index.html', 'vercel.json', 'sw.js']) {
    assert.doesNotMatch(read(f), /cdn\.jsdelivr\.net|supabase\.co|supabase\.js/i, f);
  }
  assert.doesNotMatch(read('index.html'), /<script[^>]+src="https?:/i, 'все скрипты — свои');
});

test('CSP в index.html и vercel.json одинаковая (frame-ancestors — только в заголовке)', () => {
  const meta = csp(read('index.html'));
  const hdr = JSON.parse(read('vercel.json')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  const rest = hdr.split('; ').filter((d) => !d.startsWith('frame-ancestors')).join('; ');
  assert.equal(meta, rest);
  assert.match(hdr, /frame-ancestors 'none'/);
  assert.match(meta, /script-src 'self';/);
  assert.match(meta, /connect-src 'self';/);
});

test('адрес с url и ключом, но без библиотеки supabase, открывается как демо', async () => {
  const loaded = [];
  const body = { appendChild: (s) => { loaded.push(s.src); setImmediate(() => s.onload && s.onload()); } };
  const el = () => ({ style: {}, dataset: {}, innerHTML: '', textContent: '' });
  const window = { SKLAD_CONFIG: { url: 'https://x.supabase.co', anonKey: 'k' }, addEventListener() {} };
  window.window = window;
  const ctx = vm.createContext({
    window, document: { body, readyState: 'complete', createElement: () => ({}), getElementById: el, addEventListener() {} },
    navigator: { onLine: true }, location: { href: 'https://x/', search: '', hash: '', hostname: 'x' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, URLSearchParams, Promise, setTimeout, console,
  });
  ctx.self = ctx;
  vm.runInContext(read('backend.js'), ctx);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(loaded, ['demo.js']);
});
