'use strict';
/* Поддельный почтовый сервер: отвечает как настоящий и запоминает весь разговор.
   Так видно не только «письмо ушло», но и что именно мы сказали в линию.
   Для проверки входа с паролем он поднимается по-настоящему шифрованным:
   одноразовый сертификат делаем здесь же и выбрасываем. */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const smtp = require('../src/smtp');
const { makeMailer } = require('../src/mailer');

// --- одноразовый сертификат для шифрованного поддельного сервера ---
// Пустая строка здесь не годится: node:test считает пропуском любую строку, даже пустую
let СЕРТ = null, безСертификата = false;
try {
  const дом = fs.mkdtempSync(path.join(os.tmpdir(), 'skladgo-smtp-'));
  const ключ = path.join(дом, 'key.pem'), серт = path.join(дом, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', ключ, '-out', серт,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  СЕРТ = { key: fs.readFileSync(ключ), cert: fs.readFileSync(серт), дом };
} catch (e) {
  безСертификата = 'нет openssl — вход с паролем проверить нечем: ' + (e.message || e);
}
test.after(() => { if (СЕРТ) fs.rmSync(СЕРТ.дом, { recursive: true, force: true }); });

function почтовыйСервер({ возможности = ['AUTH PLAIN LOGIN'], пароль = 'ok', шифрованный = false, рватьНаSTARTTLS = false } = {}) {
  const разговоры = [];
  const обслужить = (сокет) => {
    const сказано = []; разговоры.push(сказано);
    let буфер = '', вДанных = false, письмо = [];
    сокет.setEncoding('utf8');
    сокет.write('220 почта готова\r\n');
    сокет.on('data', (d) => {
      буфер += d;
      let i;
      while ((i = буфер.indexOf('\r\n')) >= 0) {
        const строка = буфер.slice(0, i); буфер = буфер.slice(i + 2);
        if (вДанных) {
          if (строка === '.') { вДанных = false; сказано.push({ письмо: письмо.join('\r\n') }); письмо = []; сокет.write('250 принято\r\n'); }
          else письмо.push(строка);
          continue;
        }
        сказано.push(строка);
        const верх = строка.toUpperCase();
        const предыдущая = (н) => String(сказано[сказано.length - н] || '').toUpperCase();
        if (верх.startsWith('EHLO')) сокет.write(['250-привет'].concat(возможности.map((в) => '250-' + в)).join('\r\n') + '\r\n250 SIZE 35882577\r\n');
        else if (верх === 'STARTTLS') { сокет.write('220 начинаем шифрование\r\n'); if (рватьНаSTARTTLS) сокет.destroy(); }
        else if (верх === 'AUTH LOGIN') сокет.write('334 VXNlcm5hbWU6\r\n');
        else if (верх.startsWith('AUTH PLAIN')) сокет.write((пароль === 'ok' ? '235 вошли' : '535 5.7.8 Username and Password not accepted') + '\r\n');
        else if (предыдущая(2) === 'AUTH LOGIN') сокет.write('334 UGFzc3dvcmQ6\r\n');
        else if (предыдущая(3) === 'AUTH LOGIN') сокет.write((пароль === 'ok' ? '235 вошли' : '535 5.7.8 Username and Password not accepted') + '\r\n');
        else if (верх.startsWith('MAIL FROM') || верх.startsWith('RCPT TO')) сокет.write('250 ок\r\n');
        else if (верх === 'DATA') { вДанных = true; сокет.write('354 диктуйте\r\n'); }
        else if (верх === 'QUIT') { сокет.write('221 пока\r\n'); сокет.end(); }
        else сокет.write('250 ок\r\n');
      }
    });
    сокет.on('error', () => { /* клиент ушёл — для теста неважно */ });
  };
  const сервер = шифрованный ? tls.createServer({ key: СЕРТ.key, cert: СЕРТ.cert }, обслужить) : net.createServer(обслужить);
  return {
    разговоры,
    письмо: () => (разговоры[0] || []).map((x) => x && x.письмо).find(Boolean),
    команды: () => (разговоры[0] || []).filter((x) => typeof x === 'string'),
    слушать: () => new Promise((r) => сервер.listen(0, '127.0.0.1', () => r(сервер.address().port))),
    закрыть: () => new Promise((r) => сервер.close(r)),
  };
}
const тело = (письмо) => Buffer.from(письмо.slice(письмо.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, ''), 'base64').toString('utf8');

test('письмо доходит: весь разговор с сервером идёт по порядку', async (ctx) => {
  const с = почтовыйСервер();
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  await smtp.отправить(
    { host: '127.0.0.1', port: порт, secure: false, ehlo: 'sklad-go' },
    { from: 'Sklad Go <shop@example.com>', to: 'gani@example.com', subject: 'Sklad Go: код подтверждения', text: 'Ваш код: 123456' }
  );

  const р = с.команды();
  assert.equal(р[0], 'EHLO sklad-go');
  assert.ok(р.includes('MAIL FROM:<shop@example.com>'), 'отправитель берётся из угловых скобок: ' + р.join(' | '));
  assert.ok(р.includes('RCPT TO:<gani@example.com>'));
  assert.ok(р.includes('DATA'));
  assert.ok(р.includes('QUIT'));
});

test('русский текст и тема доходят целыми', async (ctx) => {
  const с = почтовыйСервер();
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());
  const текст = 'Ваш код подтверждения: 482913\n\nКод действует 15 минут.';

  await smtp.отправить({ host: '127.0.0.1', port: порт, secure: false },
    { from: 'Sklad Go <shop@example.com>', to: 'gani@example.com', subject: 'Sklad Go: код подтверждения почты', text: текст });

  const письмо = с.письмо();
  const тема = /^Subject: ([\s\S]*?)\r\n(?=\S+:)/m.exec(письмо)[1];
  const развёрнуто = тема.split(/\r\n\s+/).map((кусок) => {
    const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(кусок.trim());
    return m ? Buffer.from(m[1], 'base64').toString('utf8') : кусок;
  }).join('');
  assert.equal(развёрнуто, 'Sklad Go: код подтверждения почты');
  assert.equal(тело(письмо), текст, 'текст письма должен дойти буква в букву');
  for (const строка of письмо.split('\r\n')) assert.ok(строка.length <= 998, 'слишком длинная строка: ' + строка.length);
});

