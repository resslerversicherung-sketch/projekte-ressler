/* ---------------------------------------------------------------------
   Gemeinsame Logik des Projektboards – unabhängig vom Hoster.

   Wird von netlify/functions/board.mjs (Netlify Blobs) und von
   worker/index.mjs (Cloudflare D1) mit einem Speicher und den
   Zugangsdaten aufgerufen.
   --------------------------------------------------------------------- */


/* ---------------------------------------------------------------------
   Projektboard – Server.

   GET  /api/board?rev=12   ->  { rev, me, state }  oder  { rev, unchanged:true }
   PUT  /api/board          ->  { rev }             oder  409 + aktueller Stand

   Wichtig: Der Server schickt jeder Person nur das, was sie sehen darf,
   und übernimmt beim Speichern auch nur deren erlaubte Änderungen.
   Verborgene Aufgaben verlassen den Server also gar nicht erst.
   --------------------------------------------------------------------- */

// Hauptzugang (Inhaber): SHA-256 von "Benutzername:Passwort".
// Über die Umgebungsvariable BOARD_KEY überschreibbar.
export const FALLBACK_KEY = "3177b2ea96d8ffb966601c8f413b0ba3734355408ea0ca558a065829c83b6d83";

const MAIL_THROTTLE = 60000;  // höchstens eine Mail pro Adresse und Minute
const MAIL_MAX_LINES = 12;

const clone = o => JSON.parse(JSON.stringify(o));

