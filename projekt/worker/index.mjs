import { handle } from "../lib/core.mjs";

/* Cloudflare-Variante.
   Daten liegen in D1:
     board2(id, rev, state, mail)  – der Stand, ohne Anhänge
     files(id, name, type, ts, task, data) – jeder Anhang einzeln
   Die alte Tabelle board(id, doc) wird beim ersten Start übernommen;
   das Umkopieren macht SQLite, nicht der Worker. */

let bereit = false;

async function ensure(env) {
  if (bereit) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board2 (id TEXT PRIMARY KEY, rev INTEGER, state TEXT, mail TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, type TEXT, ts INTEGER, task TEXT, data TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS board (id TEXT PRIMARY KEY, doc TEXT)")
  ]);
  const vorhanden = await env.DB.prepare("SELECT 1 AS x FROM board2 WHERE id = 'board'").first();
  if (!vorhanden) {
    // einmalige Übernahme des alten Formats
    await env.DB.prepare(`INSERT OR IGNORE INTO board2 (id, rev, state, mail)
      SELECT 'board', COALESCE(json_extract(doc,'$.rev'),0),
             json_extract(doc,'$.state'), json_extract(doc,'$.mail')
      FROM board WHERE id = 'board'`).run();
  }
  bereit = true;
}

const store = (env) => ({
  async loadMeta() {
    const r = await env.DB.prepare("SELECT rev, mail FROM board2 WHERE id = 'board'").first();
    let mail = null;
    try { mail = r && r.mail ? JSON.parse(r.mail) : null; } catch { mail = null; }
    return { rev: (r && r.rev) || 0, mail };
  },
  async loadStateRaw() {
    const r = await env.DB.prepare("SELECT state FROM board2 WHERE id = 'board'").first();
    return (r && r.state) || null;
  },
  async loadMembersRaw() {
    const r = await env.DB.prepare("SELECT json_extract(state,'$.members') AS m FROM board2 WHERE id = 'board'").first();
    return (r && r.m) || null;
  },
  async saveState(rev, stateRaw, mail) {
    await env.DB.prepare(`INSERT INTO board2 (id, rev, state, mail) VALUES ('board', ?1, ?2, ?3)
      ON CONFLICT(id) DO UPDATE SET rev = ?1, state = ?2, mail = ?3`)
      .bind(rev, stateRaw, JSON.stringify(mail || {})).run();
  },
  async putFile(f) {
    await env.DB.prepare(`INSERT INTO files (id, name, type, ts, task, data) VALUES (?1,?2,?3,?4,?5,?6)
      ON CONFLICT(id) DO UPDATE SET name=?2, type=?3, ts=?4, task=?5, data=?6`)
      .bind(f.id, f.name, f.type, f.ts, f.task, f.data).run();
  },
  async getFile(id) {
    const r = await env.DB.prepare("SELECT name, type, data FROM files WHERE id = ?1").bind(id).first();
    return r || null;
  }
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/board" || url.pathname === "/api/file") {
      await ensure(env);
      return handle(req, store(env), {
        masterKey: env.BOARD_KEY,
        resendKey: env.RESEND_API_KEY,
        mailFrom:  env.MAIL_FROM,
        siteUrl:   url.origin
      });
    }
    return env.ASSETS.fetch(req);
  }
};
