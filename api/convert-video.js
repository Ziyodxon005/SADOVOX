/**
 * SADO VOX — Video Convert API (Vercel Serverless)
 *
 * WebM video (video+audio) → MP4 konvertatsiya
 * Kichik fayllar uchun (< ~4MB)
 */

import { readFileSync, unlinkSync } from 'fs';

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

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
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    const ffmpegLib   = (await import('fluent-ffmpeg')).default;
    ffmpegLib.setFfmpegPath(ffmpegStatic);

    const { fields, files } = await parseForm(req);
    const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;

    if (!videoFile) {
      return res.status(400).json({ error: 'Video fayl yo\'q' });
    }

    tmpFiles.push(videoFile.filepath);
    const nameField = Array.isArray(fields.name) ? fields.name[0] : fields.name;
    const filename  = (nameField || 'sadovox').replace(/[^\w\-. ]/g, '_');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

    await new Promise((resolve, reject) => {
      const proc = ffmpegLib(videoFile.filepath)
        .videoCodec('copy')       // video qayta kodlanmaydi (tez!)
        .audioCodec('aac')
        .audioBitrate('192k')
        .format('mp4')
        .outputOptions(['-movflags frag_keyframe+empty_moov+default_base_moof']);

      proc.pipe(res, { end: true });

      proc.on('error', (err) => {
        console.error('[ConvertVideo] ffmpeg xato:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        reject(err);
      });

      proc.on('end', () => {
        console.log('[ConvertVideo] MP4 tayyor:', filename);
        resolve();
      });
    });

  } catch (err) {
    console.error('[ConvertVideo] Xato:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server xatosi' });
    }
  } finally {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}
