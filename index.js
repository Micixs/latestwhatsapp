/**
 * B2BKAR WhatsApp link service (QR login).
 *
 * Runs OUTSIDE the B2BKAR app, on any always-on Node host (VPS, Render,
 * Railway, Fly.io). It keeps a WhatsApp Web session alive per company and
 * exposes a tiny HTTP API that B2BKAR calls to show the QR and send messages.
 *
 * Start:  BRIDGE_TOKEN=your-long-secret node server.js
 */
import express from "express";
import QRCode from "qrcode";
import * as baileysPkg from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "node:fs";
import path from "node:path";

const b = baileysPkg.default && typeof baileysPkg.default === "object" ? baileysPkg.default : baileysPkg;
const makeWASocket = typeof b.default === "function" ? b.default : (typeof b.makeWASocket === "function" ? b.makeWASocket : baileysPkg.makeWASocket);
const DisconnectReason = b.DisconnectReason || baileysPkg.DisconnectReason;
const useMultiFileAuthState = b.useMultiFileAuthState || baileysPkg.useMultiFileAuthState;
const fetchLatestBaileysVersion = b.fetchLatestBaileysVersion || baileysPkg.fetchLatestBaileysVersion;
const Browsers = b.Browsers || baileysPkg.Browsers;

const PORT = process.env.PORT || 8081;
const TOKEN = process.env.BRIDGE_TOKEN;
const DATA_DIR = process.env.DATA_DIR || "./sessions";
if (!TOKEN || TOKEN.length < 16) {
  console.error("Set BRIDGE_TOKEN to a long random secret before starting.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

/** sessionId -> { sock, status, qr, phone } */
const sessions = new Map();

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

async function startSession(rawId) {
  const id = safeId(rawId);
  const existing = sessions.get(id);
  if (existing && (existing.status === "connected" || existing.status === "qr")) return existing;

  const dir = path.join(DATA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const entry = existing ?? { status: "connecting", qr: null, phone: null };
  sessions.set(id, entry);

  // Desktop browser identity + no full history sync helps WhatsApp Business link reliably.
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    // WhatsApp Business rejects/hangs on the "Desktop" identity; Chrome browser identity links reliably.
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
  });
  entry.sock = sock;

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      entry.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      entry.status = "qr";
    }
    if (u.connection === "open") {
      entry.status = "connected";
      entry.qr = null;
      entry.phone = sock.user?.id?.split(":")[0] ?? null;
    }
    if (u.connection === "close") {
      const code = new Boom(u.lastDisconnect?.error)?.output?.statusCode;
      entry.status = "disconnected";
      entry.sock = null;
      if (code !== DisconnectReason.loggedOut) setTimeout(() => startSession(id), 3000);
      else fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Give WhatsApp a moment to emit the first QR so the caller gets it inline.
  for (let i = 0; i < 25 && entry.status === "connecting"; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return entry;
}

async function resetSession(id) {
  const e = sessions.get(id);
  if (e?.sock) {
    try {
      e.sock.ev.removeAllListeners("connection.update");
      e.sock.end(undefined);
    } catch {
      /* ignore */
    }
  }
  sessions.delete(id);
  fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true });
}

function jid(to) {
  const digits = String(to).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function requireSession(id) {
  const entry = sessions.get(safeId(id));
  if (!entry?.sock || entry.status !== "connected") {
    const err = new Error("WhatsApp is not linked. Scan the QR code again.");
    err.status = 409;
    throw err;
  }
  return entry;
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (req.get("x-bridge-token") !== TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/session/start", async (req, res, next) => {
  try {
    const id = safeId(req.body?.sessionId);
    const current = sessions.get(id);
    // Not linked yet: wipe any half-finished keys so each QR is a clean handshake.
    if (current?.status !== "connected" && (req.body?.fresh ?? true)) await resetSession(id);
    const e = await startSession(id);
    res.json({ status: e.status, qr: e.qr, phone: e.phone });
  } catch (err) {
    next(err);
  }
});

app.post("/session/pair", async (req, res, next) => {
  try {
    const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
    if (phone.length < 10) return res.status(400).json({ error: "Valid phone number required" });
    const id = safeId(req.body?.sessionId);
    const current = sessions.get(id);
    if (current?.status === "connected") return res.json({ code: null, status: "connected" });
    // Fresh, clean session for phone-code pairing: stale keys from a failed QR scan cause "wrong code".
    await resetSession(id);
    const e = await startSession(id);
    if (!e.sock) return res.status(503).json({ error: "Link service is starting, try again" });
    await new Promise((r) => setTimeout(r, 2500));
    const code = await e.sock.requestPairingCode(phone);
    res.json({ code });
  } catch (err) {
    next(err);
  }
});

app.get("/session/status", async (req, res, next) => {
  try {
    const id = safeId(req.query.sessionId);
    let e = sessions.get(id);
    if (!e) e = await startSession(id);
    res.json({ status: e.status, qr: e.qr, phone: e.phone });
  } catch (err) {
    next(err);
  }
});

app.post("/session/logout", async (req, res, next) => {
  try {
    const id = safeId(req.body?.sessionId);
    const e = sessions.get(id);
    try {
      await e?.sock?.logout();
    } catch {
      /* already gone */
    }
    sessions.delete(id);
    fs.rmSync(path.join(DATA_DIR, id), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post("/send/text", async (req, res, next) => {
  try {
    const { sessionId, to, text } = req.body ?? {};
    if (!to || !text) return res.status(400).json({ error: "to and text are required" });
    const e = requireSession(sessionId);
    const sent = await e.sock.sendMessage(jid(to), { text: String(text).slice(0, 4000) });
    res.json({ messageId: sent?.key?.id ?? null });
  } catch (err) {
    next(err);
  }
});

app.post("/send/image", async (req, res, next) => {
  try {
    const { sessionId, to, caption, base64, mimetype } = req.body ?? {};
    if (!to || !base64) return res.status(400).json({ error: "to and base64 are required" });
    const e = requireSession(sessionId);
    const sent = await e.sock.sendMessage(jid(to), {
      image: Buffer.from(base64, "base64"),
      mimetype: mimetype || "image/jpeg",
      caption: caption ? String(caption).slice(0, 1020) : undefined,
    });
    res.json({ messageId: sent?.key?.id ?? null });
  } catch (err) {
    next(err);
  }
});

app.post("/send/document", async (req, res, next) => {
  try {
    const { sessionId, to, filename, caption, base64, mimetype } = req.body ?? {};
    if (!to || !base64) return res.status(400).json({ error: "to and base64 are required" });
    const e = requireSession(sessionId);
    const sent = await e.sock.sendMessage(jid(to), {
      document: Buffer.from(base64, "base64"),
      mimetype: mimetype || "application/pdf",
      fileName: filename || "catalogue.pdf",
      caption: caption ? String(caption).slice(0, 1020) : undefined,
    });
    res.json({ messageId: sent?.key?.id ?? null });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || "Bridge error" });
});

app.listen(PORT, () => console.log(`WhatsApp link service listening on :${PORT}`));
