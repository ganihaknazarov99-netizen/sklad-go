'use strict';
/* Отправка письма по SMTP — без единой библиотеки, как и всё остальное в программе.
   Годится для обычной почты вроде Gmail: там нужен «пароль приложения», а не тот,
   которым вы входите сами.

   Главное правило здесь одно: пароль уходит только по шифрованному соединению —
   либо сразу (порт 465), либо после STARTTLS (порт 587). Если сервер шифрование
   не предлагает, мы молчим и не входим: лучше не отправить письмо, чем отдать
   пароль от почты тому, кто слушает линию. */
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const ОТВЕТ = /^(\d{3})([ -])([\s\S]*)$/;
const ТАЙМАУТ = 20000;

// Разговор с почтовым сервером: он отвечает строками «250-…» и последней «250 …»
function разговор(сокет) {
  let буфер = '', строки = [], готовые = [], ждущий = null, беда = null, слушатели = null;

  function провал(e) {
    беда = беда || e;
    if (ждущий) { const ж = ждущий; ждущий = null; clearTimeout(ж.часы); ж.reject(беда); }
  }
  function разобрать() {
    let i;
    while ((i = буфер.indexOf('\r\n')) >= 0) {
      const стр = буфер.slice(0, i); буфер = буфер.slice(i + 2);
      const m = ОТВЕТ.exec(стр);
      if (!m) return провал(new Error('непонятный ответ почтового сервера: ' + стр.slice(0, 100)));
      строки.push(m[3]);
      if (m[2] === ' ') {
        const о = { код: +m[1], текст: строки.join('\n') }; строки = [];
        if (ждущий) { const ж = ждущий; ждущий = null; clearTimeout(ж.часы); ж.resolve(о); }
        else готовые.push(о);
      }
    }
  }
  function слушать(s) {
    s.setEncoding('utf8');
    слушатели = {
      data: (d) => { буфер += d; разобрать(); },
      error: провал,
      close: () => провал(new Error('почтовый сервер закрыл соединение')),
    };
    for (const имя of Object.keys(слушатели)) s.on(имя, слушатели[имя]);
  }
  слушать(сокет);

  return {
    сокет: () => сокет,
    // При переходе на шифрование старый сокет отдаём TLS — свои обработчики с него
    // обязательно снимаем, иначе в них посыплются шифрованные куски вместо строк.
    заменить(новый) {
      for (const имя of Object.keys(слушатели)) сокет.removeListener(имя, слушатели[имя]);
      сокет = новый; буфер = ''; строки = []; готовые = []; беда = null;
      слушать(новый);
    },
    ответ() {
      if (готовые.length) return Promise.resolve(готовые.shift());
      if (беда) return Promise.reject(беда);
      return new Promise((resolve, reject) => {
        const часы = setTimeout(() => { ждущий = null; reject(new Error('почтовый сервер не ответил за ' + (ТАЙМАУТ / 1000) + ' с')); }, ТАЙМАУТ);
        ждущий = { resolve, reject, часы };
      });
    },
    послать(строка) { сокет.write(строка + '\r\n'); return this.ответ(); },
    конец() { try { сокет.destroy(); } catch (e) { /* и так закрыт */ } },
  };
}

function ждатьОткрытия(сокет, событие) {
  return new Promise((resolve, reject) => {
    const ок = () => { сокет.removeListener('error', нет); resolve(); };
    const нет = (e) => { сокет.removeListener(событие, ок); reject(e); };
    сокет.once(событие, ок); сокет.once('error', нет);
  });
}

// Тема письма по-русски не влезает в заголовок как есть: её кодируют кусками по RFC 2047
function темаВКодировке(s) {
  if (!/[^\x20-\x7E]/.test(s)) return s;
  const куски = []; let тек = '';
  for (const ч of String(s)) {
    const проба = тек + ч;
    if (Buffer.byteLength(проба, 'utf8') > 39 && тек) { куски.push(тек); тек = ч; } else тек = проба;
  }
  if (тек) куски.push(тек);
  return куски.map((к) => '=?UTF-8?B?' + Buffer.from(к, 'utf8').toString('base64') + '?=').join('\r\n ');
}

