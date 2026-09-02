/**
 * VideoVoice — Gemini 3.5 Live Translate WebSocket Wrapper
 *
 * Brauzer → Backend (/ws) → Gemini Live API
 * API key faqat backend server da — brauzer hech qachon ko'rmaydi.
 */

export class GeminiLiveTranslate extends EventTarget {
  /**
   * @param {string} targetLanguage - ISO language code e.g. 'uz', 'ru', 'en'
   */
  constructor(targetLanguage = 'uz') {
    super();
    this._targetLanguage = targetLanguage;
    this._ws = null;
    this._connected = false;
    this._sessionActive = false;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectTimeout = null;

    // Backend WebSocket proxy URL (API key server tomonida yashirilgan)
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this._wsUrl = `${protocol}//${location.host}/ws`;
  }

  // ─── Public API ──────────────────────────────────────────────

  /** Connect and initialize Gemini Live session */
  async connect() {
    return new Promise((resolve, reject) => {
      let connectionTimeout = setTimeout(() => {
        if (!this._sessionActive) {
          console.error('[GeminiLive] Connection timed out');
          this.disconnect();
          reject(new Error('Connection timed out'));
        }
      }, 10000);

      try {
        this._ws = new WebSocket(this._wsUrl);
        this._ws.binaryType = 'arraybuffer';

        this._ws.onopen = () => {
          console.log('[GeminiLive] WebSocket opened');
          this._connected = true;
          this._reconnectAttempts = 0;
          this._sendSetup();
          this.dispatchEvent(new CustomEvent('connecting'));
        };

        this._ws.onmessage = (event) => {
          this._handleMessage(event.data, resolve, connectionTimeout);
        };

        this._ws.onerror = (err) => {
          console.error('[GeminiLive] WebSocket error:', err);
          this.dispatchEvent(new CustomEvent('error', { detail: { message: 'WebSocket connection error' } }));
          clearTimeout(connectionTimeout);
          reject(err);
        };

        this._ws.onclose = (event) => {
          console.log('[GeminiLive] WebSocket closed', event.code, event.reason);
          if (!this._sessionActive) {
            reject(new Error(`WebSocket closed before setup: ${event.reason}`));
          }
          this._connected = false;
          this._sessionActive = false;
          clearTimeout(connectionTimeout);
          this.dispatchEvent(new CustomEvent('disconnected', {
            detail: { code: event.code, reason: event.reason }
          }));
        };

      } catch (err) {
        clearTimeout(connectionTimeout);
        reject(err);
      }
    });
  }

  /** Send a raw PCM Int16 audio chunk (ArrayBuffer) */
  sendAudio(int16Buffer) {
    if (!this._connected || !this._sessionActive) return;
    if (this._ws.readyState !== WebSocket.OPEN) return;

    const base64 = this._arrayBufferToBase64(int16Buffer);
    const msg = {
      realtimeInput: {
        audio: {
          data: base64,
          mimeType: 'audio/pcm;rate=16000'
        }
      }
    };
    this._ws.send(JSON.stringify(msg));
  }

  /** Disconnect and clean up */
  disconnect() {
    this._sessionActive = false;
    this._connected = false;
    if (this._ws) {
      this._ws.close(1000, 'User stopped dubbing');
      this._ws = null;
    }
    this.dispatchEvent(new CustomEvent('disconnected', { detail: { code: 1000, reason: 'User stopped' } }));
  }

  get isConnected() {
    return this._connected && this._sessionActive;
  }

  // ─── Private Methods ─────────────────────────────────────────