test('точка в начале строки не обрывает письмо на полуслове', async (ctx) => {
  const с = почтовыйСервер();
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());
  const текст = 'Долг закрыт.\n.\nЭто вторая половина письма.';

  await smtp.отправить({ host: '127.0.0.1', port: порт, secure: false },
    { from: 'a@example.com', to: 'b@example.com', subject: 'Проверка', text: текст });

  assert.equal(тело(с.письмо()), текст);
});

test('пароль не уходит по открытой линии, если сервер не предлагает шифрование', async (ctx) => {
  const с = почтовыйСервер({ возможности: ['AUTH PLAIN LOGIN'] });   // STARTTLS не предложен
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  await assert.rejects(
    () => smtp.отправить({ host: '127.0.0.1', port: порт, secure: false, user: 'shop@example.com', pass: 'тайна' },
      { from: 'a@example.com', to: 'b@example.com', subject: 'Проверка', text: 'привет' }),
    /шифрование/
  );
  const всё = JSON.stringify(с.разговоры);
  assert.ok(!всё.includes('AUTH'), 'вход даже не начинали');
  assert.ok(!всё.includes(Buffer.from('тайна', 'utf8').toString('base64')), 'пароль в линию не попал');
  assert.ok(!всё.includes('тайна'));
});

test('если сервер умеет шифрование, мы его просим прежде, чем вводить пароль', async (ctx) => {
  const с = почтовыйСервер({ возможности: ['STARTTLS', 'AUTH PLAIN LOGIN'], рватьНаSTARTTLS: true });
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  // Поддельный сервер после «220 начинаем» рвёт связь: настоящим TLS ему не стать.
  // Нам важно другое: STARTTLS прозвучал, а пароль — нет.
  await assert.rejects(() => smtp.отправить(
    { host: '127.0.0.1', port: порт, secure: false, user: 'shop@example.com', pass: 'тайна' },
    { from: 'a@example.com', to: 'b@example.com', subject: 'Проверка', text: 'привет' }));

  const р = с.команды();
  assert.ok(р.includes('STARTTLS'), 'шифрование должны были запросить: ' + р.join(' | '));
  assert.ok(!JSON.stringify(р).includes('AUTH'), 'до пароля дело дойти не должно было');
});

