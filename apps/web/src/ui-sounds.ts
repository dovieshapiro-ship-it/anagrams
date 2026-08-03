type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const candidate: unknown = Reflect.get(window, "AudioContext");
  return typeof candidate === "function"
    ? candidate as AudioContextConstructor
    : undefined;
}

let context: AudioContext | undefined;
const MUSIC_PREFERENCE = "anagrams:music-enabled";
const SOUND_PREFERENCE = "anagrams:sound-enabled";

function preference(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function savePreference(key: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(key, String(enabled));
  } catch {
    // The setting still applies for the current React session if storage is unavailable.
  }
}

export function gameMusicEnabled(): boolean {
  return preference(MUSIC_PREFERENCE);
}

export function soundEffectsEnabled(): boolean {
  return preference(SOUND_PREFERENCE);
}

export function setGameMusicEnabled(enabled: boolean): void {
  savePreference(MUSIC_PREFERENCE, enabled);
}

export function setSoundEffectsEnabled(enabled: boolean): void {
  savePreference(SOUND_PREFERENCE, enabled);
}

function getContext(): AudioContext | undefined {
  const Constructor = audioContextConstructor();
  if (!Constructor) return undefined;
  context ??= new Constructor();
  if (context.state === "suspended") void context.resume();
  return context;
}

