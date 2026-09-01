/**
 * SADO VOX — Secure Node.js Backend Server
 *
 * Vazifalar:
 *  1. Static fayllarni serve qilish (index.html, style.css, app.js, ...)
 *  2. WebSocket proxy: brauzer ↔ Gemini Live API
 *     API key faqat shu yerda — brauzer hech qachon ko'rmaydi
 *  3. Xavfsizlik: Helmet sarlavhalari, Rate limiting, IP tekshiruvi
 *  4. Rate limiting: IP boshiga max sessiyalar soni
 */

import 'dotenv/config';
import express    from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import helmet    from 'helmet';
import rateLimit  from 'express-rate-limit';
import multer     from 'multer';
import ffmpeg     from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── API Kalit Rotatsiyasi ────────────────────────────────────────
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(k => k && k.trim() && k !== 'YOUR_KEY_HERE');

if (API_KEYS.length === 0) {
  console.error('❌  XATO: .env faylida hech qanday GEMINI_API_KEY_N yo\'q!');
  console.error('    GEMINI_API_KEY_1=AIzaSy... qilib kiriting.');
  process.exit(1);
}

/**
 * KeyRotator: limit tugagan kalitni vaqtincha o'chirib qo'yadi,
 * boshqa kalit bo'lsa avtomatik o'tadi.
 */
class KeyRotator {
  constructor(keys) {
    this.keys    = keys;
    this.current = 0;
    this.cooldowns = new Map(); // keyIndex → cooldown end timestamp
    this.COOLDOWN_MS = 60_000;  // 60 soniya
    console.log(`[Keys] ${keys.length} ta API kalit yuklandi.`);
  }

  /** Hozirgi aktiv kalitni qaytaradi */
  getKey() {
    return this.keys[this.current];
  }

  getKeyIndex() {
    return this.current;
  }

  /**
   * Hozirgi kalit limitda — keyingisiga o'tish.
   * @returns {string|null} yangi kalit, yoki null (hammasi limitda)
   */
  rotateKey() {
    const now = Date.now();
    this.cooldowns.set(this.current, now + this.COOLDOWN_MS);
    console.warn(`[Keys] Kalit #${this.current + 1} limitda — ${this.COOLDOWN_MS / 1000}s cooldown.`);

    // Keyingi mavjud kalitni topish
    for (let i = 1; i <= this.keys.length; i++) {
      const next = (this.current + i) % this.keys.length;
      const cooldownEnd = this.cooldowns.get(next) || 0;
      if (Date.now() > cooldownEnd) {
        this.current = next;
        console.log(`[Keys] Kalit #${next + 1} ga o'tildi.`);
        return this.keys[next];
      }
    }

    console.error('[Keys] Barcha kalitlar limitda!');
    return null;
  }

  /** Xato rate-limit ekanligini tekshiradi */
  isQuotaError(msg) {
    try {
      const txt = typeof msg === 'string' ? msg : Buffer.from(msg).toString('utf8');
      const obj = JSON.parse(txt);
      const code = obj?.error?.code || obj?.error?.status || '';
      return code === 429 || code === 503 ||
             String(code).includes('RESOURCE_EXHAUSTED') ||
             String(code).includes('QUOTA');
    } catch { return false; }
  }

  buildUrl(key) {
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;
  }
}

const keyRotator = new KeyRotator(API_KEYS);

// ─── Boshqa muhit o'zgaruvchilari ────────────────────────────
const PORT             = parseInt(process.env.PORT || '3000');
const MAX_SESSIONS_PER_IP = parseInt(process.env.MAX_SESSIONS_PER_IP || '3');
const NODE_ENV         = process.env.NODE_ENV || 'development';

// ─── IP boshiga sessiyalar hisoblagichi ───────────────────────
const ipSessions = new Map(); // ip → Set<WebSocket>

function getIpSessions(ip) {
  if (!ipSessions.has(ip)) ipSessions.set(ip, new Set());
  return ipSessions.get(ip);
}

function addSession(ip, ws) {
  getIpSessions(ip).add(ws);
}

function removeSession(ip, ws) {
  const sessions = getIpSessions(ip);
  sessions.delete(ws);
  if (sessions.size === 0) ipSessions.delete(ip);
}

// ─── Express App ──────────────────────────────────────────────
const app = express();

