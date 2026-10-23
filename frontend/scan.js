/* Камера-сканер штрихкодов. Использует встроенный сканер браузера (Android Chrome), а если его нет (iPhone, компьютер) —
   собственное распознавание из barcode.js. Работает полностью на телефоне, картинки никуда не отправляются. */
(function (root) {
  'use strict';
  var T = function (s) { return root.T ? root.T(s) : s; };
  var NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

  function nativeDetector() {
    if (!('BarcodeDetector' in root)) return Promise.resolve(null);
    var get = root.BarcodeDetector.getSupportedFormats ? root.BarcodeDetector.getSupportedFormats() : Promise.resolve(NATIVE);
    return get.then(function (sup) {
      var f = NATIVE.filter(function (x) { return sup.indexOf(x) >= 0; });
      return f.length ? new root.BarcodeDetector({ formats: f }) : null;
    }).catch(function () { return null; });
  }
  function toGray(img) {
    var d = img.data, n = img.width * img.height, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  }
  function explain(e) {
    var n = e && e.name;
    if (!root.isSecureContext || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return T('Камера работает только по защищённому соединению (HTTPS)');
    if (n === 'NotAllowedError' || n === 'SecurityError') return T('Нет доступа к камере. Разрешите камеру в настройках браузера');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return T('Камера не найдена');
    return T('Не удалось включить камеру');
  }

  // Подключает камеру к контейнеру box. Возвращает управление: stop(), torch(on).
  function mount(box, opts) {
    opts = opts || {};
    var video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
    var frame = document.createElement('div'); frame.className = 'frame';
    box.innerHTML = ''; box.appendChild(video); box.appendChild(frame);
    var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    var stream = null, stopped = false, timer = null, det = null, frameNo = 0, busy = false;
    var lastText = '', lastHits = 0, lastAt = 0, cool = { text: '', until: 0 };
    var ctl = { torchOk: false, stop: stop, torch: torch };

    function stop() {
      stopped = true; clearTimeout(timer);
      if (stream) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); stream = null; }
      try { video.srcObject = null; } catch (e) {}
    }
    function torch(on) {
      var tr = stream && stream.getVideoTracks()[0];
      if (!tr) return Promise.resolve(false);
      return tr.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () { return true; }, function () { return false; });
    }
    // Один и тот же код должен подтвердиться дважды, чтобы исключить случайные ошибки распознавания
    function accept(text, format, native) {
      var now = Date.now();
      if (text === cool.text && now < cool.until) return;
      if (text === lastText && now - lastAt < 1500) lastHits++; else { lastText = text; lastHits = 1; }
      lastAt = now;
      if (lastHits >= (native ? 1 : 2)) {
        lastText = ''; lastHits = 0;
        cool = { text: text, until: now + (opts.cooldown || 1800) };
        opts.onCode && opts.onCode(root.SkladBarcode ? root.SkladBarcode.normalize(text) : text, { format: format });
      }
    }
    function tick() {
      if (stopped) return;
      timer = setTimeout(tick, 110);
      if (busy || video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      var done = function () { busy = false; };
      if (det) {
        det.detect(video).then(function (r) { if (r && r.length) accept(r[0].rawValue, r[0].format, true); else jsDecode(); done(); }, function () { jsDecode(); done(); });
      } else { jsDecode(); done(); }
    }
    function jsDecode() {
      if (!root.SkladBarcode) return;
      var vw = video.videoWidth, vh = video.videoHeight, k = Math.min(1, 800 / Math.max(vw, vh));
      var w = Math.round(vw * k), h = Math.round(vh * k);
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      var r = root.SkladBarcode.decodeFrame(toGray(ctx.getImageData(0, 0, w, h)), w, h, frameNo++);
      if (r) accept(r.text, r.format, false);
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { opts.onError && opts.onError(explain()); return ctl; }
    nativeDetector().then(function (d) { det = d; });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then(function (s) {
      if (stopped) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      stream = s; video.srcObject = s;
      var tr = s.getVideoTracks()[0], caps = tr.getCapabilities ? tr.getCapabilities() : {};
      ctl.torchOk = !!caps.torch;
      try { if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
      video.play().catch(function () {});
      opts.onReady && opts.onReady(ctl);
      tick();
    }, function (e) { opts.onError && opts.onError(explain(e)); });
    return ctl;
  }

  // Распознать штрихкод на готовой фотографии (когда живая камера недоступна или нужна точность).
  // Файл читаем без временных ссылок blob: — их не пропускает политика безопасности страницы.
  function viaReader(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }
  function loadImage(file) {
    return root.createImageBitmap ? root.createImageBitmap(file).catch(function () { return viaReader(file); }) : viaReader(file);
  }
  function decodeFile(file) {
    return loadImage(file).then(function (img) {
      var k = Math.min(1, 1600 / Math.max(img.width, img.height)), w = Math.round(img.width * k), h = Math.round(img.height * k);
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
      return nativeDetector().then(function (d) { return d ? d.detect(c).catch(function () { return []; }) : []; }).then(function (r) {
        if (r && r.length) return { text: root.SkladBarcode.normalize(r[0].rawValue), format: r[0].format };
        var res = root.SkladBarcode.decodeImage(toGray(x.getImageData(0, 0, w, h)), w, h);
        if (!res) { // ещё одна попытка в уменьшенном виде: помогает при сильно мелком коде на большом снимке
          var c2 = document.createElement('canvas'); c2.width = Math.round(w / 2); c2.height = Math.round(h / 2);
          var x2 = c2.getContext('2d', { willReadFrequently: true }); x2.drawImage(c, 0, 0, c2.width, c2.height);
          res = root.SkladBarcode.decodeImage(toGray(x2.getImageData(0, 0, c2.width, c2.height)), c2.width, c2.height);
        }
        return res ? { text: root.SkladBarcode.normalize(res.text), format: res.format } : null;
      });
    }).catch(function () { return null; });
  }
  root.SkladScan = { mount: mount, decodeFile: decodeFile };
})(typeof window !== 'undefined' ? window : globalThis);