const адрес = (s) => { const m = /<([^>]+)>/.exec(String(s || '')); return (m ? m[1] : String(s || '')).trim(); };

function собратьПисьмо({ from, to, subject, text, дата, идентификатор }) {
  const тело = Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const домен = (адрес(from).split('@')[1] || 'sklad-go').replace(/[^\w.-]/g, '');
  return [
    'From: ' + from,
    'To: ' + to,
    'Subject: ' + темаВКодировке(subject),
    'Date: ' + (дата || new Date()).toUTCString(),
    'Message-ID: <' + (идентификатор || crypto.randomUUID()) + '@' + домен + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '', тело,
  ].join('\r\n');
}

function возможности(текст) {
  return текст.split('\n').map((с) => с.trim().toUpperCase().split(' ')[0]);
}

async function отправить(нст, письмо) {
  const порт = +нст.port || 587;
  const шифровать = нст.secure !== undefined ? !!нст.secure : порт === 465;
  const имя = нст.ehlo || os.hostname() || 'sklad-go';
  let защищено = шифровать;

  const сокет = шифровать
    ? tls.connect({ host: нст.host, port: порт, servername: нст.host, ca: нст.ca || undefined })
    : net.connect({ host: нст.host, port: порт });
  сокет.setTimeout(ТАЙМАУТ, () => сокет.destroy(new Error('почтовый сервер не отвечает')));
  await ждатьОткрытия(сокет, шифровать ? 'secureConnect' : 'connect');

  const с = разговор(сокет);
  const надо = (о, код, что) => { if (о.код !== код) throw new Error(что + ': ' + о.код + ' ' + о.текст.split('\n')[0]); };
  try {
    надо(await с.ответ(), 220, 'почтовый сервер не поздоровался');
    let о = await с.послать('EHLO ' + имя);
    надо(о, 250, 'почтовый сервер не принял приветствие');

    if (!защищено && возможности(о.текст).includes('STARTTLS')) {
      надо(await с.послать('STARTTLS'), 220, 'не удалось включить шифрование');
      const защищённый = tls.connect({ socket: с.сокет(), servername: нст.host, ca: нст.ca || undefined });
      await ждатьОткрытия(защищённый, 'secureConnect');
      с.заменить(защищённый);
      защищено = true;
      о = await с.послать('EHLO ' + имя);
      надо(о, 250, 'почтовый сервер не принял приветствие после шифрования');
    }

    if (нст.user) {
      if (!защищено) throw new Error('почтовый сервер не предлагает шифрование — пароль от почты по открытой линии не отправляем');
      const строкаAuth = о.текст.split('\n').map((с2) => с2.trim()).find((с2) => /^AUTH\b/i.test(с2)) || '';
      const способы = строкаAuth.toUpperCase().split(/[\s=]+/);
      if (способы.includes('PLAIN')) {
        надо(await с.послать('AUTH PLAIN ' + Buffer.from('\0' + нст.user + '\0' + нст.pass, 'utf8').toString('base64')), 235, 'почта не приняла пароль');
      } else if (способы.includes('LOGIN') || !строкаAuth) {
        надо(await с.послать('AUTH LOGIN'), 334, 'почта не приняла вход');
        надо(await с.послать(Buffer.from(нст.user, 'utf8').toString('base64')), 334, 'почта не приняла имя');
        надо(await с.послать(Buffer.from(нст.pass, 'utf8').toString('base64')), 235, 'почта не приняла пароль');
      } else {
        throw new Error('почтовый сервер не умеет ни PLAIN, ни LOGIN: ' + строкаAuth);
      }
    }

    надо(await с.послать('MAIL FROM:<' + адрес(письмо.from) + '>'), 250, 'почта не приняла отправителя');
    надо(await с.послать('RCPT TO:<' + адрес(письмо.to) + '>'), 250, 'почта не приняла получателя');
    надо(await с.послать('DATA'), 354, 'почта не приняла команду DATA');
    с.сокет().write(собратьПисьмо(письмо) + '\r\n.\r\n');
    надо(await с.ответ(), 250, 'письмо не принято');
    try { await с.послать('QUIT'); } catch (e) { /* попрощались — и ладно */ }
  } finally {
    с.конец();
  }
}

module.exports = { отправить, собратьПисьмо, темаВКодировке, адрес };
