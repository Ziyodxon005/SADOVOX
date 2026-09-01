/**
 * SADO VOX — Gemini WS URL Endpoint (Vercel Serverless)
 *
 * Brauzerga Gemini Live API WS URL'ni qaytaradi.
 * API key faqat shu endpoint da — brauzer to'g'ridan-to'g'ri ulanadi.
 * Key rotation mantiqini saqlaydi.
 */

// ─── API Kalit Rotatsiyasi ────────────────────────────────────────
const API_KEYS = [
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(k => k && k.trim() && k !== 'YOUR_KEY_HERE');

// Serverless muhitda global o'zgaruvchilar cold start'lar orasida yo'qolishi mumkin
// lekin warm instance'da saqlanadi
let currentKeyIndex = 0;
const cooldowns = new Map(); // keyIndex → cooldown end timestamp
const COOLDOWN_MS = 60_000;  // 60 soniya

/**
 * Hozirgi aktiv kalitni qaytaradi
 */
function getKey() {
  if (API_KEYS.length === 0) return null;
  return API_KEYS[currentKeyIndex];
}

/**
 * Hozirgi kalit limitda — keyingisiga o'tish
 */
function rotateKey() {
  const now = Date.now();
  cooldowns.set(currentKeyIndex, now + COOLDOWN_MS);

  for (let i = 1; i <= API_KEYS.length; i++) {
    const next = (currentKeyIndex + i) % API_KEYS.length;
    const cooldownEnd = cooldowns.get(next) || 0;
    if (Date.now() > cooldownEnd) {
      currentKeyIndex = next;
      return API_KEYS[next];
    }
  }
  return null; // Barcha kalitlar limitda
}

// ─── Rate Limiting (IP boshiga) ───────────────────────────────────
const ipRequests = new Map(); // ip → { count, resetTime }
const RATE_WINDOW = 60_000;  // 1 daqiqa
const RATE_MAX    = 30;       // IP boshiga max 30 so'rov/daqiqa

function checkRateLimit(ip) {
  const now = Date.now();
  const record = ipRequests.get(ip);
  if (!record || now > record.resetTime) {
    ipRequests.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }
  if (record.count >= RATE_MAX) return false;
  record.count++;
  return true;
}

// ─── Handler ──────────────────────────────────────────────────────
export default function handler(req, res) {
  // Faqat GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // API key tekshiruvi
  if (API_KEYS.length === 0) {
    return res.status(500).json({ error: 'API kalitlar sozlanmagan' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.socket?.remoteAddress || 'unknown';

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Juda ko\'p so\'rov. Keyinroq urinib ko\'ring.' });
  }

  // Rotate qilish kerakmi tekshirish (query param orqali)
  if (req.query.rotate === 'true') {
    const newKey = rotateKey();
    if (!newKey) {
      return res.status(503).json({ error: 'Barcha API kalitlar limitda. 60s kutib turing.' });
    }
  }

  const key = getKey();
  if (!key) {
    return res.status(503).json({ error: 'Aktiv API kalit topilmadi' });
  }

  const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

  // Cache yo'q — har safar yangi key bo'lishi mumkin
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  return res.status(200).json({
    url: wsUrl,
    keyIndex: currentKeyIndex + 1,
    totalKeys: API_KEYS.length,
  });
}
