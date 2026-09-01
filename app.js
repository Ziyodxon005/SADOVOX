/**
 * SADO VOX — Main Application Logic v3
 * Views: Splash → Dashboard → Editor
 * Features: Project save/load (IndexedDB), dubbed audio recording, download
 */

import { GeminiLiveTranslate } from './gemini-live.js';
import { CONFIG } from './config.js';
import {
  saveProject, getProjects, getProject, deleteProject,
  saveBlob, getBlob,
} from './db.js';

/* ─── Constants ───────────────────────────────────────────── */
const SEEN_KEY = 'sadovox_seen_v1';

/* ─── App State ───────────────────────────────────────────── */
const state = {
  // Current view
  currentView: 'splash',

  // Current project
  projectId: null,
  projectName: null,
  videoBlob: null,
  videoFile: null,

  // Dubbing
  targetLanguage: 'uz',
  gemini: null,
  audioContext: null,
  captureNode: null,
  silentGain: null,
  mediaSource: null,
  nextPlayTime: 0,
  videoReady: false,
  dubbing: false,
  paused: false,
  inputTranscript: '',
  outputTranscript: '',
  waveAnimFrame: null,

  // Recording
  recordingDest: null,
  mediaRecorder: null,
  recordedChunks: [],
  recordedBlob: null,
  dubAudio: null,
  savedDubMode: false,  // true = saqlangan dublyaj ko'rish rejimi
};

/* ─── DOM refs ────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initSplash();
  initEditor();
  initLogoNav();

  // Brauzer back tugmasi uchun popstate listener
  window.addEventListener('popstate', onPopState);

  if (localStorage.getItem(SEEN_KEY)) {
    showView('dashboard', false);
    history.replaceState({ view: 'dashboard' }, '', '#dashboard');
    loadDashboard();
  } else {
    showView('splash', false);
    history.replaceState({ view: 'splash' }, '', '#splash');
  }
});

// Brauzer orqaga/oldinga tugmasi handler
async function onPopState(e) {
  const target = e.state?.view || 'dashboard';

  // Editor holatini tozalash
  if (state.dubbing) await stopDubbing();
  cleanupDubAudio();

  if (target === 'dashboard') {
    showView('dashboard', false);
    loadDashboard();
  } else if (target === 'splash') {
    showView('splash', false);
  } else {
    // Editor kontekstsiz ochib bo'lmaydi — dashboardga
    showView('dashboard', false);
    loadDashboard();
  }
}

/* ══════════════════════════════════════════════════════════
   VIEW MANAGER
══════════════════════════════════════════════════════════ */
/**
 * Viewni ko'rsatadi. pushHistory=true bo'lsa history.pushState chaqiriladi.
 */