/* ---------------- Texte für die Mail ---------------- */
const TXT = {
  de: {
    subject1: "Projekt: eine Änderung", subjectN: "Projekt: {n} Änderungen",
    intro: "In eurem Projektboard hat sich etwas getan:", open: "Board öffnen",
    foot: "Diese Nachricht kommt aus eurem Projektboard. Einstellung ändern: in der App oben rechts auf das Profilbild.",
    n_created:"{u} hat „{t}“ erstellt", n_moved:"{u} hat „{t}“ nach „{c}“ verschoben",
    n_note:"{u} hat „{t}“ kommentiert", n_due:"{u} hat die Fälligkeit von „{t}“ geändert",
    n_file:"{u} hat eine Datei zu „{t}“ hinzugefügt", n_assign:"{u} hat {m} zu „{t}“ hinzugefügt",
    n_prio:"{u} hat die Priorität von „{t}“ geändert", n_check:"{u} hat einen Checklisten-Punkt in „{t}“ geändert",
    n_react:"{u} hat auf eine Notiz in „{t}“ reagiert", n_del:"{u} hat „{t}“ gelöscht"
  },
  hu: {
    subject1: "Projekt: egy változás", subjectN: "Projekt: {n} változás",
    intro: "Történt valami a projekttáblán:", open: "Tábla megnyitása",
    foot: "Ezt az üzenetet a projekttábla küldte. Beállítás: az alkalmazásban jobb felül a profilképnél.",
    n_created:"{u} létrehozta: „{t}“", n_moved:"{u} áthelyezte a(z) „{t}“ feladatot ide: „{c}“",
    n_note:"{u} hozzászólt ehhez: „{t}“", n_due:"{u} módosította a határidőt: „{t}“",
    n_file:"{u} fájlt csatolt ehhez: „{t}“", n_assign:"{u} hozzáadta {m} tagot ehhez: „{t}“",
    n_prio:"{u} módosította a prioritást: „{t}“", n_check:"{u} módosított egy pontot itt: „{t}“",
    n_react:"{u} reagált egy jegyzetre itt: „{t}“", n_del:"{u} törölte: „{t}“"
  }
};
const line = (lang, key, params = {}) => {
  const d = TXT[lang] || TXT.de;
  let s = d[key] || key;
  for (const k in params) s = s.split("{" + k + "}").join(params[k]);
  return s;
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

/* =====================================================================
   Rechte
   ===================================================================== */

/* Wer ist das? Entweder der Hauptzugang oder eine Person mit eigenem Passwort. */
export function identify(state, keyHash, masterKey) {
  const members = (state && state.members) || [];
  if (keyHash && keyHash === masterKey) {
    const owner = members.find(m => m.role === "admin") || members[0];
    return { id: owner ? owner.id : null, admin: true, master: true };
  }
  const m = members.find(x => x.pw && x.pw === keyHash);
  if (!m) return null;
  return { id: m.id, admin: m.role === "admin", master: false };
}

/* Darf diese Person die Aufgabe sehen? */
export function canSee(task, user) {
  if (!user) return false;
  if (user.admin) return true;
  if (!task) return false;
  if (!Array.isArray(task.visible)) return true;               // ohne Einschränkung: alle
  return task.visible.includes(user.id) || (task.assignees || []).includes(user.id);
}

const inChat = (c, user) => user.admin || (c.members || []).includes(user.id);

/* Was der Browser dieser Person zu sehen bekommt */
export function filterForUser(state, user) {
  if (!state) return state;
  const out = clone(state);

  // Passwörter verlassen den Server nie
  out.members = (out.members || []).map(m => {
    const { pw, ...rest } = m;
    return { ...rest, hasPw: !!pw };
  });

  out.groups = (out.groups || []).map(g => ({
    ...g,
    columns: (g.columns || []).map(c => ({ ...c, tasks: (c.tasks || []).filter(t => canSee(t, user)) }))
  }));

  const seen = new Set();
  out.groups.forEach(g => g.columns.forEach(c => c.tasks.forEach(t => seen.add(t.id))));

  out.notifications = (out.notifications || []).filter(n => user.admin || (n.taskId && seen.has(n.taskId)));
  out.chats = (out.chats || []).filter(c => inChat(c, user));
  out.watchers = (out.watchers || []).filter(w => user.admin || w.id === user.id);
  return out;
}

/* =====================================================================
   Speichern: nur erlaubte Änderungen übernehmen
   ===================================================================== */
const indexTasks = state => {
  const m = {};
  (state.groups || []).forEach(g => (g.columns || []).forEach(c => (c.tasks || []).forEach((t, i) => {
    m[t.id] = { task: t, col: c.id, ord: i };
  })));
  return m;
};

/* Passwörter aus dem gespeicherten Stand behalten bzw. neu gesetzte übernehmen */
function keepPasswords(stored, incoming) {
  const old = {};
  ((stored && stored.members) || []).forEach(m => { if (m.pw) old[m.id] = m.pw; });
  incoming.members = (incoming.members || []).map(m => {
    const { hasPw, pwNew, ...rest } = m;
    const pw = pwNew || old[m.id];
    return pw ? { ...rest, pw } : rest;
  });
  return incoming;
}

export function applyIncoming(stored, incoming, user) {
  if (!stored) return keepPasswords(stored, clone(incoming));
  if (user.admin) return keepPasswords(stored, clone(incoming));

  const out = clone(stored);
  const inc = clone(incoming);
  const incIdx = indexTasks(inc);
  const incTomb = inc.tomb || {};

  // 1. Aufgaben: Reihenfolge des gespeicherten Standes als Grundlage,
  //    damit verborgene Aufgaben an ihrer Stelle bleiben.
  const placed = new Set();
  out.groups.forEach(g => g.columns.forEach(col => {
    col.tasks = (col.tasks || []).map(t => {
      if (!canSee(t, user)) return t;                       // nicht sichtbar -> unverändert
      const hit = incIdx[t.id];
      if (!hit) return incTomb[t.id] ? null : t;            // gelöscht oder unbekannt
      if (hit.col !== col.id) return null;                  // in andere Spalte verschoben
      placed.add(t.id);
      return hit.task;
    }).filter(Boolean);
  }));

  // 2. Neue oder verschobene Aufgaben einsortieren
  const colMap = {};
  out.groups.forEach(g => g.columns.forEach(c => { colMap[c.id] = c; }));
  const hidden = new Set();                                 // was diese Person nicht sehen darf
  ((stored.groups) || []).forEach(g => (g.columns || []).forEach(c => (c.tasks || []).forEach(t => {
    if (!canSee(t, user)) hidden.add(t.id);
  })));
  Object.keys(incIdx).forEach(id => {
    if (placed.has(id)) return;
    if (hidden.has(id)) return;                             // verborgene Aufgabe bleibt unangetastet
    const hit = incIdx[id];
    if (!canSee(hit.task, user)) return;                    // niemand darf Fremdes einschleusen
    const col = colMap[hit.col];
    if (!col) return;                                       // unbekannte Spalte -> ignorieren
    col.tasks.splice(Math.min(hit.ord, col.tasks.length), 0, hit.task);
  });

  // 3. Nur die eigene E-Mail-Einstellung darf geändert werden
  out.watchers = [
    ...((out.watchers || []).filter(w => w.id !== user.id)),
    ...((inc.watchers || []).filter(w => w.id === user.id))
  ];

  // 4. Eigene Chats übernehmen, fremde unangetastet lassen
  out.chats = [
    ...((out.chats || []).filter(c => !inChat(c, user))),
    ...((inc.chats || []).filter(c => inChat(c, user)))
  ];

  // 5. Meldungen zusammenführen
  const byId = {};
  [...(out.notifications || []), ...(inc.notifications || [])].forEach(n => { if (n && n.id) byId[n.id] = n; });
  out.notifications = Object.values(byId).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);

  // 6. Löschvermerke vereinen
  out.tomb = { ...(out.tomb || {}) };
  for (const k in incTomb) out.tomb[k] = Math.max(out.tomb[k] || 0, incTomb[k]);

  // Mitglieder, Gruppen- und Spaltenstruktur bleiben dem Inhaber vorbehalten.
  return out;
}