function tone(
  audio: AudioContext,
  options: {
    readonly frequency: number;
    readonly endFrequency: number;
    readonly duration: number;
    readonly delay?: number;
    readonly volume: number;
    readonly type: OscillatorType;
  },
): void {
  const now = audio.currentTime + (options.delay ?? 0);
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = options.type;
  oscillator.frequency.setValueAtTime(options.frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, now + options.duration);
  gain.gain.setValueAtTime(options.volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(now);
  oscillator.stop(now + options.duration);
}

function playButtonClick(): void {
  const audio = getContext();
  if (!audio) return;
  tone(audio, {
    frequency: 680,
    endFrequency: 430,
    duration: 0.035,
    volume: 0.045,
    type: "triangle",
  });
}

function playTileClick(): void {
  const audio = getContext();
  if (!audio) return;
  tone(audio, {
    frequency: 540,
    endFrequency: 760,
    duration: 0.045,
    volume: 0.055,
    type: "triangle",
  });
}

function playEnterClick(): void {
  const audio = getContext();
  if (!audio) return;
  tone(audio, {
    frequency: 430,
    endFrequency: 290,
    duration: 0.065,
    volume: 0.065,
    type: "triangle",
  });
}

function loungeNote(audio: AudioContext, frequency: number, delay: number): void {
  tone(audio, {
    frequency,
    endFrequency: frequency * 0.985,
    duration: 0.32,
    delay,
    volume: 0.048,
    type: "sine",
  });
  tone(audio, {
    frequency: frequency * 1.5,
    endFrequency: frequency * 1.48,
    duration: 0.2,
    delay,
    volume: 0.014,
    type: "triangle",
  });
}

export function playWordSuccess(anagram: boolean): void {
  if (!soundEffectsEnabled()) return;
  const audio = getContext();
  if (!audio) return;
  const notes = anagram
    ? [293.66, 369.99, 554.37]
    : [293.66, 369.99];
  notes.forEach((frequency, index) => loungeNote(audio, frequency, index * 0.16));
}

const JAZZ_CHORDS: readonly (readonly number[])[] = [
  [220, 277.18, 329.63, 415.3],
  [246.94, 311.13, 369.99, 440],
  [164.81, 196, 246.94, 293.66],
  [220, 261.63, 329.63, 392],
  [185, 220, 277.18, 329.63],
  [246.94, 311.13, 369.99, 440],
  [164.81, 196, 246.94, 293.66],
  [220, 261.63, 311.13, 392],
];

const JAZZ_MELODIES: readonly (readonly [number, number][])[] = [
  [[0.5, 554.37], [1.25, 659.25], [3, 622.25], [4.5, 392], [5.25, 493.88], [7, 554.37], [8.75, 440], [10.5, 369.99], [12.25, 392], [13.5, 493.88], [15, 554.37]],
  [[0.75, 659.25], [2.5, 739.99], [3.25, 622.25], [5, 493.88], [6.5, 659.25], [8.25, 554.37], [9.5, 440], [11, 493.88], [12.75, 587.33], [14.25, 659.25], [15.25, 554.37]],
];

type ExpressiveNote = readonly [offset: number, frequency: number, volume: number, duration: number];

const PIANO_SCALE_RUNS: readonly (readonly ExpressiveNote[])[] = [
  [[0, 246.94, 0.015, 0.76], [0.14, 277.18, 0.017, 0.72], [0.3, 311.13, 0.021, 0.78], [0.49, 329.63, 0.016, 0.7], [0.68, 369.99, 0.023, 0.82], [0.84, 415.3, 0.017, 0.7], [1.04, 440, 0.02, 0.76], [1.31, 493.88, 0.026, 1.02]],
  [[0, 220, 0.017, 0.74], [0.18, 246.94, 0.02, 0.78], [0.34, 277.18, 0.016, 0.68], [0.56, 293.66, 0.023, 0.82], [0.73, 329.63, 0.018, 0.7], [0.91, 369.99, 0.022, 0.78], [1.14, 392, 0.017, 0.72], [1.38, 440, 0.026, 1.04]],
  [[0, 493.88, 0.024, 0.9], [0.23, 440, 0.018, 0.72], [0.4, 415.3, 0.021, 0.78], [0.61, 369.99, 0.017, 0.68], [0.79, 311.13, 0.024, 0.84], [1.02, 277.18, 0.017, 0.72], [1.18, 246.94, 0.022, 0.8], [1.45, 233.08, 0.026, 1.06]],
  [[0, 659.25, 0.024, 0.88], [0.21, 554.37, 0.018, 0.72], [0.39, 493.88, 0.021, 0.78], [0.57, 392, 0.017, 0.7], [0.81, 369.99, 0.024, 0.84], [0.97, 329.63, 0.018, 0.72], [1.2, 293.66, 0.022, 0.8], [1.48, 277.18, 0.027, 1.08]],
];

function schedulePianoNote(
  audio: AudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType,
): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.11);
  gain.gain.setValueAtTime(volume * 0.72, start + Math.max(0.12, duration - 0.38));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function startGameMusic(): () => void {
  if (!gameMusicEnabled()) return () => undefined;
  const audio = getContext();
  if (!audio) return () => undefined;
  const master = audio.createGain();
  master.gain.setValueAtTime(0.6, audio.currentTime);
  master.connect(audio.destination);
  const cycleDuration = 16;
  let variation = 0;
  const scheduleCycle = (cycleStart: number): void => {
    JAZZ_CHORDS.forEach((chord, chordIndex) => {
      const chordStart = cycleStart + chordIndex * 2;
      chord.forEach((frequency, noteIndex) => {
        schedulePianoNote(
          audio,
          master,
          frequency,
          chordStart + noteIndex * 0.045,
          2.22,
          0.009,
          "sine",
        );
        schedulePianoNote(audio, master, frequency * 2, chordStart + noteIndex * 0.045, 1.7, 0.0025, "triangle");
      });
    });
    const cycleNumber = variation;
    const melody = JAZZ_MELODIES[cycleNumber % JAZZ_MELODIES.length] ?? [];
    variation += 1;
    melody.forEach(([offset, frequency]) => {
      schedulePianoNote(audio, master, frequency, cycleStart + offset, 0.92, 0.012, "sine");
      schedulePianoNote(audio, master, frequency * 2, cycleStart + offset, 0.68, 0.003, "triangle");
    });
    PIANO_SCALE_RUNS.forEach((run, runIndex) => {
      run.forEach(([offset, frequency, volume, duration]) => {
        const start = cycleStart + 2 + runIndex * 4 + offset;
        schedulePianoNote(audio, master, frequency, start, duration, volume, "sine");
        schedulePianoNote(audio, master, frequency * 2, start, duration * 0.7, volume * 0.26, "triangle");
      });
    });
  };
  let nextCycle = audio.currentTime + 0.08;
  scheduleCycle(nextCycle);
  nextCycle += cycleDuration;
  const scheduler = window.setInterval(() => {
    while (nextCycle < audio.currentTime + cycleDuration) {
      scheduleCycle(nextCycle);
      nextCycle += cycleDuration;
    }
  }, 2_000);
  return () => {
    window.clearInterval(scheduler);
    master.gain.cancelScheduledValues(audio.currentTime);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), audio.currentTime);
    master.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
    window.setTimeout(() => master.disconnect(), 150);
  };
}

export function installButtonSounds(): () => void {
  const handlePointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    if (!soundEffectsEnabled()) return;
    if (button.closest(".rack")) playTileClick();
    else if (button.classList.contains("enter-button")) playEnterClick();
    else playButtonClick();
  };
  document.addEventListener("pointerdown", handlePointerDown, { capture: true });
  return () => document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
}