function showView(name, pushHistory = true) {
  ['splash', 'dashboard', 'editor'].forEach(v => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  state.currentView = name;
  if (pushHistory) {
    history.pushState({ view: name }, '', `#${name}`);
  }
}

/* ══════════════════════════════════════════════════════════
   LOGO NAVIGATION
══════════════════════════════════════════════════════════ */
function initLogoNav() {
  // Barcha .topbar-logo elementlarini kliklanganda dashboardga o'tkazish
  document.querySelectorAll('.topbar-logo').forEach(el => {
    el.style.cursor = 'pointer';
    el.title = 'Asosiy sahifaga qaytish';
    el.addEventListener('click', async () => {
      if (state.currentView === 'dashboard') return; // allaqachon dashboard
      if (state.dubbing) await stopDubbing();
      cleanupDubAudio();
      showView('dashboard');
      loadDashboard();
    });
  });
}

/* ══════════════════════════════════════════════════════════
   SPLASH
══════════════════════════════════════════════════════════ */
let splashIdx = 0;
const SLIDE_COUNT = 3;

function initSplash() {
  $('splash-next').addEventListener('click', onSplashNext);
  $('splash-prev').addEventListener('click', () => goSlide(splashIdx - 1));
  $('splash-skip').addEventListener('click', finishSplash);

  // Dot click
  document.querySelectorAll('.s-dot').forEach(dot => {
    dot.addEventListener('click', () => goSlide(+dot.dataset.idx));
  });

  goSlide(0);
}

function onSplashNext() {
  if (splashIdx < SLIDE_COUNT - 1) {
    goSlide(splashIdx + 1);
  } else {
    finishSplash();
  }
}

function goSlide(idx) {
  splashIdx = Math.max(0, Math.min(idx, SLIDE_COUNT - 1));
  $('splash-track').style.transform = `translateX(-${splashIdx * 100}%)`;

  // Dots
  document.querySelectorAll('.s-dot').forEach((d, i) =>
    d.classList.toggle('active', i === splashIdx)
  );

  // Prev button
  $('splash-prev').disabled = splashIdx === 0;

  // Next button label — span.btn-label-desktop mobileda yashiriladi
  $('splash-next').innerHTML = splashIdx === SLIDE_COUNT - 1
    ? '<span class="btn-label-desktop">Boshlash</span> →'
    : '<span class="btn-label-desktop">Keyingi</span> →';
}

function finishSplash() {
  localStorage.setItem(SEEN_KEY, '1');
  // Splash ni history dan olib tashlaymiz — orqaga borilganda splash qaytmasin
  history.replaceState({ view: 'dashboard' }, '', '#dashboard');
  showView('dashboard', false);
  loadDashboard();
}

/* ══════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════ */
async function loadDashboard() {
  const grid = $('projects-grid');
  const empty = $('projects-empty');

  // Remove old cards (keep empty placeholder in DOM)
  grid.querySelectorAll('.project-card').forEach(c => c.remove());

  let projects = [];
  try { projects = await getProjects(); } catch { }

  if (projects.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const p of projects) {
      grid.appendChild(await buildProjectCard(p));
    }
  }

  // "Yangi Loyiha" button
  $('new-project-btn').onclick = () => openNewProject();
}

async function buildProjectCard(p) {
  const card = document.createElement('div');
  card.className = 'project-card';
  card.dataset.id = p.id;

  // Thumb
  const thumb = document.createElement('div');
  thumb.className = 'project-thumb';

  const videoBlob = await getBlob(`video_${p.id}`).catch(() => null);
  if (videoBlob) {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(videoBlob);
    vid.muted = true; vid.preload = 'metadata';
    vid.addEventListener('loadedmetadata', () => { vid.currentTime = 1; });
    thumb.appendChild(vid);
  } else {
    thumb.innerHTML = '<span class="project-thumb-icon">🎬</span>';
  }

  // Info
  const date = new Date(p.createdAt).toLocaleDateString('uz-UZ', {
    day: '2-digit', month: 'short', year: 'numeric'
  });

  const hasAudio = await getBlob(`audio_${p.id}`).then(b => !!b).catch(() => false);

  card.innerHTML = `
    <div class="project-thumb"></div>
    <div class="project-info">
      <div class="project-name">${escHtml(p.name)}</div>
      <div class="project-meta">
        <span>${date}</span>
        ${p.duration ? `<span class="project-meta-dot"></span><span>${fmtDuration(p.duration)}</span>` : ''}
      </div>
    </div>
    <div class="project-badges">
      ${p.hasVideo ? '<span class="project-badge badge-video">Video</span>' : ''}
      ${hasAudio ? '<span class="project-badge badge-audio">Dublyaj qilingan</span>' : ''}
    </div>
    <div class="project-actions">
      <button class="project-btn project-btn-open">▶ Ochish</button>
      <button class="project-btn project-btn-del">🗑 O'chirish</button>
    </div>
  `;

  card.querySelector('.project-thumb').appendChild(thumb);

  card.querySelector('.project-btn-open').addEventListener('click', e => {
    e.stopPropagation();
    openExistingProject(p.id);
  });
  card.querySelector('.project-btn-del').addEventListener('click', async e => {
    e.stopPropagation();
    const ok = await showConfirm(
      'Loyihani o\'chirish',
      `"${p.name}" loyihasini o'chirmoqchimisiz?\nVideo va dubbed audio ham o'chib ketadi.`
    );
    if (ok) {
      await deleteProject(p.id).catch(() => { });
      loadDashboard();
    }
  });

  return card;
}

