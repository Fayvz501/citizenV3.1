const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'db', 'citizen.db');
let db = null;

class Statement {
  constructor(d, s) { this.d = d; this.s = s; }
  run(...p) {
    const a = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
    this.d.run(this.s, a);
    const r = this.d.exec("SELECT last_insert_rowid() as id");
    return { changes: this.d.getRowsModified(), lastInsertRowid: r.length && r[0].values.length ? r[0].values[0][0] : 0 };
  }
  get(...p) {
    const a = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
    try { const s = this.d.prepare(this.s); if (a.length) s.bind(a); if (s.step()) { const c = s.getColumnNames(), v = s.get(); s.free(); const r = {}; c.forEach((k, i) => r[k] = v[i]); return r; } s.free(); } catch {} return undefined;
  }
  all(...p) {
    const a = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
    try { const res = [], s = this.d.prepare(this.s); if (a.length) s.bind(a); while (s.step()) { const c = s.getColumnNames(), v = s.get(), r = {}; c.forEach((k, i) => r[k] = v[i]); res.push(r); } s.free(); return res; } catch { return []; }
  }
}

class DbWrapper {
  constructor(d) { this.d = d; }
  prepare(s) { return new Statement(this.d, s); }
  exec(s) { this.d.run(s); }
  pragma(s) { try { this.d.run(`PRAGMA ${s}`); } catch {} }
  save() { try { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.writeFileSync(DB_PATH, Buffer.from(this.d.export())); } catch (e) { console.error('[DB] Save:', e.message); } }
  close() { this.save(); this.d.close(); }
}

async function initDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  let d;
  if (fs.existsSync(DB_PATH)) d = new SQL.Database(fs.readFileSync(DB_PATH));
  else { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); d = new SQL.Database(); }
  db = new DbWrapper(d);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT,
      password_hash TEXT,
      vk_id INTEGER UNIQUE,
      vk_name TEXT,
      vk_photo TEXT,
      avatar_color TEXT DEFAULT '#ff3b3b',
      reputation INTEGER DEFAULT 0,
      is_streamer INTEGER DEFAULT 0,
      trust_level TEXT DEFAULT 'newcomer',
      is_patrolling INTEGER DEFAULT 0,
      patrol_lat REAL, patrol_lng REAL,
      lang TEXT DEFAULT 'ru',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
      type TEXT NOT NULL, description TEXT NOT NULL, address TEXT,
      lat REAL NOT NULL, lng REAL NOT NULL, severity INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active', is_emergency INTEGER DEFAULT 0, moderation_score REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS incident_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      filename TEXT NOT NULL, original_name TEXT, mime_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      vote_type TEXT NOT NULL, weight REAL DEFAULT 1.0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE, UNIQUE(incident_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      text TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      text TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS streamer_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      status TEXT DEFAULT 'en_route', claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP, arrived_at DATETIME,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE, UNIQUE(incident_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS incident_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, user_id INTEGER,
      event_type TEXT NOT NULL, description TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, incident_id INTEGER,
      type TEXT NOT NULL, message TEXT NOT NULL, message_en TEXT, is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS user_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      label TEXT DEFAULT 'Мой район', lat REAL NOT NULL, lng REAL NOT NULL, radius_km REAL DEFAULT 2.0,
      FOREIGN KEY (user_id) REFERENCES users(id), UNIQUE(user_id, label)
    );
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      achievement_key TEXT NOT NULL, unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id), UNIQUE(user_id, achievement_key)
    );
    CREATE TABLE IF NOT EXISTS emergency_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      title TEXT NOT NULL, message TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      radius_km REAL DEFAULT 5.0, active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME
    );
  `);

  const idxs = ['CREATE INDEX IF NOT EXISTS i1 ON incidents(status)','CREATE INDEX IF NOT EXISTS i2 ON incidents(created_at)','CREATE INDEX IF NOT EXISTS i3 ON incidents(lat,lng)','CREATE INDEX IF NOT EXISTS i4 ON comments(incident_id)','CREATE INDEX IF NOT EXISTS i5 ON votes(incident_id)','CREATE INDEX IF NOT EXISTS i6 ON notifications(user_id,is_read)','CREATE INDEX IF NOT EXISTS i7 ON chat_messages(incident_id)','CREATE INDEX IF NOT EXISTS i8 ON incident_timeline(incident_id)','CREATE INDEX IF NOT EXISTS i9 ON achievements(user_id)','CREATE INDEX IF NOT EXISTS i10 ON incident_media(incident_id)'];
  for (const i of idxs) { try { db.exec(i); } catch {} }
  db.save();

  setInterval(() => { if (db) db.save(); }, 30000);
  process.on('SIGINT', () => { if (db) db.close(); process.exit(); });
  process.on('SIGTERM', () => { if (db) db.close(); process.exit(); });
  return db;
}

function getDb() { if (!db) throw new Error('Call initDb() first'); return db; }
module.exports = { initDb, getDb };
