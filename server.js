// Запуск: node server.js  (нужен Node.js 14+, внешние пакеты не нужны)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;

const clients = new Map(); // pid -> SSE response
const players = new Map(); // pid -> { lobbyId }
const lobbies = new Map(); // id -> lobby

const send = (pid, type, data) => {
  const r = clients.get(pid);
  if (r) r.write(`data: ${JSON.stringify({ type, data })}\n\n`);
};
const lobbyList = () => [...lobbies.values()].filter(l => l.phase === 'waiting')
  .map(l => ({ id: l.id, name: l.name, count: l.players.length }));
const pushList = () => {
  const list = lobbyList();
  for (const pid of clients.keys()) if (!players.get(pid)?.lobbyId) send(pid, 'lobbies', list);
};
const nameOf = (l, id) => l.players.find(p => p.id === id)?.name || '';

function view(l, pid) {
  const v = {
    name: l.name, phase: l.phase, max: 4, count: l.players.length,
    players: l.players.map(p => p.name), history: l.history, msg: l.msg || ''
  };
  if (l.phase !== 'waiting') {
    v.xName = nameOf(l, l.x);
    v.isX = l.x === pid;
    v.turnName = nameOf(l, l.turn);
    v.myTurn = l.turn === pid;
    v.left = l.attempts[pid];
    if (v.isX && l.secret != null) v.secret = l.secret;
  }
  if (l.phase === 'win' || l.phase === 'lose') { v.secret = l.secret; v.winner = l.winner; }
  return v;
}
const pushLobby = l => l.players.forEach(p => send(p.id, 'lobby', view(l, p.id)));

function finish(l) { // конец игры: рассылаем итог и удаляем лобби
  pushLobby(l);
  lobbies.delete(l.id);
  l.players.forEach(p => { const pl = players.get(p.id); if (pl) pl.lobbyId = null; });
}

function leave(pid) {
  const pl = players.get(pid);
  if (!pl || !pl.lobbyId) return;
  const l = lobbies.get(pl.lobbyId);
  pl.lobbyId = null;
  if (!l) return;
  const name = nameOf(l, pid);
  l.players = l.players.filter(p => p.id !== pid);
  if (l.phase === 'waiting') {
    if (!l.players.length) lobbies.delete(l.id); else pushLobby(l);
  } else {
    l.phase = 'abort'; l.msg = `${name} вышел из игры`;
    finish(l);
  }
  pushList();
}

const isNum = n => Number.isInteger(n) && n >= 0 && n <= 100;

const api = {
  create(b) {
    const pl = players.get(b.pid);
    if (!pl || pl.lobbyId) return { error: 'Вы уже в лобби' };
    const nick = String(b.nick || '').trim().slice(0, 20), name = String(b.lobby || '').trim().slice(0, 30);
    if (!nick || !name) return { error: 'Введите имя и название лобби' };
    const l = { id: crypto.randomBytes(6).toString('hex'), name, players: [{ id: b.pid, name: nick }], phase: 'waiting', history: [] };
    lobbies.set(l.id, l); pl.lobbyId = l.id;
    pushLobby(l); pushList();
    return { ok: true };
  },
  join(b) {
    const pl = players.get(b.pid), l = lobbies.get(b.lobbyId);
    if (!pl || pl.lobbyId) return { error: 'Вы уже в лобби' };
    const nick = String(b.nick || '').trim().slice(0, 20);
    if (!nick) return { error: 'Введите имя' };
    if (!l || l.phase !== 'waiting' || l.players.length >= 4) return { error: 'Лобби недоступно' };
    l.players.push({ id: b.pid, name: nick }); pl.lobbyId = l.id;
    if (l.players.length === 4) { // старт матча
      l.x = l.players[Math.floor(Math.random() * 4)].id;
      l.order = l.players.map(p => p.id).filter(id => id !== l.x);
      l.attempts = {}; l.order.forEach(id => l.attempts[id] = 2);
      l.count = 0; l.turn = l.order[0]; l.phase = 'choosing';
    }
    pushLobby(l); pushList();
    return { ok: true };
  },
  secret(b) {
    const l = lobbies.get(players.get(b.pid)?.lobbyId);
    if (!l || l.phase !== 'choosing' || l.x !== b.pid) return { error: 'Сейчас нельзя' };
    if (!isNum(b.number)) return { error: 'Число от 0 до 100' };
    l.secret = b.number; l.phase = 'guessing';
    pushLobby(l);
    return { ok: true };
  },
  guess(b) {
    const l = lobbies.get(players.get(b.pid)?.lobbyId);
    if (!l || l.phase !== 'guessing' || l.turn !== b.pid) return { error: 'Сейчас не ваш ход' };
    if (!isNum(b.number)) return { error: 'Число от 0 до 100' };
    const g = b.number, name = nameOf(l, b.pid);
    l.attempts[b.pid]--; l.count++;
    l.history.push({ name, num: g, hint: g === l.secret ? 'угадал' : g > l.secret ? 'меньше' : 'больше' });
    if (g === l.secret) { l.phase = 'win'; l.winner = name; finish(l); }
    else if (l.count >= 6) { l.phase = 'lose'; finish(l); }
    else { l.turn = l.order[l.count % 3]; pushLobby(l); }
    return { ok: true };
  },
  leave(b) { leave(b.pid); send(b.pid, 'lobbies', lobbyList()); return { ok: true }; }
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/events') {
    const pid = url.searchParams.get('pid');
    if (!pid) return res.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.set(pid, res);
    if (!players.has(pid)) players.set(pid, { lobbyId: null });
    send(pid, 'lobbies', lobbyList());
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      if (clients.get(pid) === res) { clients.delete(pid); leave(pid); players.delete(pid); }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const fn = api[url.pathname.slice(5)];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fn && players.has(b.pid) ? fn(b) : { error: 'Нет соединения, обновите страницу' }));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Игра запущена: http://localhost:${PORT}`));