/* ══════════════════════════════════════════════════════════
   PROJECT OPENING
══════════════════════════════════════════════════════════ */

function openNewProject() {
  state.projectId = generateId();
  state.projectName = `Loyiha ${new Date().toLocaleDateString('uz-UZ')}`;
  state.videoBlob = null;
  state.recordedBlob = null;
  resetEditorUI();
  showView('editor');
}

async function openExistingProject(id) {
  try {
    const p = await getProject(id);
    if (!p) return;

    state.projectId = p.id;
    state.projectName = p.name;
    state.recordedBlob = null;

    resetEditorUI();
    showView('editor');

    // 1. Video yuklash
    const videoBlob = await getBlob(`video_${id}`).catch(() => null);
    if (videoBlob) {
      state.videoBlob = videoBlob;
      loadVideoFromBlob(videoBlob, p.name);
    }

    // 2. Dubbed audio yuklash va sinxronlash
    const audioBlob = await getBlob(`audio_${id}`).catch(() => null);
    if (audioBlob) {
      state.recordedBlob = audioBlob;
      showDownloadBtn(true);
      // Video yuklangandan keyin dubbed playback sozlash
      $('main-video').addEventListener('loadedmetadata', () => {
        setupDubbedPlayback(audioBlob);
      }, { once: true });
    }
  } catch (err) {
    showError('Loyiha ochishda xato: ' + err.message);
  }
}

/**
 * Saqlangan dubbed audio ni video bilan sinxron ijro etadi.
 * Video muted — faqat dubbed audio eshitiladi.
 */
function setupDubbedPlayback(audioBlob) {
  cleanupDubAudio();

  const audio = new Audio();
  audio.src = URL.createObjectURL(audioBlob);
  audio.volume = 1.0;
  state.dubAudio = audio;
  state.savedDubMode = true;  // Saqlangan rejim yoqildi

  // Video original ovozi o'chiq
  const vid = $('main-video');
  vid.muted = true;

  // Sinxronlash
  const onPlay = () => { audio.currentTime = vid.currentTime; audio.play().catch(() => { }); };
  const onPause = () => audio.pause();
  const onSeeked = () => { audio.currentTime = Math.min(vid.currentTime, audio.duration || 0); };
  const onEnded = () => { audio.pause(); audio.currentTime = 0; };

  vid.addEventListener('play', onPlay);
  vid.addEventListener('pause', onPause);
  vid.addEventListener('seeked', onSeeked);
  vid.addEventListener('ended', onEnded);

  state._cleanDubAudioListeners = () => {
    vid.removeEventListener('play', onPlay);
    vid.removeEventListener('pause', onPause);
    vid.removeEventListener('seeked', onSeeked);
    vid.removeEventListener('ended', onEnded);
  };

  // UI: faqat download + reset ko'rinsin, dublyaj tugmasi yashirin
  $('dub-btn').classList.add('hidden');
  $('stop-btn').classList.add('hidden');
  showDownloadBtn(true);
  showStatus('🎧 Saqlangan dublyaj — Play bosing', 'ready');
}

function cleanupDubAudio() {
  if (state._cleanDubAudioListeners) {
    state._cleanDubAudioListeners();
    state._cleanDubAudioListeners = null;
  }
  if (state.dubAudio) {
    state.dubAudio.pause();
    URL.revokeObjectURL(state.dubAudio.src);
    state.dubAudio = null;
  }
  state.savedDubMode = false;
  $('main-video').muted = false;
  // Dub/stop tugmalarini qaytarish
  $('dub-btn').classList.remove('hidden');
  $('stop-btn').classList.remove('hidden');
}