/* =====================================================================
   E-Mail
   ===================================================================== */
export function buildMails(state, meta, nowTs) {
  const out = [];
  const sent = (meta && meta.sent) || {};
  const watchers = (state && state.watchers) || [];
  const notes = (state && state.notifications) || [];
  const members = (state && state.members) || [];

  const tasks = {};
  (state.groups || []).forEach(g => (g.columns || []).forEach(c => (c.tasks || []).forEach(t => { tasks[t.id] = t; })));

  for (const w of watchers) {
    if (!w || !w.on || !w.email) continue;
    const member = members.find(m => m.id === w.id);
    const user = { id: w.id, admin: member ? member.role === "admin" : false };
    const rec = sent[w.email] || {};
    if (rec.lastTs === undefined) { out.push({ email: w.email, init: true, lastTs: nowTs }); continue; }
    if (rec.lastMail && nowTs - rec.lastMail < MAIL_THROTTLE) continue;

    const hits = notes.filter(n => {
      if (!n || (n.ts || 0) <= rec.lastTs) return false;
      if (n.by === w.id) return false;                                    // eigene Änderungen nicht
      if (Array.isArray(w.from) && !w.from.includes(n.by)) return false;  // nur ausgewählte Personen
      if (!user.admin) {
        if (!n.taskId) return false;
        if (!canSee(tasks[n.taskId], user)) return false;                 // nichts über verborgene Aufgaben
      }
      if (w.onlyMine) {
        if (!n.taskId) return false;
        if (!((tasks[n.taskId] || {}).assignees || []).includes(w.id)) return false;
      }
      return true;
    }).sort((a, b) => (a.ts || 0) - (b.ts || 0));

    if (!hits.length) continue;
    const lang = w.lang === "hu" ? "hu" : "de";
    const shown = hits.slice(-MAIL_MAX_LINES);
    out.push({
      email: w.email, lang,
      subject: hits.length === 1 ? line(lang, "subject1") : line(lang, "subjectN", { n: hits.length }),
      lines: shown.map(n => line(lang, n.key, n.params || {})),
      more: hits.length - shown.length,
      lastTs: Math.max(...hits.map(n => n.ts || 0))
    });
  }
  return out;
}

