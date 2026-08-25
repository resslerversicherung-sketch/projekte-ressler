import { handle } from "../lib/core.mjs";

/* Cloudflare-Variante: Speicher ist eine D1-Datenbank (Bindung "DB"),
   die Dateien liefert die Assets-Bindung. Logik: lib/core.mjs */

async function loadDoc(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS board (id TEXT PRIMARY KEY, doc TEXT)").run();
  const row = await env.DB.prepare("SELECT doc FROM board WHERE id = 'board'").first();
  return row && row.doc ? JSON.parse(row.doc) : null;
}
async function saveDoc(env, doc) {
  await env.DB.prepare(
    "INSERT INTO board (id, doc) VALUES ('board', ?1) ON CONFLICT(id) DO UPDATE SET doc = ?1"
  ).bind(JSON.stringify(doc)).run();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/board") {
      return handle(req, {
        load: () => loadDoc(env),
        save: (doc) => saveDoc(env, doc)
      }, {
        masterKey: env.BOARD_KEY,
        resendKey: env.RESEND_API_KEY,
        mailFrom:  env.MAIL_FROM,
        siteUrl:   url.origin
      });
    }
    return env.ASSETS.fetch(req);   // index.html und alles Übrige
  }
};