/* ══════════════════════════════════════════════════════════
   EDITOR INIT
══════════════════════════════════════════════════════════ */
function initEditor() {
  // Back button
  $('back-to-dash').addEventListener('click', () => {
    // history.back() → popstate → onPopState → dashboard
    history.back();
  });

  // Drop zone
  $('drop-zone').addEventListener('click', () => $('file-input').click());
  $('drop-zone').addEventListener('dragover', onDragOver);
  $('drop-zone').addEventListener('dragleave', onDragLeave);
  $('drop-zone').addEventListener('drop', onDrop);
  $('file-input').addEventListener('change', e => {
    if (e.target.files[0]) handleFileSelect(e.target.files[0]);
  });

  // Controls
  $('dub-btn').addEventListener('click', toggleDubbing);
  $('stop-btn').addEventListener('click', stopDubbing);
  $('reset-btn').addEventListener('click', () => {
    if (state.savedDubMode) {
      // Saqlangan rejimda: faqat dubbed audioni tozala, video qolsin
      cleanupDubAudio();           // savedDubMode = false, dub-btn qaytadi
      state.recordedBlob = null;
      showDownloadBtn(false);
      if (state.dubbing) stopDubbing();
      $('dub-btn').disabled = !state.videoReady;
      $('stop-btn').disabled = true;
      updateDubBtn('start');
      showStatus('Qayta dublyaj uchun tayyor \u2014 Dublyaj Boshlash tugmasini bosing', 'ready');
    } else {
      // Yangi loyiha rejimida: hammani tozalab upload ekraniga qaytarish
      if (state.dubbing) stopDubbing();
      cleanupAudio();
      state.recordedBlob = null;
      resetEditorUI();
    }
  });
  $('download-btn').addEventListener('click', downloadDubbedAudio);

  // Video events
  const vid = $('main-video');
  vid.addEventListener('loadedmetadata', onVideoLoaded);
  vid.addEventListener('play', onVideoPlay);
  vid.addEventListener('pause', onVideoPause);
  vid.addEventListener('ended', onVideoEnded);
  vid.addEventListener('seeked', onVideoSeeked);
}

function resetEditorUI() {
  cleanupDubAudio();
  $('setup-section').classList.remove('hidden');
  $('player-section').classList.add('hidden');
  $('transcript-panel').classList.add('hidden');
  showDownloadBtn(false);
  $('dub-btn').disabled = true;
  $('stop-btn').disabled = true;
  updateDubBtn('start');
  showStatus('Video yuklang va dublyajni boshlang', 'idle');
  $('input-transcript').innerHTML = '<em>Nutq shu yerda paydo bo\'ladi...</em>';
  $('output-transcript').innerHTML = '<em>Tarjima shu yerda ko\'rinadi...</em>';
  $('latency-badge').classList.add('hidden');

  const vid = $('main-video');
  if (vid.src) URL.revokeObjectURL(vid.src);
  vid.src = '';
  state.videoReady = false;
  state.dubbing = false;
  state.paused = false;
}

/* ─── Drag & Drop ─────────────────────────────────────────── */
function onDragOver(e) {
  e.preventDefault();
  $('drop-zone').classList.add('drag-over');
}
function onDragLeave() {
  $('drop-zone').classList.remove('drag-over');
}
function onDrop(e) {
  e.preventDefault();
  $('drop-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type.startsWith('video/')) {
    handleFileSelect(file);
  } else {
    showError('Iltimos, video fayl yuklang (MP4, WebM, MOV va b.)');
  }
}

/* ─── File Handling ───────────────────────────────────────── */
async function handleFileSelect(file) {
  state.videoFile = file;
  state.videoBlob = file;
  state.projectName = file.name.replace(/\.[^.]+$/, '');
  loadVideoFromBlob(file, file.name);

  // Save video to IndexedDB immediately
  try {
    await saveBlob(`video_${state.projectId}`, file);
  } catch (e) {
    console.warn('[DB] Video saqlanmadi (hajm katta bo\'lishi mumkin):', e.message);
  }
}

function loadVideoFromBlob(blob, name) {
  const vid = $('main-video');
  const url = URL.createObjectURL(blob);
  vid.src = url;
  vid.muted = false;
  $('video-name').textContent = name || 'video';
  state.videoReady = false;
  showStatus('Video yuklanmoqda...', 'loading');
  $('setup-section').classList.add('hidden');
  $('player-section').classList.remove('hidden');
  setTimeout(() => $('player-section').scrollIntoView({ behavior: 'smooth' }), 100);
}

