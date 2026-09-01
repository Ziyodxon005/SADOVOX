/**
 * SADO VOX — Video Merge API (Vercel Serverless)
 *
 * Video + Dubbed Audio → MP4 birlashtirish
 * server.js dagi /api/merge-video endpoint'ni serverless qilib ko'chirilgan.
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { IncomingForm } from 'formidable';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

ffmpeg.setFfmpegPath(ffmpegPath);

// Vercel serverless'da body parsing'ni o'chiramiz
export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

/**
 * Formidable bilan multipart form parse qilish
 */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      maxFileSize: 500 * 1024 * 1024, // 500 MB
      keepExtensions: true,
    });
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
    const { fields, files } = await parseForm(req);
    const videoFile = files.video?.[0] || files.video;
    const audioFile = files.audio?.[0] || files.audio;

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: 'Video yoki audio fayl yo\'q' });
    }

    formTmpFiles.push(videoFile.filepath, audioFile.filepath);

    // Formidable tmp fayllaridan bizning tmp fayllarga ko'chirish
    const { readFileSync } = await import('fs');
    writeFileSync(tmpVideo, readFileSync(videoFile.filepath));
    writeFileSync(tmpAudio, readFileSync(audioFile.filepath));

    const filename = (fields.name?.[0] || fields.name || 'sadovox_dubbed').replace(/[^\w\-. ]/g, '_');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp4"`);

    await new Promise((resolve, reject) => {
      const proc = ffmpeg()
        .input(tmpVideo)                          // 0: asl video
        .input(tmpAudio).inputFormat('webm')      // 1: dubbed audio
        .outputOptions([
          '-map 0:v:0',                           // video treki asl videodan
          '-map 1:a:0',                           // audio treki dubbed audiodan
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
    // Formidable tmp fayllarini tozalash
    for (const f of formTmpFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}