  _sendSetup() {
    const langNames = {
      'uz': "Uzbek (O'zbek tili)",
      'ru': 'Russian (Русский)',
      'en': 'English',
      'tr': 'Turkish (Türkçe)',
      'ar': 'Arabic (العربية)',
      'zh': 'Chinese (中文)',
      'de': 'German (Deutsch)',
      'fr': 'French (Français)',
      'es': 'Spanish (Español)',
      'ja': 'Japanese (日本語)',
      'ko': 'Korean (한국어)',
    };
    const targetLangName = langNames[this._targetLanguage] || this._targetLanguage;

    const setupMsg = {
      setup: {
        model: 'models/gemini-3.5-live-translate-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' }
            }
          }
        },
        systemInstruction: {
          parts: [{
            text: `You are an elite real-time voice dubbing interpreter. Your sole task is to listen to the incoming audio and immediately speak a natural, fluent translation in ${targetLangName}.

CRITICAL RULES — follow all of them without exception:
1. TONE & EMOTION: Mirror the original speaker's tone, emotion, energy and mood exactly — if they are excited, be excited; if calm, be calm; if angry, be angry; if whispering, whisper.
2. PACING & RHYTHM: Match the original speaker's speaking speed and rhythm as closely as possible. Do not rush or slow down artificially.
3. PURE LANGUAGE: Speak in completely pure, native ${targetLangName} with zero foreign accent, zero loanword pronunciation errors, and zero hesitation sounds. Every word must sound like a native speaker.
4. NO ADDITIONS: Never add commentary, explanations, greetings, filler words, or any extra content not present in the original audio.
5. COMPLETENESS: Translate every single word — do not skip, summarize, or paraphrase.
6. NATURALNESS: Use natural, conversational ${targetLangName} — not literal word-for-word translation. Adapt idioms and expressions to sound natural.
7. CONTINUITY: Maintain smooth, uninterrupted speech flow matching the original.`
          }]
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
    console.log('[GeminiLive] Setup yuborildi (model:', setupMsg.setup.model, ', til:', targetLangName, ')');
    this._ws.send(JSON.stringify(setupMsg));
  }

  _handleMessage(rawData, connectResolve, connectionTimeout) {
    let msg;
    try {
      if (typeof rawData === 'string') {
        msg = JSON.parse(rawData);
      } else {
        msg = JSON.parse(new TextDecoder().decode(rawData));
      }
    } catch (e) {
      console.warn('[GeminiLive] Failed to parse message:', e);
      return;
    }

    // Setup complete
    if (msg.setupComplete) {
      console.log('[GeminiLive] Setup complete');
      this._sessionActive = true;
      clearTimeout(connectionTimeout);
      this.dispatchEvent(new CustomEvent('ready'));
      if (connectResolve) connectResolve();
      return;
    }

    // Audio response chunk
    if (msg.serverContent) {
      const content = msg.serverContent;

      // Dubbed audio data
      if (content.modelTurn?.parts) {
        for (const part of content.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            const base64Audio = part.inlineData.data;
            const audioBuffer = this._base64ToArrayBuffer(base64Audio);
            this.dispatchEvent(new CustomEvent('audio', { detail: { buffer: audioBuffer } }));
          }
        }
      }

      // Input transcription (original language)
      if (content.inputTranscription?.text) {
        this.dispatchEvent(new CustomEvent('inputTranscript', {
          detail: { text: content.inputTranscription.text }
        }));
      }

      // Output transcription (Uzbek)
      if (content.outputTranscription?.text) {
        this.dispatchEvent(new CustomEvent('outputTranscript', {
          detail: { text: content.outputTranscription.text }
        }));
      }

      // Turn complete
      if (content.turnComplete) {
        this.dispatchEvent(new CustomEvent('turnComplete'));
      }
    }

    // Interruption
    if (msg.serverContent?.interrupted) {
      this.dispatchEvent(new CustomEvent('interrupted'));
    }

    // Error from server
    if (msg.error) {
      console.error('[GeminiLive] Server error:', msg.error);
      this.dispatchEvent(new CustomEvent('error', {
        detail: { message: msg.error.message || 'Unknown API error', code: msg.error.code }
      }));
    }
  }

  /** Convert ArrayBuffer to base64 string */
  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /** Convert base64 string to ArrayBuffer */
  _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