// 🛡️  Xavfsizlik sarlavhalari (Helmet — CSP siz, chunki AudioWorklet bilan muammo)
app.use(helmet({
  contentSecurityPolicy: false,          // AudioWorklet + blob: URL muammosidan saqlanish
  crossOriginEmbedderPolicy: false,      // blob: video URL lari uchun
  frameguard:   { action: 'deny' },      // Clickjacking himoya
  noSniff:      true,                    // MIME sniffing blok
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// 🛡️  HTTP so'rovlari uchun Rate limiting
const httpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 daqiqa
  max: 100,                  // IP boshiga max 100 so'rov
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Juda ko\'p so\'rov. Keyinroq urinib ko\'ring.' },
});
app.use(httpLimiter);

// Static fayllarni serve qilish
app.use(express.static(__dirname, {
  dotfiles: 'deny',
  index: 'index.html',
}));

// ─── Keep-Alive: UptimeRobot yoki cron-job.org ping uchun ────
app.get('/ping', (_req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── API: WebM → MP4 Audio Konvertatsiya ──────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
});

app.post('/api/convert-audio', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Fayl yo\'q' });
  }

  const inputStream = Readable.from(req.file.buffer);
  const filename    = (req.body?.name || 'sadovox_dubbed').replace(/[^\w\-. ]/g, '_');

  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

  const proc = ffmpeg(inputStream)
    .inputFormat('webm')
    .audioCodec('aac')
    .audioBitrate('192k')
    .format('mp4')
    .outputOptions(['-movflags frag_keyframe+empty_moov+default_base_moof']);

  proc.pipe(res, { end: true });

  proc.on('error', (err) => {
    console.error('[Convert] ffmpeg xato:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  proc.on('end', () => {
    console.log('[Convert] MP4 tayyorlandi:', filename);
  });
});

// ─── API: Video + Dubbed Audio → MP4 birlashtirish ────────────
const uploadFields = upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

app.post('/api/merge-video', uploadFields, (req, res) => {
  const videoFile = req.files?.video?.[0];
  const audioFile = req.files?.audio?.[0];

  if (!videoFile || !audioFile) {
    return res.status(400).json({ error: 'Video yoki audio fayl yo\'q' });
  }

  const ts       = Date.now();
  const tmpDir   = tmpdir();
  const tmpVideo = join(tmpDir, `sv_video_${ts}.mp4`);
  const tmpAudio = join(tmpDir, `sv_audio_${ts}.webm`);

  const cleanup = () => {
    try { if (existsSync(tmpVideo)) unlinkSync(tmpVideo); } catch {}
    try { if (existsSync(tmpAudio)) unlinkSync(tmpAudio); } catch {}
  };

  try {
    writeFileSync(tmpVideo, videoFile.buffer);
    writeFileSync(tmpAudio, audioFile.buffer);
  } catch (writeErr) {
    cleanup();
    return res.status(500).json({ error: 'Vaqtinchalik fayl yozishda xato: ' + writeErr.message });
  }

  const filename = (req.body?.name || 'sadovox_dubbed').replace(/[^\w\-. ]/g, '_');

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

  const proc = ffmpeg()
    .input(tmpVideo)                          // 0: asl video
    .input(tmpAudio).inputFormat('webm')      // 1: dubbed audio
    .outputOptions([
      '-map 0:v:0',                           // video treki asl videodан
      '-map 1:a:0',                           // audio treki dubbed audiodан
      '-c:v copy',                            // videoni qayta enkodlamaslik (tez!)
      '-c:a aac',
      '-b:a 192k',
      '-shortest',                            // qisqaroq trekda tugaydi
      '-movflags frag_keyframe+empty_moov+default_base_moof',
    ])
    .format('mp4');

  proc.pipe(res, { end: true });

  proc.on('end', () => {
    console.log('[Merge] Video tayyor:', filename);
    cleanup();
  });

  proc.on('error', (err) => {
    console.error('[Merge] ffmpeg xato:', err.message);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
});

// ─── HTTP Server ──────────────────────────────────────────────
const server = createServer(app);

// ─── WebSocket Server (Proxy) ─────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // WebSocket ulanishlar uchun rate limiting (handshake darajasida)
  verifyClient: (info, done) => {
    const ip = getClientIp(info.req);
    const sessions = getIpSessions(ip);

    if (sessions.size >= MAX_SESSIONS_PER_IP) {
      console.warn(`[WS] Rate limit: ${ip} — ${sessions.size} sessiya mavjud (max: ${MAX_SESSIONS_PER_IP})`);
      done(false, 429, 'Too Many Sessions');
      return;
    }
    done(true);
  }
});

