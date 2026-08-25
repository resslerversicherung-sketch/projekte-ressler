import { getStore } from "@netlify/blobs";
import { handle } from "../../lib/core.mjs";

/* Netlify-Variante: Speicher ist Netlify Blobs.
   Die eigentliche Logik steckt in lib/core.mjs. */

const KEY = "board";

export default async (req) => {
  const store = getStore({ name: "projektboard", consistency: "strong" });
  return handle(req, {
    load: () => store.get(KEY, { type: "json" }),
    save: (doc) => store.setJSON(KEY, doc)
  }, {
    masterKey: process.env.BOARD_KEY,
    resendKey: process.env.RESEND_API_KEY,
    mailFrom:  process.env.MAIL_FROM,
    siteUrl:   process.env.URL
  });
};

export const config = { path: "/api/board" };