function onVideoLoaded() {
  state.videoReady = true;
  // savedDubMode da dub-btn yoqilmaydi — faqat reset orqali
  if (!state.savedDubMode) {
    $('dub-btn').disabled = false;
    showStatus('Video tayyor ✓', 'ready');
  }
  // Duration ni loyiha metasiga saqlash
  const dur = $('main-video').duration;
  if (dur && state.projectId) {
    saveProject({
      id: state.projectId,
      name: state.projectName,
      createdAt: Date.now(),
      duration: dur,
      hasVideo: !!state.videoBlob,
    }).catch(() => { });
  }
}

/* ══════════════════════════════════════════════════════════
   DUBBING CONTROL
══════════════════════════════════════════════════════════ */
async function toggleDubbing() {
  if (state.dubbing && !state.paused) pauseDubbing();
  else if (state.dubbing && state.paused) resumeDubbing();
  else await startDubbing();
}

async function startDubbing() {
  if (!state.videoReady) {
    showError('Iltimos avval video yuklang.');
    return;
  }
  try {
    showStatus('SADO VOX bilan ulanmoqda... (iltimos kuting)', 'connecting');
    $('dub-btn').disabled = true;
    $('stop-btn').disabled = false;  // to'xtatish imkoni bo'lsin

    await setupAudioContext();

    state.gemini = new GeminiLiveTranslate(state.targetLanguage);
    state.dubbing = true;
    state.paused = false;

    attachAIListeners();
    await state.gemini.connect();
    // ⚠️ Video 'ready' hodisasida boshlanadi — bu yerda EMAS

    showDownloadBtn(false);
    $('transcript-panel').classList.remove('hidden');

  } catch (err) {
    console.error('[App] startDubbing error:', err);
    showError(`Ulanishda xato: ${err.message || err}`);
    showStatus('Xato yuz berdi', 'error');
    state.dubbing = false;
    $('dub-btn').disabled = false;
    $('stop-btn').disabled = true;
    cleanupAudio();
  }
}

function pauseDubbing() {
  state.paused = true;
  $('main-video').pause();
  if (state.captureNode) state.captureNode.port.postMessage({ type: 'stop' });
  if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.pause();
  updateDubBtn('resume');
  showStatus('⏸ Pauza', 'paused');
}

function resumeDubbing() {
  state.paused = false;
  $('main-video').play();
  if (state.captureNode) state.captureNode.port.postMessage({ type: 'start' });
  if (state.mediaRecorder?.state === 'paused') state.mediaRecorder.resume();
  updateDubBtn('pause');
  showStatus(`🔴 Dublyaj — O'zbek tili`, 'active');
}

async function stopDubbing() {
  state.dubbing = false;
  state.paused = false;
  $('main-video').pause();

  if (state.gemini) {
    state.gemini.disconnect();
    state.gemini = null;
  }

  await stopRecording();
  cleanupAudio();

  updateDubBtn('start');
  $('stop-btn').disabled = true;
  showStatus('To\'xtatildi', 'ready');
}

function resetEditor() {
  if (state.dubbing) stopDubbing();
  cleanupAudio();
  state.recordedBlob = null;
  resetEditorUI();
}

/* ══════════════════════════════════════════════════════════
   AUDIO CONTEXT & PIPELINE
══════════════════════════════════════════════════════════ */
async function setupAudioContext() {
  // Agar context mavjud va yopilmagan bo'lsa — qayta ishlatamiz
  // (MediaElementSource bir contextga birikadi, yangi context olinsa xato)
  if (state.audioContext && state.audioContext.state !== 'closed') {
    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }
    // Yozib olish uchun yangi destination (stream yangi bo'lishi kerak)
    state.recordingDest = state.audioContext.createMediaStreamDestination();
    state.nextPlayTime = 0;
    console.log('[Audio] AudioContext qayta ishlatildi:', state.audioContext.state);
    return;
  }

  // Birinchi marta yoki yopilgan bo'lsa — yangi yaratamiz
  state.audioContext = new AudioContext({ sampleRate: 48000 });
  if (state.audioContext.state === 'suspended') {
    await state.audioContext.resume();
  }
  await state.audioContext.audioWorklet.addModule('audio-processor.js');
  state.nextPlayTime = 0;
  state.recordingDest = state.audioContext.createMediaStreamDestination();
  console.log('[Audio] Yangi AudioContext yaratildi:', state.audioContext.state);
}