wss.on('connection', (clientWs, req) => {
  const ip = getClientIp(req);
  addSession(ip, clientWs);

  console.log(`[WS] Yangi ulanish: ${ip} (jami: ${getIpSessions(ip).size})`);

  // Gemini Live API ga ulanish (hozirgi aktiv kalit bilan)
  function connectToGemini() {
    const key = keyRotator.getKey();
    const url = keyRotator.buildUrl(key);
    console.log(`[Gemini] Ulanmoqda (kalit #${keyRotator.getKeyIndex() + 1}) — ${ip}`);
    return new WebSocket(url);
  }

  let geminiWs = connectToGemini();
  geminiWs.binaryType = 'arraybuffer';

  let geminiReady = false;
  let rotating    = false;
  const clientQueue = [];

  function setupGeminiHandlers(gWs) {
    gWs.on('open', () => {
      geminiReady = true;
      rotating    = false;
      console.log(`[Gemini] Ulanish ochildi (kalit #${keyRotator.getKeyIndex() + 1}, ${ip})`);
      while (clientQueue.length > 0) {
        const msg = clientQueue.shift();
        if (gWs.readyState === WebSocket.OPEN) gWs.send(msg);
      }
    });

    gWs.on('message', (data) => {
      // Rate-limit xatosini tekshirish
      if (keyRotator.isQuotaError(data)) {
        console.warn(`[Keys] Kalit #${keyRotator.getKeyIndex() + 1} limitga yetdi — rotatsiya...`);
        const newKey = keyRotator.rotateKey();
        if (newKey && !rotating) {
          rotating = true;
          geminiReady = false;
          gWs.close(1000, 'key_rotate');
          geminiWs = connectToGemini();
          geminiWs.binaryType = 'arraybuffer';
          setupGeminiHandlers(geminiWs);
          return; // xatoni brauzerga yubormay yangi kalit bilan ulanish
        }
      }
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });

    gWs.on('error', (err) => {
      console.error(`[Gemini] Xato (kalit #${keyRotator.getKeyIndex() + 1}, ${ip}):`, err.message);
      // 429/quota xatosi bo'lsa kalit almashtir
      if ((err.message.includes('429') || err.message.includes('quota')) && !rotating) {
        const newKey = keyRotator.rotateKey();
        if (newKey) {
          rotating = true;
          geminiReady = false;
          geminiWs = connectToGemini();
          geminiWs.binaryType = 'arraybuffer';
          setupGeminiHandlers(geminiWs);
          return;
        }
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          error: { message: 'Gemini API ga ulanishda xato', code: 500 }
        }));
        clientWs.close(1011, 'Gemini error');
      }
    });

    gWs.on('close', (code, reason) => {
      if (rotating) return; // rotatsiya davom etmoqda
      console.log(`[Gemini] Yopildi (kalit #${keyRotator.getKeyIndex() + 1}, ${ip}) — kod: ${code}`);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
    });
  }

  setupGeminiHandlers(geminiWs);

  // ── Brauzer → Gemini ──────────────────────────────────────
  clientWs.on('message', (data) => {
    // Xabar hajmini tekshirish (max 1MB per chunk)
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (size > 1_000_000) {
      console.warn(`[WS] Juda katta xabar (${ip}): ${size} bytes`);
      return;
    }

    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(data);
    } else {
      clientQueue.push(data);
    }
  });

  clientWs.on('close', (code, reason) => {
    console.log(`[WS] Ulanish yopildi: ${ip} — kod: ${code}`);
    removeSession(ip, clientWs);
    if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
      geminiWs.close(1000, 'Client disconnected');
    }
  });

  clientWs.on('error', (err) => {
    console.error(`[WS] Client xatosi (${ip}):`, err.message);
    removeSession(ip, clientWs);
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close(1000, 'Client error');
    }
  });
});

// ─── Yordamchi: Client IP olish ──────────────────────────────
function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ─── Serverni ishga tushirish ─────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  🎤 SADO VOX Server — port ${PORT}         ║`);
  console.log('║──────────────────────────────────────────║');
  console.log(`║  🌐  http://localhost:${PORT}               ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ─── Graceful shutdown ────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[Server] To\'xtatilmoqda...');
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    console.log('[Server] Yopildi.');
    process.exit(0);
  });
});
