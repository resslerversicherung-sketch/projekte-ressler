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
    env.DB.prepare("CREATE TABLE IF NOT EXISTS parts (id TEXT, part INTEGER, name TEXT, type TEXT, ts INTEGER, task TEXT, data TEXT, PRIMARY KEY (id, part))"),
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
  /* Große Dateien werden auf mehrere Einträge verteilt: D1 erlaubt
     höchstens 2 MB je Eintrag. */
  async putFile(f) {
    const TEIL = 700_000;
    const stuecke = [];
    for (let i = 0; i < f.data.length; i += TEIL) stuecke.push(f.data.slice(i, i + TEIL));
    const befehle = [env.DB.prepare("DELETE FROM parts WHERE id = ?1").bind(f.id)];
    stuecke.forEach((d, i) => befehle.push(env.DB.prepare(
      "INSERT INTO parts (id, part, name, type, ts, task, data) VALUES (?1,?2,?3,?4,?5,?6,?7)")
      .bind(f.id, i, f.name, f.type, f.ts, f.task, d)));
    await env.DB.batch(befehle);
  },
  async getFile(id) {
    const r = await env.DB.prepare("SELECT name, type, data FROM parts WHERE id = ?1 ORDER BY part").bind(id).all();
    const zeilen = (r && r.results) || [];
    if (zeilen.length) {
      return { name: zeilen[0].name, type: zeilen[0].type, data: zeilen.map(z => z.data).join("") };
    }
    // Übergangsweise: einzeln gespeicherte Dateien aus der ersten Fassung
    const alt = await env.DB.prepare("SELECT name, type, data FROM files WHERE id = ?1").bind(id).first();
    return alt || null;
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