/**
 * Dubbed audio (Int16 PCM, 24kHz) ni ijro etadi va yozib oladi.
 */
const MAX_AUDIO_LAG = 0.3; // 300ms — ko'proq lag bo'lsa reset

function playDubbedAudio(int16Buffer) {
  const ctx = state.audioContext;
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().then(() => playDubbedAudio(int16Buffer));
    return;
  }

  const int16 = new Int16Array(int16Buffer);
  if (int16.length === 0) return;

  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }

  const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
  audioBuffer.copyToChannel(float32, 0);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  if (state.recordingDest) source.connect(state.recordingDest);

  const bufferDuration = float32.length / 24000;
  const now = ctx.currentTime;

  // Agar nextPlayTime juda oldinda (>300ms lag) yoki orqada — reset
  if (state.nextPlayTime < now || state.nextPlayTime > now + MAX_AUDIO_LAG) {
    state.nextPlayTime = now + 0.05; // 50ms buffer
  }

  source.start(state.nextPlayTime);
  state.nextPlayTime += bufferDuration;
}

// MediaElementSourceNode faqat bir marta yaratiladi (bir context uchun)
let _cachedMediaSource = null;

function startAudioCapture() {
  const ctx = state.audioContext;
  const videoEl = $('main-video');
  videoEl.muted = false;

  // createMediaElementSource faqat BIR MARTA chaqirilishi mumkin!
  // Context o'zgarmaydi (suspend/resume), shuning uchun kesh ishlaydi
  if (!_cachedMediaSource) {
    _cachedMediaSource = ctx.createMediaElementSource(videoEl);
    console.log('[Audio] MediaElementSource yaratildi');
  }
  state.mediaSource = _cachedMediaSource;

  state.silentGain = ctx.createGain();
  state.silentGain.gain.value = 0;

  state.captureNode = new AudioWorkletNode(ctx, 'audio-capture-processor', {
    processorOptions: { inputSampleRate: ctx.sampleRate }
  });

  state.mediaSource.connect(state.captureNode);
  state.captureNode.connect(state.silentGain);
  state.silentGain.connect(ctx.destination);

  let chunkCount = 0;
  state.captureNode.port.onmessage = (e) => {
    if (e.data.type === 'pcm') {
      chunkCount++;
      if (state.gemini?.isConnected) {
        state.gemini.sendAudio(e.data.data);
      }
    }
  };

  state.captureNode.port.postMessage({ type: 'start' });
  console.log('[Audio] Capture pipeline ishga tushdi:', ctx.sampleRate);
}

function cleanupAudio() {
  if (state.captureNode) {
    state.captureNode.port.postMessage({ type: 'stop' });
    state.captureNode.disconnect();
    state.captureNode = null;
  }
  if (state.silentGain) { state.silentGain.disconnect(); state.silentGain = null; }
  if (state.mediaSource) {
    try { state.mediaSource.disconnect(); } catch (_) { }
    state.mediaSource = null; // state null, lekin _cachedMediaSource keshda qoladi
  }
  // AudioContext ni YOPMAYMIZ — faqat suspend qilamiz
  // Aks holda MediaElementSource qayta yaratib bo'lmaydi
  if (state.audioContext && state.audioContext.state !== 'closed') {
    state.audioContext.suspend().catch(() => { });
    // state.audioContext = null qilmaymiz!
  }
  state.nextPlayTime = 0;
  state.recordingDest = null;
  $('main-video').muted = false;
}

