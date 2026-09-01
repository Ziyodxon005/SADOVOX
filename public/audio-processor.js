/**
 * VideoVoice — AudioWorklet Processors
 * 
 * AudioCaptureProcessor: Captures audio from video, downsamples to 16kHz PCM Int16
 * AudioPlaybackProcessor: Plays back 24kHz PCM data from Gemini Live Translate
 */

// ─────────────────────────────────────────────
// CAPTURE PROCESSOR (Video → Gemini input)
// Input: native sample rate (usually 44.1kHz or 48kHz)
// Output: 16kHz Int16 PCM chunks → sent via port message
// ─────────────────────────────────────────────
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._inputSampleRate = options.processorOptions?.inputSampleRate || 44100;
    this._targetSampleRate = 16000;
    this._ratio = this._inputSampleRate / this._targetSampleRate;
    this._buffer = [];
    this._frameCount = 0;
    // Send ~100ms worth of audio at a time
    this._chunkSize = Math.floor(this._targetSampleRate * 0.1);
    this._active = true;

    this.port.onmessage = (e) => {
      if (e.data.type === 'stop') {
        this._active = false;
      } else if (e.data.type === 'start') {
        this._active = true;
        this._buffer = [];
        this._frameCount = 0;
      }
    };
  }

  process(inputs) {
    if (!this._active) return true;

    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono channel

    // Simple linear downsampling
    for (let i = 0; i < channelData.length; i++) {
      const targetIdx = Math.floor(this._frameCount / this._ratio);
      const prevIdx = Math.floor((this._frameCount - 1) / this._ratio);
      if (targetIdx > prevIdx || this._frameCount === 0) {
        this._buffer.push(channelData[i]);
      }
      this._frameCount++;
    }

    // When we have enough samples, send them
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      // Convert float32 to int16 PCM
      const int16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage({ type: 'pcm', data: int16.buffer }, [int16.buffer]);
    }

    return true;
  }
}

// ─────────────────────────────────────────────
// PLAYBACK PROCESSOR (Gemini output → speakers)
// Input: 24kHz Int16 PCM from Gemini
// Output: AudioContext plays back in real-time
// ─────────────────────────────────────────────
class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._currentBuffer = null;
    this._currentOffset = 0;
    this._outputSampleRate = sampleRate; // AudioContext sample rate
    this._geminiSampleRate = 24000;
    this._ratio = this._geminiSampleRate / this._outputSampleRate;

    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm') {
        const int16 = new Int16Array(e.data.data);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768.0;
        }
        this._queue.push(float32);
      } else if (e.data.type === 'flush') {
        this._queue = [];
        this._currentBuffer = null;
        this._currentOffset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const out = output[0];
    let outIdx = 0;

    while (outIdx < out.length) {
      // Load next buffer from queue
      if (!this._currentBuffer || this._currentOffset >= this._currentBuffer.length) {
        if (this._queue.length === 0) {
          // No data — fill with silence
          out.fill(0, outIdx);
          break;
        }
        this._currentBuffer = this._queue.shift();
        this._currentOffset = 0;
      }

      // Upsample: map output sample position to Gemini sample position
      const geminiSamplePos = outIdx * this._ratio;
      const idx = Math.min(
        Math.floor(this._currentOffset + geminiSamplePos),
        this._currentBuffer.length - 1
      );

      out[outIdx] = this._currentBuffer[idx];
      outIdx++;

      // When we've consumed the entire Gemini buffer's portion
      if (Math.floor(this._currentOffset + outIdx * this._ratio) >= this._currentBuffer.length) {
        this._currentOffset = 0;
        this._currentBuffer = null;
        // Re-enter loop to grab next buffer
      }
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
registerProcessor('audio-playback-processor', AudioPlaybackProcessor);
