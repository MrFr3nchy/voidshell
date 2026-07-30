/**
 * One AudioContext for the whole void.
 *
 * Browsers cap how many contexts a page may hold and refuse to start any of
 * them before a user gesture, so every app minting its own is both wasteful
 * and unreliable. This owns a single lazily-created context, created on the
 * first sound an app actually asks for — which, because sound is always
 * opt-in here, is always inside a click.
 *
 * Nothing in here is allowed to throw. Audio is a nicety; a blocked or absent
 * AudioContext must never take an app down with it.
 */

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
let broken = false;

function audio(): AudioContext | null {
  if (broken) return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) {
        broken = true;
        return null;
      }
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    broken = true;
    return null;
  }
}

function noise(a: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    const len = Math.floor(a.sampleRate * 0.08);
    noiseBuf = a.createBuffer(1, len, a.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

export interface BurstSpec {
  /** Centre frequency of the bandpass, Hz. */
  freq: number;
  /** Filter sharpness. Higher is more pitched, lower is more "thud". */
  q?: number;
  /** Peak gain, 0–1. Clamped to something civilised. */
  gain?: number;
  /** Seconds to silence. */
  decay?: number;
}

/** A filtered noise burst — impacts, clicks, pops, anything percussive. */
export function burst(spec: BurstSpec): void {
  const a = audio();
  if (!a) return;
  try {
    const src = a.createBufferSource();
    src.buffer = noise(a);
    const band = a.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = spec.freq;
    band.Q.value = spec.q ?? 3;
    const gain = a.createGain();
    const peak = Math.min(0.25, Math.max(0, spec.gain ?? 0.12));
    const decay = spec.decay ?? 0.05;
    gain.gain.setValueAtTime(peak, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + decay);
    src.connect(band).connect(gain).connect(a.destination);
    src.start();
    src.stop(a.currentTime + decay + 0.02);
  } catch {
    /* silence is an acceptable outcome */
  }
}

export interface ToneSpec {
  freq: number;
  /** Slide to this frequency over the decay. Gives a pop its "thoop". */
  toFreq?: number;
  gain?: number;
  decay?: number;
  wave?: OscillatorType;
}

/** A short pitched blip, optionally swept. */
export function tone(spec: ToneSpec): void {
  const a = audio();
  if (!a) return;
  try {
    const osc = a.createOscillator();
    osc.type = spec.wave ?? "sine";
    const decay = spec.decay ?? 0.09;
    osc.frequency.setValueAtTime(spec.freq, a.currentTime);
    if (spec.toFreq) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, spec.toFreq),
        a.currentTime + decay
      );
    }
    const gain = a.createGain();
    const peak = Math.min(0.25, Math.max(0, spec.gain ?? 0.1));
    gain.gain.setValueAtTime(peak, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + decay);
    osc.connect(gain).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + decay + 0.02);
  } catch {
    /* silence is an acceptable outcome */
  }
}
