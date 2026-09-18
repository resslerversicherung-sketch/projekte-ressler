import { getStore } from "@netlify/blobs";
import { handle } from "../../lib/core.mjs";

/* Netlify-Variante: Stand und Anhänge als getrennte Einträge in Netlify Blobs. */

export default async (req) => {
  const s = getStore({ name: "projektboard", consistency: "strong" });
  return handle(req, {
    async loadMeta() {
      const m = await s.get("meta", { type: "json" });
      return { rev: (m && m.rev) || 0, mail: (m && m.mail) || null };
    },
    loadStateRaw: () => s.get("state", { type: "text" }),
    async saveState(rev, stateRaw, mail) {
      await s.set("state", stateRaw);
      await s.setJSON("meta", { rev, mail, ts: Date.now() });
    },
    putFile: (f) => s.setJSON("file:" + f.id, f),
    getFile: (id) => s.get("file:" + id, { type: "json" })
  }, {
    masterKey: process.env.BOARD_KEY,
    resendKey: process.env.RESEND_API_KEY,
    mailFrom:  process.env.MAIL_FROM,
    siteUrl:   process.env.URL
  });
};

export const config = { path: "/api/*" };
