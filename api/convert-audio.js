/**
 * SADO VOX — Audio Convert API (Vercel Serverless)
 *
 * WebM audio → MP4 (AAC) konvertatsiya
 * server.js dagi /api/convert-audio endpoint'ni serverless qilib ko'chirilgan.
 */

import { Readable } from 'stream';
import { readFileSync, unlinkSync } from 'fs';

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

/**
 * Formidable bilan multipart form parse qilish
 */
async function parseForm(req) {
  const formidable = (await import('formidable')).default;
  const form = formidable({
    maxFileSize: 500 * 1024 * 1024,
    keepExtensions: true,
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let tmpFiles = [];

  try {
    // Lazy import — ffmpeg faqat kerak bo'lganda yuklanadi
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    const ffmpegLib = (await import('fluent-ffmpeg')).default;
    ffmpegLib.setFfmpegPath(ffmpegStatic);

    const { fields, files } = await parseForm(req);
    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;

    if (!audioFile) {
      return res.status(400).json({ error: 'Fayl yo\'q' });
    }

    tmpFiles.push(audioFile.filepath);
    const nameField = Array.isArray(fields.name) ? fields.name[0] : fields.name;
    const filename = (nameField || 'sadovox_dubbed').replace(/[^\w\-. ]/g, '_');

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

    const inputStream = Readable.from(readFileSync(audioFile.filepath));

    await new Promise((resolve, reject) => {
      const proc = ffmpegLib(inputStream)
        .inputFormat('webm')
        .audioCodec('aac')
        .audioBitrate('192k')
        .format('mp4')
        .outputOptions(['-movflags frag_keyframe+empty_moov+default_base_moof']);

      proc.pipe(res, { end: true });

      proc.on('error', (err) => {
        console.error('[Convert] ffmpeg xato:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        reject(err);
      });

      proc.on('end', () => {
        console.log('[Convert] MP4 tayyorlandi:', filename);
        resolve();
      });
    });
  } catch (err) {
    console.error('[Convert] Xato:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server xatosi' });
    }
  } finally {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}
