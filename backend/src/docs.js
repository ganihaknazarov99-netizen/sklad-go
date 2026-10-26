'use strict';
// Хранилище документов (path = коллекция/id) с проверкой прав и рассылкой изменений (SSE).
const { HttpError } = require('./http');
const S = require('./security');
const { newInvite } = require('./db');

const PATH_RE = /^([a-z][a-z0-9_]{0,31})\/([A-Za-z0-9_.:-]{1,128})$/;
const COL_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PUBLIC_COLLECTIONS = new Set(['warehouse', 'activity']); // + виртуальные: staff, meta

function makeDocs(ctx) {
  const { db, cfg, auth } = ctx;
  const clients = new Set();          // открытые SSE-подключения
  const tickets = new Map();          // одноразовые билеты для SSE

  const isActive = (u) => u.role === 'owner' || u.status === 'active';

  /* ----- каждый магазин живёт отдельно -----
     Снаружи адреса прежние: warehouse/main, activity/<id>. Внутри к ним
     приписывается магазин спрашивающего, поэтому чужое увидеть нельзя
     даже случайно: запрос просто не найдёт такого пути. */
  const pre = (u) => 's/' + u.shop_id + '/';
  const store = (u, path) => pre(u) + path;

  /* ----- закупочные цены: их видит только владелец -----
     Сотруднику документ склада уходит без поля cp, а когда он присылает
     свою версию обратно, цены берутся из того, что уже лежит на сервере.
     Иначе продавец, сохранив склад, стёр бы их все. */
  const COST = 'cp';
  const isMainDoc = (col, id) => col === 'warehouse' && id === 'main';
  const isDebtsDoc = (col, id) => col === 'warehouse' && id === 'debts';

  /* ---------- Долги: записи не переписываются задним числом ----------
     Долг — это деньги между людьми, и спорить о них будут через прилавок.
     Поэтому сервер смотрит не только кто пишет, но и что именно:

     • уже записанную операцию нельзя изменить — ни сумму, ни тип, ни дату,
       ни то, к кому она относится. Ошиблись — добавьте обратную запись;
     • нельзя и тихо потерять: исчезнуть операция может только вместе
       с записью в корзине, чтобы остался след, кто и когда её убрал;
     • автора новой записи ставит сервер. Приписать свой долг другому
       человеку больше не выйдет.

     Примечания, сроки и расчёты править можно — это не деньги. */
  function guardDebts(next, prev, user) {
    const было = new Map((prev && prev.ops || []).map((o) => [o.id, o]));
    const стало = new Map((next.ops || []).map((o) => [o.id, o]));

    // В корзину операция попадает двумя путями: сама по себе и вместе с человеком
    const вКорзине = new Set();
    for (const x of next.trash || []) {
      if (!x) continue;
      if (x.k === 'op' && x.op && x.op.id) вКорзине.add(x.op.id);
      if (x.k === 'person') for (const o of x.ops || []) if (o && o.id) вКорзине.add(o.id);
    }

    for (const [id, о] of было) {
      const н = стало.get(id);
      if (!н) {
        if (!вКорзине.has(id)) throw new HttpError(409, 'debt_vanished', { id });
        continue;
      }
      if (н.pid !== о.pid || н.type !== о.type || +н.amt !== +о.amt || +н.t !== +о.t)
        throw new HttpError(409, 'debt_changed', { id });
      н.by = о.by; н.at = о.at;                 // автора и время записи не переписать
    }
    for (const [id, н] of стало) {
      if (было.has(id)) continue;
      н.by = user.name;                          // автора новой записи ставит сервер
      if (!(+н.at > 0)) н.at = Date.now();
    }
    return next;
  }
  function stripCost(data) {
    if (!data || typeof data !== 'object') return data;
    const d = JSON.parse(JSON.stringify(data));
    (d.items || []).forEach((i) => { if (i) delete i[COST]; });
    (d.trash || []).forEach((e) => { if (e && e.item) delete e.item[COST]; });
    return d;
  }
  function keepCost(next, prev) {
    const was = {};
    const remember = (i) => { if (i && i.id && i[COST] !== undefined) was[i.id] = i[COST]; };
    ((prev && prev.items) || []).forEach(remember);
    ((prev && prev.trash) || []).forEach((e) => { if (e) remember(e.item); });
    const restore = (i) => { if (!i) return; delete i[COST]; if (was[i.id] !== undefined) i[COST] = was[i.id]; };
    (next.items || []).forEach(restore);
    (next.trash || []).forEach((e) => { if (e) restore(e.item); });
    return next;
  }
  const allowedStatuses = new Set(['active', 'pending', 'blocked']);

  function broadcast(c, p, shop) {
    const msg = `data: ${JSON.stringify({ c, p })}\n\n`;
    for (const cl of clients) {
      const u = auth.byId(cl.userId);
      if (!u || (shop && u.shop_id !== shop)) continue;      // чужому магазину событие не уходит
      if (canRead(u, c, p)) { try { cl.res.write(msg); } catch (e) { clients.delete(cl); } }
    }
  }
  function canRead(u, col, p) {
    if (col === 'meta') return true;
    if (col === 'staff') return isActive(u) || (p && p === 'staff/' + u.id);
    return PUBLIC_COLLECTIONS.has(col) && isActive(u);
  }

  // ----- виртуальная коллекция staff (берётся из таблицы users) -----
  function staffView(row, viewer) {
    const full = viewer.role === 'owner' || viewer.id === row.id;
    return { uid: row.id, name: row.name, phone: full ? row.phone : '', mail: full ? row.email : '', owner: row.role === 'owner', status: row.role === 'owner' ? 'active' : row.status, t: row.updated_at };
  }
  function staffUpdate(viewer, id, data) {
    const target = auth.byId(id);
    if (!target || target.shop_id !== viewer.shop_id) throw new HttpError(404, 'not_found');
    const self = viewer.id === id, owner = viewer.role === 'owner';
    if (!self && !owner) throw new HttpError(403, 'forbidden');
    const upd = {};
    if (self) {
      if (typeof data.name === 'string' && data.name.trim()) upd.name = data.name.trim().slice(0, 80);
      if (typeof data.phone === 'string' && /^(\+?[0-9 ()-]{7,20})?$/.test(data.phone.trim())) upd.phone = data.phone.trim();
    }
    if (owner && !self && data.status !== undefined) {
      if (!allowedStatuses.has(data.status) || target.role === 'owner') throw new HttpError(400, 'bad_status');
      upd.status = data.status;
    }
    const keys = Object.keys(upd);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map((k) => k + '=?').join(',')},updated_at=? WHERE id=?`).run(...keys.map((k) => upd[k]), Date.now(), id);
      if (upd.status === 'blocked') db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      auth.audit(viewer.id, 'staff_update', id + ' ' + JSON.stringify(upd));
    }
    broadcast('staff', 'staff/' + id, viewer.shop_id);
  }

  function parsePath(p) {
    const m = PATH_RE.exec(p);
    if (!m) throw new HttpError(400, 'bad_path');
    return { col: m[1], id: m[2] };
  }
  function check(u, col, id, action) {
    if (col === 'meta') {
      if (action === 'read' && id === 'owner') return;
      if (id === 'invite' && u.role === 'owner') return;      // ссылка-приглашение — дело владельца
      throw new HttpError(403, 'forbidden');
    }
    if (col === 'staff') {
      if (action === 'read') { if (isActive(u) || id === u.id) return; throw new HttpError(403, 'forbidden'); }
      if (action === 'update') return; // детали в staffUpdate
      throw new HttpError(403, 'forbidden');
    }
    if (!PUBLIC_COLLECTIONS.has(col) || !isActive(u)) throw new HttpError(403, 'forbidden');
    if (col === 'activity' && action !== 'read' && action !== 'create') throw new HttpError(403, 'forbidden');
  }

  function getDoc(u, path) {
    const { col, id } = parsePath(path); check(u, col, id, 'read');
    if (col === 'meta') {
      if (id === 'invite') {
        const sh = db.prepare('SELECT invite,name FROM shops WHERE id=?').get(u.shop_id);
        return sh ? { exists: true, id, data: { code: sh.invite, shop: sh.name }, version: 1 } : { exists: false, id };
      }
      const o = db.prepare("SELECT id FROM users WHERE role='owner' AND shop_id=? LIMIT 1").get(u.shop_id);
      return o ? { exists: true, id, data: { uid: o.id }, version: 1 } : { exists: false, id };
    }
    if (col === 'staff') { const r = auth.byId(id); return (r && r.shop_id === u.shop_id) ? { exists: true, id, data: staffView(r, u), version: r.updated_at } : { exists: false, id }; }
    const r = db.prepare('SELECT data,version FROM docs WHERE path=?').get(store(u, path));
    if (!r) return { exists: false, id };
    let data = JSON.parse(r.data);
    if (isMainDoc(col, id) && u.role !== 'owner') data = stripCost(data);
    return { exists: true, id, data, version: r.version };
  }
  function writeDoc(u, path, data, mode, ifMatch) {
    const { col, id } = parsePath(path);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_data');
    if (col === 'staff') { check(u, col, id, 'update'); staffUpdate(u, id, data); return { ok: true }; }
    if (col === 'meta' && id === 'invite') {
      check(u, col, id, 'update');
      const code = newInvite();
      db.prepare('UPDATE shops SET invite=? WHERE id=?').run(code, u.shop_id);
      if (typeof data.shop === 'string') db.prepare('UPDATE shops SET name=? WHERE id=?').run(data.shop.slice(0, 80), u.shop_id);
      auth.audit(u.id, 'invite_rotate', u.shop_id);
      return { ok: true, code: code };
    }
    check(u, col, id, mode === 'set' ? 'write' : 'update');
    const row = db.prepare('SELECT data,version FROM docs WHERE path=?').get(store(u, path));
    if (ifMatch !== undefined && ifMatch !== null && (!row || +ifMatch !== row.version)) throw new HttpError(409, 'version_conflict', { version: row ? row.version : 0 });
    let next = data;
    if (mode === 'update') { if (!row) throw new HttpError(404, 'not_found'); next = Object.assign(JSON.parse(row.data), data); }
    if (isDebtsDoc(col, id)) next = guardDebts(next, row ? JSON.parse(row.data) : null, u);
    if (isMainDoc(col, id) && u.role !== 'owner') next = keepCost(next, row ? JSON.parse(row.data) : null);
    const json = JSON.stringify(next);
    if (Buffer.byteLength(json) > cfg.maxDocBytes) throw new HttpError(413, 'too_large');
    const version = row ? row.version + 1 : 1;
    db.prepare('INSERT INTO docs(path,collection,data,version,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .run(store(u, path), col, json, version, Date.now(), u.id);
    broadcast(col, path, u.shop_id);
    return { ok: true, version };
  }
  function deleteDoc(u, path) {
    const { col, id } = parsePath(path);
    if (col === 'staff' || col === 'meta') throw new HttpError(403, 'forbidden');
    check(u, col, id, 'delete');
    db.prepare('DELETE FROM docs WHERE path=?').run(store(u, path));
    broadcast(col, path, u.shop_id);
    return { ok: true };
  }
  function listCollection(u, col, q) {
    if (!COL_RE.test(col)) throw new HttpError(400, 'bad_path');
    const limit = Math.max(1, Math.min(500, +q.get('limit') || 100));
    const dir = q.get('dir') === 'asc' ? 1 : -1;
    const field = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(q.get('orderBy') || '') ? q.get('orderBy') : 't';
    if (col === 'staff') {
      if (!isActive(u)) { const r = auth.byId(u.id); return { docs: r ? [{ id: r.id, data: staffView(r, u) }] : [] }; }
      return { docs: db.prepare('SELECT * FROM users WHERE shop_id=? AND (verified=1 OR role=?) ORDER BY created_at').all(u.shop_id, 'owner').map((r) => ({ id: r.id, data: staffView(r, u) })) };
    }
    if (col === 'meta') throw new HttpError(403, 'forbidden');
    if (!PUBLIC_COLLECTIONS.has(col) || !isActive(u)) throw new HttpError(403, 'forbidden');
    const rows = db.prepare('SELECT path,data FROM docs WHERE collection=? AND path LIKE ?').all(col, pre(u) + '%').map((r) => ({ id: r.path.slice(pre(u).length).split('/')[1], data: JSON.parse(r.data) }));
    rows.sort((a, b) => ((a.data[field] > b.data[field]) - (a.data[field] < b.data[field])) * dir);
    return { docs: rows.slice(0, limit) };
  }
  function addDoc(u, col, data) {
    if (col !== 'activity') throw new HttpError(403, 'forbidden');
    check(u, col, 'x', 'create');
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'bad_data');
    const id = S.newId(), rec = { t: Date.now(), by: u.name, uid: u.id, txt: String(data.txt || '').slice(0, 300) }; // автор и время — со стороны сервера
    db.prepare('INSERT INTO docs(path,collection,data,version,updated_at,updated_by) VALUES(?,?,?,?,?,?)').run(store(u, 'activity/' + id), col, JSON.stringify(rec), 1, rec.t, u.id);
    // храним только последние 2000 записей ленты
    db.prepare("DELETE FROM docs WHERE collection='activity' AND path LIKE ? AND path NOT IN (SELECT path FROM docs WHERE collection='activity' AND path LIKE ? ORDER BY updated_at DESC LIMIT 2000)").run(pre(u) + '%', pre(u) + '%');
    broadcast(col, 'activity/' + id, u.shop_id);
    return { ok: true, id };
  }

  // ----- SSE -----
  function makeTicket(u) {
    for (const [k, v] of tickets) if (v.exp < Date.now()) tickets.delete(k);
    const t = S.newToken(); tickets.set(t, { userId: u.id, exp: Date.now() + 60000 });
    return { ticket: t };
  }
  function openStream(req, res, ticket) {
    const tk = tickets.get(ticket); tickets.delete(ticket);
    if (!tk || tk.exp < Date.now()) throw new HttpError(401, 'unauthorized');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const cl = { res, userId: tk.userId };
    clients.add(cl);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* закроется ниже */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(cl); });
  }
  const closeAll = () => { for (const c of clients) { try { c.res.end(); } catch (e) { /* ignore */ } } clients.clear(); };
  return { getDoc, writeDoc, deleteDoc, listCollection, addDoc, makeTicket, openStream, broadcast, closeAll };
}
module.exports = { makeDocs };