async function sendMail(m, cfg) {
  const apiKey = cfg.resendKey;
  if (!apiKey) return { ok: false, error: "RESEND_API_KEY ist beim Hoster nicht gesetzt." };
  const from = cfg.mailFrom || "Projekt <onboarding@resend.dev>";
  const url = cfg.siteUrl || "";
  const body = [
    line(m.lang, "intro"), "",
    ...m.lines.map(l => "• " + l),
    m.more > 0 ? `… (+${m.more})` : "", "",
    url ? `${line(m.lang, "open")}: ${url}` : "", "",
    line(m.lang, "foot")
  ].filter(Boolean).join("\n");

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [m.email], subject: m.subject, text: body })
  });
  if (r.ok) return { ok: true };
  let msg = "HTTP " + r.status;
  try { const j = await r.json(); msg = j.message || j.error || msg; } catch {}
  return { ok: false, error: msg, status: r.status };
}


/* =====================================================================
   Anfragen bearbeiten
   ---------------------------------------------------------------------
   store = { load(): Promise<doc>, save(doc): Promise<void> }
   cfg   = { masterKey, resendKey, mailFrom, siteUrl }
   ===================================================================== */
export async function handle(req, store, cfg) {
  const keyHash = req.headers.get("x-board-key") || "";
  const doc = (await store.load()) || { rev: 0, state: null };

  const user = identify(doc.state, keyHash, cfg.masterKey || FALLBACK_KEY);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const clientRev = Number(new URL(req.url).searchParams.get("rev") ?? -1);
    const me = { id: user.id, admin: user.admin };
    if (doc.rev === clientRev) return json({ rev: doc.rev, me, unchanged: true });
    return json({ rev: doc.rev, me, state: doc.state ? filterForUser(doc.state, user) : null });
  }

  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body || typeof body.state !== "object" || body.state === null) {
      return json({ error: "no state" }, 400);
    }

    // Veralteter Stand: aktuellen zurückgeben, der Browser führt zusammen.
    if (typeof body.rev === "number" && body.rev !== doc.rev && doc.state !== null) {
      return json({ conflict: true, rev: doc.rev, state: filterForUser(doc.state, user) }, 409);
    }

    const nextState = applyIncoming(doc.state, body.state, user);

    const meta = doc.mail || { sent: {} };
    const nowTs = Date.now();
    const mails = cfg.resendKey ? buildMails(nextState, meta, nowTs) : [];
    for (const m of mails) {
      if (m.init) { meta.sent[m.email] = { lastTs: m.lastTs, lastMail: 0 }; continue; }
      let res = { ok: false };
      try { res = await sendMail(m, cfg); } catch (e) { res = { ok: false, error: String(e) }; }
      if (res.ok) meta.sent[m.email] = { lastTs: m.lastTs, lastMail: nowTs };
      else console.log("Mailversand fehlgeschlagen an", m.email, "-", res.error);
    }

    const next = { rev: doc.rev + 1, state: nextState, ts: nowTs, mail: meta };
    await store.save(next);
    return json({ rev: next.rev });
  }

  /* Probe-Mail aus der App heraus – zeigt die Antwort des Mailanbieters im Klartext */
  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch {}
    if (!body.test) return json({ ok: false, error: "unbekannte Anfrage" }, 400);
    const to = String(body.email || "").trim();
    if (!to) return json({ ok: false, error: "keine Adresse angegeben" });
    const lang = body.lang === "hu" ? "hu" : "de";
    let res;
    try {
      res = await sendMail({
        email: to, lang,
        subject: lang === "hu" ? "Teszt üzenet a projekttáblától" : "Testnachricht vom Projektboard",
        lines: [lang === "hu" ? "Ez egy próbaüzenet. Ha megkaptad, az értesítések működnek."
                              : "Das ist eine Probenachricht. Wenn sie ankommt, funktionieren die Benachrichtigungen."],
        more: 0
      }, cfg);
    } catch (e) { res = { ok: false, error: String(e) }; }
    return json(res);
  }

  return json({ error: "method not allowed" }, 405);
}
