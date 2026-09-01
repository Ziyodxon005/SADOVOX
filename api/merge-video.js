/**
 * SADO VOX — Video Merge API (Vercel Serverless)
 *
 * Video + Dubbed Audio → MP4 birlashtirish
 * server.js dagi /api/merge-video endpoint'ni serverless qilib ko'chirilgan.
 */

import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

  const ts = Date.now();
  const tmpDir = tmpdir();
  const tmpVideo = join(tmpDir, `sv_video_${ts}.mp4`);
  const tmpAudio = join(tmpDir, `sv_audio_${ts}.webm`);

  const cleanup = () => {
    try { if (existsSync(tmpVideo)) unlinkSync(tmpVideo); } catch {}
    try { if (existsSync(tmpAudio)) unlinkSync(tmpAudio); } catch {}
  };

  let formTmpFiles = [];

  try {
    // Lazy import — ffmpeg faqat kerak bo'lganda yuklanadi
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    const ffmpegLib = (await import('fluent-ffmpeg')).default;
    ffmpegLib.setFfmpegPath(ffmpegStatic);

    const { fields, files } = await parseForm(req);
    const videoFile = Array.isArray(files.video) ? files.video[0] : files.video;
    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: 'Video yoki audio fayl yo\'q' });
    }

    formTmpFiles.push(videoFile.filepath, audioFile.filepath);

    // Formidable tmp fayllaridan bizning tmp fayllarga ko'chirish
    writeFileSync(tmpVideo, readFileSync(videoFile.filepath));
    writeFileSync(tmpAudio, readFileSync(audioFile.filepath));

    const nameField = Array.isArray(fields.name) ? fields.name[0] : fields.name;
    const filename = (nameField || 'sadovox_dubbed').replace(/[^\w\-. ]/g, '_');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

    await new Promise((resolve, reject) => {
      const proc = ffmpegLib()
        .input(tmpVideo)
        .input(tmpAudio).inputFormat('webm')
        .outputOptions([
          '-map 0:v:0',
          '-map 1:a:0',
          '-c:v copy',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',
          '-movflags frag_keyframe+empty_moov+default_base_moof',
        ])
        .format('mp4');

      proc.pipe(res, { end: true });

      proc.on('end', () => {
        console.log('[Merge] Video tayyor:', filename);
        cleanup();
        resolve();
      });

      proc.on('error', (err) => {
        console.error('[Merge] ffmpeg xato:', err.message);
        cleanup();
        if (!res.headersSent) res.status(500).json({ error: err.message });
        reject(err);
      });
    });
  } catch (err) {
    console.error('[Merge] Xato:', err);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server xatosi' });
    }
  } finally {
    for (const f of formTmpFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}