/* ══════════════════════════════════════════════════════════
   RECORDING (dubbed audio capture)
══════════════════════════════════════════════════════════ */
function startRecording() {
  if (!state.recordingDest) return;
  state.recordedChunks = [];

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  state.mediaRecorder = new MediaRecorder(state.recordingDest.stream, { mimeType });

  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.recordedChunks.push(e.data);
  };

  state.mediaRecorder.start(500); // 500ms chunks
  console.log('[Rec] Yozib olish boshlandi');
}

async function stopRecording() {
  if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') return;

  return new Promise(resolve => {
    state.mediaRecorder.onstop = async () => {
      if (state.recordedChunks.length === 0) { resolve(); return; }

      const blob = new Blob(state.recordedChunks, { type: 'audio/webm' });
      state.recordedBlob = blob;

      // Save to IndexedDB
      try {
        await saveBlob(`audio_${state.projectId}`, blob);
        await saveProject({
          id: state.projectId,
          name: state.projectName,
          createdAt: Date.now(),
          duration: $('main-video').duration || 0,
          hasVideo: !!state.videoBlob,
        });
        console.log('[DB] Loyiha saqlandi:', state.projectId);
        showDownloadBtn(true);
        showStatus('Saqlandi ✓ — yuklab olish mumkin', 'ready');
      } catch (e) {
        console.error('[DB] Saqlashda xato:', e);
        showDownloadBtn(true); // still allow download even if save failed
      }
      resolve();
    };
    state.mediaRecorder.stop();
  });
}

/* ══════════════════════════════════════════════════════════
   DOWNLOAD
══════════════════════════════════════════════════════════ */
async function downloadDubbedAudio() {
  if (!state.recordedBlob) {
    showError('Hali dublyaj audiosi yo\'q. Avval dublyaj qiling.');
    return;
  }

  const name = state.projectName || 'dubbed';
  const filename = `SADO_VOX_UZ_${name}`;
  $('download-btn').disabled = true;
  showStatus('Video tayyorlanmoqda...', 'loading');

  // Video + Audio merge (to'liq MP4)
  if (state.videoBlob) {
    try {
      showStatus('Video + Audio birlashtirilmoqda...', 'loading');
      const formData = new FormData();
      formData.append('video', state.videoBlob, 'original.mp4');
      formData.append('audio', state.recordedBlob, 'dubbed.webm');
      formData.append('name', filename);

      const resp = await fetch('/api/merge-video', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error(`Server xatosi: ${resp.status}`);

      const mp4Blob = await resp.blob();
      triggerDownload(URL.createObjectURL(mp4Blob), `${filename}.mp4`);
      showStatus('Video yuklab olindi ✓', 'ready');
      $('download-btn').disabled = false;
      return;

    } catch (err) {
      console.error('[Download] Merge xato — faqat audio:', err);
      // fallback quyida
    }
  }

  // Fallback: faqat audio → MP4
  try {
    showStatus('Audio MP4 ga o\'tkazilmoqda...', 'loading');
    const formData = new FormData();
    formData.append('audio', state.recordedBlob, 'dubbed.webm');
    formData.append('name', name);

    const resp = await fetch('/api/convert-audio', { method: 'POST', body: formData });
    if (!resp.ok) throw new Error(`Audio konvert xato: ${resp.status}`);

    const mp4Blob = await resp.blob();
    triggerDownload(URL.createObjectURL(mp4Blob), `${filename}_audio.mp4`);
    showStatus('Audio yuklab olindi ✓', 'ready');

  } catch (err2) {
    console.error('[Download] Audio convert xato — webm:', err2);
    triggerDownload(URL.createObjectURL(state.recordedBlob), `${filename}.webm`);
    showStatus('Yuklab olindi (webm) ✓', 'ready');
  } finally {
    $('download-btn').disabled = false;
  }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function showDownloadBtn(visible) {
  $('download-btn').classList.toggle('hidden', !visible);
}

/* ══════════════════════════════════════════════════════════
   CUSTOM CONFIRM DIALOG
══════════════════════════════════════════════════════════ */

/**
 * Custom styled confirm dialog.
 * @returns {Promise<boolean>} — true: tasdiqlandi, false: bekor qilindi
 */
function showConfirm(title, message) {
  return new Promise(resolve => {
    const overlay = $('confirm-overlay');
    const titleEl = $('confirm-title');
    const msgEl = $('confirm-msg');
    const okBtn = $('confirm-ok');
    const cancelBtn = $('confirm-cancel');

    titleEl.textContent = title || 'Tasdiqlang';
    msgEl.textContent = message || 'Davom etasizmi?';
    overlay.classList.remove('hidden');
    cancelBtn.focus();

    const cleanup = () => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(); resolve(false); }
      if (e.key === 'Enter') { cleanup(); resolve(true); }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);

    // Overlay tashqarisiga bosish — bekor qilish
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { cleanup(); resolve(false); }
    }, { once: true });
  });
}

