// Circle - social network server. Pure Node.js (no npm packages needed).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');

// ---------- storage (JSON file) ----------
let db = { users: {}, posts: [], notifs: [], sessions: {}, seq: 1 };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* first run */ }
const save = () => fs.writeFile(DB_FILE, JSON.stringify(db), () => {});

// ---------- HTTP: serves the front end ----------
const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, html) => {
    if (err) { res.writeHead(500); return res.end('index.html missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

// ---------- WebSocket protocol (RFC 6455) ----------
const clients = new Set();
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, user: null, buf: Buffer.alloc(0) };
  clients.add(c);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); readFrames(c); });
  sock.on('close', () => clients.delete(c));
  sock.on('error', () => { clients.delete(c); sock.destroy(); });
});

function frame(opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}
const send = (c, obj) => { if (!c.sock.destroyed) c.sock.write(frame(1, Buffer.from(JSON.stringify(obj)))); };

function readFrames(c) {
  while (c.buf.length >= 2) {
    const b0 = c.buf[0], b1 = c.buf[1], opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
    if (len > 4 * 1024 * 1024) return c.sock.destroy();
    const total = off + (masked ? 4 : 0) + len;
    if (c.buf.length < total) return;
    let payload = c.buf.slice(off + (masked ? 4 : 0), total);
    if (masked) {
      const mask = c.buf.slice(off, off + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    c.buf = c.buf.slice(total);
    if (opcode === 8) { c.sock.end(frame(8, Buffer.alloc(0))); return; }
    if (opcode === 9) { c.sock.write(frame(10, payload)); continue; }
    if (opcode === 1) {
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      try { handle(c, msg); } catch (e) { console.error(e); send(c, { t: 'err', m: 'Server error' }); }
    }
  }
}

// ---------- helpers ----------
const pub = u => ({ username: u.username, name: u.name, bio: u.bio, privacy: u.privacy });
const meView = u => ({
  ...pub(u),
  friends: u.friends.map(n => pub(db.users[n])),
  incoming: u.incoming.map(n => pub(db.users[n])),
  outgoing: u.outgoing
});
const status = (me, u) => me.username === u.username ? 'self' : me.friends.includes(u.username) ? 'friends'
  : me.outgoing.includes(u.username) ? 'sent' : me.incoming.includes(u.username) ? 'received' : 'none';
const canSee = (viewer, author) => { const a = db.users[author]; return a.privacy === 'public' || viewer === author || a.friends.includes(viewer); };
const postFor = (p, viewer) => ({
  id: p.id, author: p.author, authorName: db.users[p.author].name, text: p.text, image: p.image, time: p.time,
  likes: p.likes.length, liked: p.likes.includes(viewer),
  comments: p.comments.map(c => ({ author: c.author, name: db.users[c.author].name, text: c.text, time: c.time }))
});
const pushTo = (user, obj) => clients.forEach(c => { if (c.user === user) send(c, obj); });
function notify(to, from, text) {
  if (to === from) return;
  const n = { id: db.seq++, to, text, time: Date.now(), read: false };
  db.notifs.push(n);
  pushTo(to, { t: 'notif', n });
}
const sharePost = p => clients.forEach(c => { if (c.user && canSee(c.user, p.author)) send(c, { t: 'post', p: postFor(p, c.user) }); });
const login = (c, u) => {
  const token = crypto.randomBytes(16).toString('hex');
  db.sessions[token] = u.username; save();
  c.user = u.username;
  send(c, { t: 'auth', token, me: meView(u) });
};
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clean = (s, max) => String(s || '').trim().slice(0, max);

// ---------- message handler ----------
function handle(c, m) {
  if (m.t === 'register') {
    const username = clean(m.username, 20).toLowerCase(), name = clean(m.name, 40), pw = String(m.password || '');
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return send(c, { t: 'err', m: 'Username: 3-20 letters, numbers or _' });
    if (!name || pw.length < 6) return send(c, { t: 'err', m: 'Enter a name and a password of 6+ characters' });
    if (db.users[username]) return send(c, { t: 'err', m: 'That username is taken' });
    const salt = crypto.randomBytes(8).toString('hex');
    db.users[username] = { username, name, salt, hash: hash(pw, salt), bio: '', privacy: 'public', friends: [], incoming: [], outgoing: [] };
    return login(c, db.users[username]);
  }
  if (m.t === 'login') {
    const u = db.users[clean(m.username, 20).toLowerCase()];
    if (!u || hash(String(m.password || ''), u.salt) !== u.hash) return send(c, { t: 'err', m: 'Wrong username or password' });
    return login(c, u);
  }
  if (m.t === 'resume') {
    const u = db.users[db.sessions[m.token]];
    if (!u) return send(c, { t: 'noauth' });
    c.user = u.username;
    return send(c, { t: 'auth', token: m.token, me: meView(u) });
  }
  const me = db.users[c.user];
  if (!me) return send(c, { t: 'noauth' });

  switch (m.t) {
    case 'feed':
      return send(c, { t: 'feed', posts: db.posts.filter(p => canSee(me.username, p.author)).slice(-50).reverse().map(p => postFor(p, me.username)) });
    case 'post': {
      const text = clean(m.text, 500);
      const image = typeof m.image === 'string' && m.image.startsWith('data:image/') && m.image.length < 1500000 ? m.image : null;
      if (!text && !image) return send(c, { t: 'err', m: 'Write something or add a photo' });
      const p = { id: db.seq++, author: me.username, text, image, time: Date.now(), likes: [], comments: [] };
      db.posts.push(p); save(); return sharePost(p);
    }
    case 'like': {
      const p = db.posts.find(x => x.id === m.id);
      if (!p || !canSee(me.username, p.author)) return;
      const i = p.likes.indexOf(me.username);
      if (i >= 0) p.likes.splice(i, 1); else { p.likes.push(me.username); notify(p.author, me.username, me.name + ' liked your post'); }
      save(); return sharePost(p);
    }
    case 'comment': {
      const p = db.posts.find(x => x.id === m.id), text = clean(m.text, 300);
      if (!p || !text || !canSee(me.username, p.author)) return;
      p.comments.push({ author: me.username, text, time: Date.now() });
      notify(p.author, me.username, me.name + ' commented on your post');
      save(); return sharePost(p);
    }
    case 'people': {
      const q = clean(m.q, 30).toLowerCase();
      const list = Object.values(db.users).filter(u => u.username !== me.username && (u.username + ' ' + u.name.toLowerCase()).includes(q))
        .slice(0, 20).map(u => ({ ...pub(u), status: status(me, u) }));
      return send(c, { t: 'people', list });
    }
    case 'friend_req': {
      const u = db.users[m.to];
      if (!u || status(me, u) !== 'none') return;
      me.outgoing.push(u.username); u.incoming.push(me.username); save();
      notify(u.username, me.username, me.name + ' sent you a friend request');
      pushTo(u.username, { t: 'me', me: meView(u) }); return send(c, { t: 'me', me: meView(me) });
    }
    case 'friend_accept': case 'friend_decline': {
      const u = db.users[m.from];
      if (!u || !me.incoming.includes(u.username)) return;
      me.incoming = me.incoming.filter(n => n !== u.username);
      u.outgoing = u.outgoing.filter(n => n !== me.username);
      if (m.t === 'friend_accept') {
        me.friends.push(u.username); u.friends.push(me.username);
        notify(u.username, me.username, me.name + ' accepted your friend request');
      }
      save(); pushTo(u.username, { t: 'me', me: meView(u) }); send(c, { t: 'me', me: meView(me) });
      return send(c, { t: 'feed_refresh' });
    }
    case 'profile': {
      const u = db.users[m.username];
      if (!u) return send(c, { t: 'err', m: 'User not found' });
      const ok = canSee(me.username, u.username);
      return send(c, { t: 'profile', user: pub(u), status: status(me, u), locked: !ok,
        posts: ok ? db.posts.filter(p => p.author === u.username).slice(-30).reverse().map(p => postFor(p, me.username)) : [] });
    }
    case 'settings':
      me.bio = clean(m.bio, 160); me.privacy = m.privacy === 'friends' ? 'friends' : 'public'; save();
      return send(c, { t: 'me', me: meView(me) });
    case 'notifs':
      return send(c, { t: 'notifs', list: db.notifs.filter(n => n.to === me.username).slice(-30).reverse() });
    case 'read_notifs':
      db.notifs.forEach(n => { if (n.to === me.username) n.read = true; }); save(); return;
  }
}

server.listen(PORT, () => console.log('Circle is running at http://localhost:' + PORT));
