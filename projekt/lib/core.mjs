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
    n_react:"{u} hat auf eine Notiz in „{t}“ reagiert", n_del:"{u} hat „{t}“ gelöscht",
    n_chat:"Nachricht von {u}: „{t}“", n_chat_group:"{u} in „{c}“: „{t}“"
  },
  hu: {
    subject1: "Projekt: egy változás", subjectN: "Projekt: {n} változás",
    intro: "Történt valami a projekttáblán:", open: "Tábla megnyitása",
    foot: "Ezt az üzenetet a projekttábla küldte. Beállítás: az alkalmazásban jobb felül a profilképnél.",
    n_created:"{u} létrehozta: „{t}“", n_moved:"{u} áthelyezte a(z) „{t}“ feladatot ide: „{c}“",
    n_note:"{u} hozzászólt ehhez: „{t}“", n_due:"{u} módosította a határidőt: „{t}“",
    n_file:"{u} fájlt csatolt ehhez: „{t}“", n_assign:"{u} hozzáadta {m} tagot ehhez: „{t}“",
    n_prio:"{u} módosította a prioritást: „{t}“", n_check:"{u} módosított egy pontot itt: „{t}“",
    n_react:"{u} reagált egy jegyzetre itt: „{t}“", n_del:"{u} törölte: „{t}“",
    n_chat:"Üzenet tőle: {u} – „{t}“", n_chat_group:"{u} a(z) „{c}“ csoportban: „{t}“"
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

/* Darf diese Person das Projekt sehen? */
export function canSeeGroup(g, user) {
  if (!user) return false;
  if (user.admin) return true;
  if (!g) return false;
  return !Array.isArray(g.visible) || g.visible.includes(user.id);
}

/* Darf diese Person die Aufgabe sehen?
   groupOk = ob das Projekt für sie freigegeben ist. */
export function canSee(task, user, groupOk = true) {
  if (!user) return false;
  if (user.admin) return true;
  if (!task) return false;
  if ((task.assignees || []).includes(user.id)) return true;   // zugewiesen: immer sichtbar
  const explicit = Array.isArray(task.visible) ? task.visible.includes(user.id) : null;
  if (!groupOk) return explicit === true;                      // verborgenes Projekt: nur ausdrücklich
  return explicit === null || explicit === true;
}

/* Kennungen aller Aufgaben, die diese Person sehen darf */
export function visibleSet(state, user) {
  const set = new Set();
  if (!state) return set;
  (state.groups || []).forEach(g => {
    const gOk = canSeeGroup(g, user);
    (g.columns || []).forEach(c => (c.tasks || []).forEach(t => {
      if (canSee(t, user, gOk)) set.add(t.id);
    }));
  });
  return set;
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

  const seen = visibleSet(state, user);
  out.groups = (out.groups || []).map(g => ({
    ...g,
    columns: (g.columns || []).map(c => ({ ...c, tasks: (c.tasks || []).filter(t => seen.has(t.id)) }))
  }));
  // Projekte ohne einzige sichtbare Aufgabe verschwinden ganz
  out.groups = out.groups.filter(g =>
    canSeeGroup(g, user) || g.columns.some(c => c.tasks.length));

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
  const seenStored = visibleSet(stored, user);   // was die Person vorher sehen durfte
  const seenIncoming = visibleSet(inc, user);    // was sie mitschickt

  // 1. Aufgaben: Reihenfolge des gespeicherten Standes als Grundlage,
  //    damit verborgene Aufgaben an ihrer Stelle bleiben.
  const placed = new Set();
  out.groups.forEach(g => g.columns.forEach(col => {
    col.tasks = (col.tasks || []).map(t => {
      if (!seenStored.has(t.id)) return t;                  // nicht sichtbar -> unverändert
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
    if (!seenStored.has(t.id)) hidden.add(t.id);
  })));
  Object.keys(incIdx).forEach(id => {
    if (placed.has(id)) return;
    if (hidden.has(id)) return;                             // verborgene Aufgabe bleibt unangetastet
    const hit = incIdx[id];
    if (!seenIncoming.has(id)) return;                      // niemand darf Fremdes einschleusen
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
  const chats = (state && state.chats) || [];

  const tasks = {};
  (state.groups || []).forEach(g => (g.columns || []).forEach(c => (c.tasks || []).forEach(t => { tasks[t.id] = t; })));
  const seenCache = {};
  const maySee = (user, id) => {
    if (user.admin) return true;
    if (!seenCache[user.id]) seenCache[user.id] = visibleSet(state, user);
    return seenCache[user.id].has(id);
  };
  const nameOf = id => (members.find(m => m.id === id) || {}).name || "?";
  const short = s => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > 90 ? x.slice(0, 90) + "…" : x; };

  for (const w of watchers) {
    if (!w || !w.on || !w.email) continue;
    const member = members.find(m => m.id === w.id);
    const user = { id: w.id, admin: member ? member.role === "admin" : false };
    const rec = sent[w.email] || {};
    if (rec.lastTs === undefined) { out.push({ email: w.email, init: true, lastTs: nowTs }); continue; }
    if (rec.lastMail && nowTs - rec.lastMail < MAIL_THROTTLE) continue;
    const lang = w.lang === "hu" ? "hu" : "de";

    /* 1. Änderungen an Aufgaben */
    const hits = notes.filter(n => {
      if (!n || (n.ts || 0) <= rec.lastTs) return false;
      if (n.by === w.id) return false;                                     // eigene Änderungen nicht
      if (Array.isArray(w.from) && !w.from.includes(n.by)) return false;   // nur ausgewählte Personen
      if (!user.admin) {
        if (!n.taskId) return false;
        if (!maySee(user, n.taskId)) return false;                         // nichts über Verborgenes
      }
      if (w.onlyMine) {
        if (!n.taskId) return false;
        if (!((tasks[n.taskId] || {}).assignees || []).includes(w.id)) return false;
      }
      return true;
    }).map(n => ({ ts: n.ts || 0, text: line(lang, n.key, n.params || {}) }));

    /* 2. Neue Chat-Nachrichten an diese Person */
    chats.forEach(c => {
      if (!(c.members || []).includes(w.id)) return;                       // nur eigene Unterhaltungen
      (c.messages || []).forEach(msg => {
        if (!msg || (msg.ts || 0) <= rec.lastTs) return;
        if (msg.author === w.id) return;
        if (Array.isArray(w.from) && !w.from.includes(msg.author)) return;
        hits.push({
          ts: msg.ts || 0,
          text: c.type === "group"
            ? line(lang, "n_chat_group", { u: nameOf(msg.author), c: c.name || "", t: short(msg.text) })
            : line(lang, "n_chat", { u: nameOf(msg.author), t: short(msg.text) })
        });
      });
    });

    if (!hits.length) continue;
    hits.sort((a, b) => a.ts - b.ts);
    const shown = hits.slice(-MAIL_MAX_LINES);
    out.push({
      email: w.email, lang,
      subject: hits.length === 1 ? line(lang, "subject1") : line(lang, "subjectN", { n: hits.length }),
      lines: shown.map(x => x.text),
      more: hits.length - shown.length,
      lastTs: Math.max(...hits.map(x => x.ts))
    });
  }
  return out;
}

async function sendMail(m, cfg) {
  const apiKey = cfg.resendKey;
  if (!apiKey) return {
    ok: false,
    error: "RESEND_API_KEY ist bei diesem Dienst nicht gesetzt. Antwortender Server: "
         + (cfg.host || cfg.siteUrl || "unbekannt")
         + " – das Secret muss genau dort gespeichert und veröffentlicht sein."
  };
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
   store = {
     loadMeta()        -> { rev, mail }
     loadStateRaw()    -> JSON-Text des Standes oder null
     loadMembersRaw()  -> JSON-Text nur der Mitgliederliste (optional, spart Rechenzeit)
     saveState(rev, stateRaw, mail)
     putFile(f) / getFile(id)          -> Anhänge, einzeln gespeichert
   }
   cfg = { masterKey, resendKey, mailFrom, siteUrl }

   Wichtig für kleine Hoster-Kontingente: Anhänge liegen NICHT im Stand,
   sondern einzeln. Für den Inhaber wird der Stand unverändert
   durchgereicht, ohne ihn zu zerlegen – das kostet fast keine Rechenzeit.
   ===================================================================== */

const raw = (text, status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handle(req, store, cfg) {
  cfg = { ...cfg, host: (() => { try { return new URL(req.url).host; } catch { return ""; } })() };
  const url = new URL(req.url);
  const keyHash = req.headers.get("x-board-key") || "";
  const master = cfg.masterKey || FALLBACK_KEY;

  /* ---- Wer fragt? Der Inhaber wird ohne Zerlegen des Standes erkannt ---- */
  let user = null;
  if (keyHash && keyHash === master) {
    let ownerId = null;
    try {
      const mem = store.loadMembersRaw ? JSON.parse((await store.loadMembersRaw()) || "null") : null;
      const list = mem || JSON.parse((await store.loadStateRaw()) || "null")?.members || [];
      const owner = list.find(m => m.role === "admin") || list[0];
      ownerId = owner ? owner.id : null;
    } catch { ownerId = null; }
    user = { id: ownerId, admin: true, master: true };
  } else {
    try {
      const mem = store.loadMembersRaw ? JSON.parse((await store.loadMembersRaw()) || "null") : null;
      const list = mem || JSON.parse((await store.loadStateRaw()) || "null")?.members || [];
      const m = list.find(x => x.pw && x.pw === keyHash);
      if (m) user = { id: m.id, admin: m.role === "admin", master: false };
    } catch { user = null; }
  }
  if (!user) return json({ error: "unauthorized" }, 401);

  const meta = await store.loadMeta();
  const rev = (meta && meta.rev) || 0;

  /* ---- Anhänge: einzeln holen und speichern ---- */
  if (url.pathname.endsWith("/file")) {
    if (req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const f = id ? await store.getFile(id) : null;
      if (!f) return json({ error: "not found" }, 404);
      return json({ id, name: f.name, type: f.type, data: f.data });
    }
    if (req.method === "POST") {
      let b;
      try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!b || !b.id || !b.data) return json({ error: "no file" }, 400);
      if (String(b.data).length > 1_600_000) return json({ error: "file too large" }, 413);
      await store.putFile({ id: String(b.id), name: String(b.name || "datei"),
                            type: String(b.type || ""), ts: Number(b.ts) || Date.now(),
                            task: String(b.task || ""), data: String(b.data) });
      return json({ ok: true, id: b.id });
    }
    return json({ error: "method not allowed" }, 405);
  }

  /* ---- Stand lesen ---- */
  if (req.method === "GET") {
    const clientRev = Number(url.searchParams.get("rev") ?? -1);
    const me = { id: user.id, admin: user.admin };
    if (rev === clientRev) return json({ rev, me, unchanged: true });

    const stateRaw = await store.loadStateRaw();
    if (!stateRaw) return json({ rev, me, state: null });

    if (user.admin) {
      // unverändert durchreichen, ohne den Stand zu zerlegen
      return raw(`{"rev":${rev},"me":${JSON.stringify(me)},"state":${stateRaw}}`);
    }
    const state = JSON.parse(stateRaw);
    return json({ rev, me, state: filterForUser(state, user) });
  }

  /* ---- Stand speichern ---- */
  if (req.method === "PUT") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body || typeof body.state !== "object" || body.state === null) {
      return json({ error: "no state" }, 400);
    }

    if (typeof body.rev === "number" && body.rev !== rev && rev > 0) {
      const stateRaw = await store.loadStateRaw();
      if (stateRaw) {
        if (user.admin) return raw(`{"conflict":true,"rev":${rev},"state":${stateRaw}}`, 409);
        return json({ conflict: true, rev, state: filterForUser(JSON.parse(stateRaw), user) }, 409);
      }
    }

    let nextState;
    if (user.admin) {
      // Passwörter der Mitarbeiter bewahren (der Browser kennt sie nicht)
      nextState = body.state;
      try {
        const memRaw = store.loadMembersRaw ? await store.loadMembersRaw() : null;
        const alt = memRaw ? JSON.parse(memRaw) : (JSON.parse((await store.loadStateRaw()) || "null") || {}).members;
        const pw = {};
        (alt || []).forEach(m => { if (m.pw) pw[m.id] = m.pw; });
        nextState.members = (nextState.members || []).map(m => {
          const { hasPw, pwNew, ...rest } = m;
          const p = pwNew || pw[m.id];
          return p ? { ...rest, pw: p } : rest;
        });
      } catch { /* im Zweifel unverändert speichern */ }
    } else {
      const stored = JSON.parse((await store.loadStateRaw()) || "null");
      nextState = applyIncoming(stored, body.state, user);
    }

    const mailMeta = (meta && meta.mail) || { sent: {} };
    const nowTs = Date.now();
    const mails = cfg.resendKey ? buildMails(nextState, mailMeta, nowTs) : [];
    for (const m of mails) {
      if (m.init) { mailMeta.sent[m.email] = { lastTs: m.lastTs, lastMail: 0 }; continue; }
      let res = { ok: false };
      try { res = await sendMail(m, cfg); } catch (e) { res = { ok: false, error: String(e) }; }
      if (res.ok) mailMeta.sent[m.email] = { lastTs: m.lastTs, lastMail: nowTs };
      else console.log("Mailversand fehlgeschlagen an", m.email, "-", res.error);
    }

    const nextRev = rev + 1;
    await store.saveState(nextRev, JSON.stringify(nextState), mailMeta);
    return json({ rev: nextRev });
  }

  /* ---- Probe-Mail ---- */
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
