const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Accepts either BRIDGE_TOKEN or WA_BRIDGE_TOKEN, and automatically trims spaces
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || process.env.WA_BRIDGE_TOKEN || '').trim();
const PORT = process.env.PORT || 10000;
const DATA_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const sessions = new Map();

function safeId(rawId) {
  return String(rawId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

// 1. Public Health Check (Render monitors this to know the service is alive)
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'online',
    hasTokenConfigured: !!BRIDGE_TOKEN,
    timestamp: new Date().toISOString()
  });
});

// Authentication middleware (protects all WhatsApp endpoints)
app.use((req, res, next) => {
  const incoming = (
    req.headers['x-bridge-token'] || 
    req.headers['authorization'] || 
    ''
  ).replace(/^Bearer\s+/i, '').trim();

  if (!BRIDGE_TOKEN) {
    return res.status(500).json({ error: 'Server misconfiguration: BRIDGE_TOKEN is not set in Render environment.' });
  }
  if (!incoming || incoming !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: invalid x-bridge-token' });
  }
  next();
});

async function getOrCreateSession(rawId) {
  const id = safeId(rawId);
  if (!id) throw new Error('sessionId is required');

  const existing = sessions.get(id);
  if (existing && (existing.status === 'connected' || existing.status === 'qr')) {
    return existing;
  }

  const dir = path.join(DATA_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const entry = existing || { status: 'connecting', qr: null, phone: null, sock: null };
  sessions.set(id, entry);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      entry.status = 'qr';
      try {
        entry.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch (err) {
        console.error('QR code generation error:', err);
      }
    }
    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.phone = sock.user?.id?.split(':')[0] || null;
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      entry.status = 'disconnected';
      entry.sock = null;
      entry.qr = null;
      if (shouldReconnect) {
        setTimeout(() => getOrCreateSession(id).catch(() => {}), 3000);
      } else {
        sessions.delete(id);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Wait a short moment to capture immediate QR if ready
  for (let i = 0; i < 20 && entry.status === 'connecting'; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }

  return entry;
}

// 2. Start session (generates QR code)
app.post('/session/start', async (req, res) => {
  try {
    const session = await getOrCreateSession(req.body?.sessionId);
    res.json({ status: session.status, qr: session.qr, phone: session.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Status of session
app.get('/session/status', async (req, res) => {
  try {
    const id = safeId(req.query.sessionId);
    let session = sessions.get(id);
    if (!session) {
      session = await getOrCreateSession(id);
    }
    res.json({ status: session.status, qr: session.qr, phone: session.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Request 8-digit phone pairing code
app.post('/session/pair', async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 10) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    const session = await getOrCreateSession(req.body?.sessionId);
    if (session.status === 'connected') {
      return res.json({ code: null, status: 'connected' });
    }
    if (!session.sock) {
      return res.status(500).json({ error: 'Socket not initialized' });
    }
    const code = await session.sock.requestPairingCode(phone);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Logout session
app.post('/session/logout', async (req, res) => {
  try {
    const id = safeId(req.body?.sessionId);
    const session = sessions.get(id);
    if (session?.sock) {
      try { await session.sock.logout(); } catch (_) {}
    }
    sessions.delete(id);
    const dir = path.join(DATA_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Direct WhatsApp message sending
app.post('/send/text', async (req, res) => {
  try {
    const { sessionId, to, text } = req.body || {};
    if (!to || !text) return res.status(400).json({ error: 'to and text are required' });
    const id = safeId(sessionId);
    const session = sessions.get(id);
    if (!session || session.status !== 'connected' || !session.sock) {
      return res.status(409).json({ error: 'WhatsApp session not connected. Scan the QR code.' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const jid = `${cleanTo}@s.whatsapp.net`;
    const sent = await session.sock.sendMessage(jid, { text: String(text).slice(0, 4000) });
    res.json({ messageId: sent?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Send photos as real WhatsApp images (opens directly in chat)
app.post('/send/image', async (req, res) => {
  try {
    const { sessionId, to, caption, base64, mimetype } = req.body || {};
    if (!to || !base64) return res.status(400).json({ error: 'to and base64 are required' });
    const id = safeId(sessionId);
    const session = sessions.get(id);
    if (!session || session.status !== 'connected' || !session.sock) {
      return res.status(409).json({ error: 'WhatsApp session not connected. Scan the QR code.' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const jid = `${cleanTo}@s.whatsapp.net`;
    const sent = await session.sock.sendMessage(jid, {
      image: Buffer.from(base64, 'base64'),
      mimetype: mimetype || 'image/jpeg',
      caption: caption ? String(caption).slice(0, 1020) : undefined
    });
    res.json({ messageId: sent?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Send files & catalogues (PDF, Word, Excel...) with their real filename and type
app.post('/send/document', async (req, res) => {
  try {
    const { sessionId, to, filename, caption, base64, mimetype } = req.body || {};
    if (!to || !base64) return res.status(400).json({ error: 'to and base64 are required' });
    const id = safeId(sessionId);
    const session = sessions.get(id);
    if (!session || session.status !== 'connected' || !session.sock) {
      return res.status(409).json({ error: 'WhatsApp session not connected. Scan the QR code.' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const jid = `${cleanTo}@s.whatsapp.net`;
    const sent = await session.sock.sendMessage(jid, {
      document: Buffer.from(base64, 'base64'),
      mimetype: mimetype || 'application/pdf',
      fileName: filename || 'file.pdf',
      caption: caption ? String(caption).slice(0, 1020) : undefined
    });
    res.json({ messageId: sent?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`B2BKAR Baileys Bridge listening on port ${PORT}`);
});