test('по шифрованной линии пароль передаётся и письмо уходит', { skip: безСертификата }, async (ctx) => {
  const с = почтовыйСервер({ шифрованный: true });
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  await smtp.отправить(
    { host: 'localhost', port: порт, secure: true, user: 'shop@example.com', pass: 'пароль-приложения', ca: СЕРТ.cert },
    { from: 'Sklad Go <shop@example.com>', to: 'gani@example.com', subject: 'Код', text: 'Ваш код: 777' }
  );

  const р = с.команды();
  const ожидали = Buffer.from('\0shop@example.com\0пароль-приложения', 'utf8').toString('base64');
  assert.ok(р.includes('AUTH PLAIN ' + ожидали), 'пароль передан как PLAIN: ' + р.join(' | '));
  assert.ok(тело(с.письмо()).includes('777'));
});

test('если сервер умеет только LOGIN, входим по LOGIN', { skip: безСертификата }, async (ctx) => {
  const с = почтовыйСервер({ шифрованный: true, возможности: ['AUTH LOGIN'] });
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  await smtp.отправить(
    { host: 'localhost', port: порт, secure: true, user: 'u@example.com', pass: 'секрет', ca: СЕРТ.cert },
    { from: 'u@example.com', to: 'b@example.com', subject: 'Код', text: 'привет' }
  );

  const р = с.команды();
  assert.ok(р.includes('AUTH LOGIN'));
  assert.ok(р.includes(Buffer.from('u@example.com', 'utf8').toString('base64')));
  assert.ok(р.includes(Buffer.from('секрет', 'utf8').toString('base64')));
});

test('неверный пароль виден в ошибке, а не теряется молча', { skip: безСертификата }, async (ctx) => {
  const с = почтовыйСервер({ шифрованный: true, пароль: 'плохой' });
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  await assert.rejects(
    () => smtp.отправить({ host: 'localhost', port: порт, secure: true, user: 'u', pass: 'не тот', ca: СЕРТ.cert },
      { from: 'u@example.com', to: 'b@example.com', subject: 'x', text: 'y' }),
    (e) => /не приняла пароль/.test(e.message) && /535/.test(e.message) && /not accepted/.test(e.message)
  );
});

test('чужому сертификату не верим: письмо не уйдёт неизвестно кому', { skip: безСертификата }, async (ctx) => {
  const с = почтовыйСервер({ шифрованный: true });
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  // тот же сервер, но сертификат не предъявлен как доверенный — соединение должно сорваться
  await assert.rejects(() => smtp.отправить(
    { host: 'localhost', port: порт, secure: true, user: 'u', pass: 'п' },
    { from: 'u@example.com', to: 'b@example.com', subject: 'x', text: 'y' }));
});

test('mailer в режиме smtp действительно отправляет письмо', async (ctx) => {
  const с = почтовыйСервер();
  const порт = await с.слушать();
  ctx.after(() => с.закрыть());

  const mailer = makeMailer({ mailMode: 'smtp', smtpHost: '127.0.0.1', smtpPort: порт, smtpSecure: false, smtpUser: '', smtpPass: '', mailFrom: 'Sklad Go <shop@example.com>' });
  await mailer.send('gani@example.com', 'Sklad Go: код входа', 'Ваш код: 999111');

  assert.ok(с.письмо().includes('From: Sklad Go <shop@example.com>'));
  assert.ok(тело(с.письмо()).includes('999111'));
  assert.equal(mailer.sent.length, 1, 'письмо попало и в журнал отправленных');
});

test('mailer в режиме smtp без адреса сервера честно ругается, а не молчит', async () => {
  const mailer = makeMailer({ mailMode: 'smtp', smtpHost: '', mailFrom: 'a@example.com' });
  await assert.rejects(() => mailer.send('b@example.com', 'тема', 'текст'), /SMTP_HOST/);
});

test('тема из одних латинских букв остаётся читаемой, её не кодируют зря', () => {
  assert.equal(smtp.темаВКодировке('Sklad Go: code 123'), 'Sklad Go: code 123');
  assert.ok(smtp.темаВКодировке('Код').startsWith('=?UTF-8?B?'));
  // длинная русская тема режется на куски, и каждый влезает в заголовок
  for (const кусок of smtp.темаВКодировке('Очень длинная тема письма про долги и склад, которая никуда не влезает целиком').split('\r\n')) {
    assert.ok(кусок.trim().length <= 75, 'кусок темы длиннее разрешённого: ' + кусок.length);
  }
});

test('адрес достаётся и из скобок, и из голой строки', () => {
  assert.equal(smtp.адрес('Sklad Go <shop@example.com>'), 'shop@example.com');
  assert.equal(smtp.адрес('shop@example.com'), 'shop@example.com');
  assert.equal(smtp.адрес('  shop@example.com  '), 'shop@example.com');
});
