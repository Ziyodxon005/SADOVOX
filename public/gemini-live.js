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

    // WS URL serverless API dan olinadi (/api/get-ws-url)
    this._wsUrl = null;
    this._rotating = false;
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Serverdan Gemini WS URL olish
   * @param {boolean} rotate - true bo'lsa keyingi kalitga o'tadi
   */
  async _fetchWsUrl(rotate = false) {
    const url = `/api/get-ws-url${rotate ? '?rotate=true' : ''}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'WS URL olishda xato' }));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    console.log(`[GeminiLive] WS URL olindi (kalit #${data.keyIndex}/${data.totalKeys})`);
    return data.url;
  }

  /** Connect and initialize Gemini Live session */
  async connect() {
    // Avval WS URL ni serverdan olamiz
    this._wsUrl = await this._fetchWsUrl(false);

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
              prebuiltVoiceConfig: { voiceName: 'Aoede' }
            }
          }
        },
        systemInstruction: {
          parts: [{
            text: `You are a professional real-time interpreter. Your only job is to listen to the audio and speak a fluent, natural translation in ${targetLangName}. Translate everything you hear immediately. Do not add commentary, explanations, or any extra text. Preserve the speaker's tone and pacing as closely as possible.`
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
      const code = msg.error.code || msg.error.status || '';
      const isQuota = code === 429 || code === 503 ||
        String(code).includes('RESOURCE_EXHAUSTED') ||
        String(code).includes('QUOTA');

      if (isQuota && !this._rotating) {
        console.warn('[GeminiLive] Quota xatosi — kalit almashtirilmoqda...');
        this._rotating = true;
        this._fetchWsUrl(true).then(newUrl => {
          this._wsUrl = newUrl;
          this._ws.close(1000, 'key_rotate');
          // Yangi key bilan qayta ulanish
          this._rotating = false;
          this._connected = false;
          this._sessionActive = false;
          this.connect().catch(err => {
            this.dispatchEvent(new CustomEvent('error', {
              detail: { message: 'Kalit almashtirishda xato: ' + err.message }
            }));
          });
        }).catch(() => {
          this._rotating = false;
          this.dispatchEvent(new CustomEvent('error', {
            detail: { message: 'Barcha API kalitlar limitda', code: 503 }
          }));
        });
        return;
      }

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