/* ══════════════════════════════════════════════════════════
   AI EVENT HANDLERS
══════════════════════════════════════════════════════════ */
function attachAIListeners() {
  const g = state.gemini;

  g.addEventListener('connecting', () => showStatus('SADO VOX bilan ulanmoqda...', 'connecting'));

  g.addEventListener('ready', async () => {
    // Gemini TAYYOR — endi video boshlanadi
    showStatus(`🔴 Dublyaj — O'zbek tili`, 'active');
    showLatency('⚡ Dublyaj');
    updateDubBtn('pause');
    $('dub-btn').disabled = false;
    $('stop-btn').disabled = false;

    // Audio pipeline'ni yoqamiz
    startAudioCapture();
    startRecording();

    // Video FAQAT shu yerda boshlanadi — Gemini tayyor
    $('main-video').currentTime = 0;
    try {
      await $('main-video').play();
      console.log('[App] Video – Gemini ready da boshlandi');
    } catch (playErr) {
      console.warn('[App] Video play xato:', playErr);
    }
  });

  g.addEventListener('audio', (e) => {
    playDubbedAudio(e.detail.buffer);
  });

  g.addEventListener('inputTranscript', (e) => {
    state.inputTranscript = e.detail.text;
    updateTranscript($('input-transcript'), e.detail.text);
  });

  g.addEventListener('outputTranscript', (e) => {
    state.outputTranscript = e.detail.text;
    updateTranscript($('output-transcript'), e.detail.text);
  });

  g.addEventListener('error', (e) => {
    showError(`Xato: ${e.detail.message}`);
    showStatus('Xato yuz berdi', 'error');
    stopDubbing();
  });

  g.addEventListener('disconnected', () => {
    if (state.dubbing) showStatus('Ulanish uzildi', 'error');
  });
}

/* ─── Video Events ────────────────────────────────────────── */
function onVideoPlay() { if (state.dubbing && state.paused) resumeDubbing(); }
function onVideoPause() { if (state.dubbing && !state.paused) pauseDubbing(); }
function onVideoEnded() { stopDubbing(); showStatus('Video tugadi ✓', 'ready'); }
function onVideoSeeked() { state.nextPlayTime = 0; }

/* ══════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════ */
function showStatus(text, type = 'idle') {
  $('status-text').textContent = text;
  $('status-dot').className = `status-dot status-${type}`;
}

function showError(msg) {
  $('error-msg').textContent = msg;
  $('error-toast').classList.add('visible');
  setTimeout(() => $('error-toast').classList.remove('visible'), 5000);
}

function showLatency(val) {
  $('latency-badge').textContent = val;
  $('latency-badge').classList.remove('hidden');
}

function updateDubBtn(mode) {
  const icons = { start: '▶', pause: '⏸', resume: '▶' };
  const labels = { start: 'Dublyajni Boshlash', pause: 'Pauza', resume: 'Davom Ettirish' };
  $('dub-btn-icon').textContent = icons[mode];
  $('dub-btn-label').textContent = labels[mode];
}

function updateTranscript(el, text) {
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}


/* ══════════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════════ */
function generateId() {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(sec) {
  if (!sec || isNaN(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
