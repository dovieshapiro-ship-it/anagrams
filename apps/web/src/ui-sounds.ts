type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const browserAudio = window as unknown as Readonly<Record<string, unknown>>;
  const { AudioContext: standard, webkitAudioContext: apple } = browserAudio;
  const candidate = typeof standard === "function" ? standard : apple;
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
  if (context?.state === "closed") context = undefined;
  context ??= new Constructor();
  return context;
}

async function runningContext(): Promise<AudioContext | undefined> {
  const audio = getContext();
  if (!audio) return undefined;
  if (audio.state !== "running") {
    try {
      await audio.resume();
    } catch {
      return undefined;
    }
  }
  return audio.state === "running" ? audio : undefined;
}

function withRunningAudio(action: (audio: AudioContext) => void): void {
  void runningContext().then((audio) => {
    if (audio) action(audio);
  });
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
  withRunningAudio((audio) => tone(audio, {
    frequency: 680,
    endFrequency: 430,
    duration: 0.035,
    volume: 0.045,
    type: "triangle",
  }));
}

function playTileClick(): void {
  withRunningAudio((audio) => tone(audio, {
    frequency: 540,
    endFrequency: 760,
    duration: 0.045,
    volume: 0.055,
    type: "triangle",
  }));
}

function playEnterClick(): void {
  withRunningAudio((audio) => tone(audio, {
    frequency: 430,
    endFrequency: 290,
    duration: 0.065,
    volume: 0.065,
    type: "triangle",
  }));
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
  const notes = anagram
    ? [293.66, 369.99, 554.37]
    : [293.66, 369.99];
  withRunningAudio((audio) => {
    notes.forEach((frequency, index) => loungeNote(audio, frequency, index * 0.16));
  });
}

const SONG_CHORDS: readonly (readonly number[])[] = [
  [130.81, 196, 246.94, 293.66, 329.63],
  [110, 164.81, 207.65, 277.18, 311.13],
  [146.83, 220, 261.63, 329.63, 349.23],
  [98, 174.61, 220, 246.94, 329.63],
  [164.81, 196, 246.94, 293.66, 369.99],
  [110, 164.81, 207.65, 277.18, 329.63],
  [146.83, 220, 261.63, 329.63, 349.23],
  [98, 174.61, 220, 246.94, 329.63],
];

type ExpressiveNote = readonly [offset: number, frequency: number, volume: number, duration: number];

const ORGAN_PHRASES: readonly (readonly ExpressiveNote[])[] = [
  [[0, 329.63, 0.032, 0.9], [0.32, 392, 0.038, 0.82], [0.67, 493.88, 0.034, 1.04], [1.12, 587.33, 0.042, 0.94], [1.55, 523.25, 0.03, 1.3]],
  [[0, 349.23, 0.034, 0.88], [0.28, 440, 0.04, 0.9], [0.72, 523.25, 0.03, 1.1], [1.18, 659.25, 0.043, 0.96], [1.58, 587.33, 0.033, 1.34]],
  [[0, 392, 0.033, 0.9], [0.38, 493.88, 0.04, 0.84], [0.75, 587.33, 0.032, 1.02], [1.2, 739.99, 0.044, 0.94], [1.64, 659.25, 0.034, 1.32]],
  [[0, 440, 0.04, 0.92], [0.34, 392, 0.032, 0.86], [0.7, 349.23, 0.038, 1.02], [1.16, 329.63, 0.03, 0.92], [1.58, 293.66, 0.043, 1.38]],
];

function scheduleInstrumentNote(
  audio: AudioContext,
  destination: AudioNode,
  frequency: number,
  start: number,
  duration: number,
  volume: number,
  type: OscillatorType,
  character: "piano" | "organ",
): void {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + (character === "piano" ? 0.025 : 0.09));
  gain.gain.setValueAtTime(volume * (character === "piano" ? 0.42 : 0.88), start + Math.max(0.12, duration - 0.38));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function startScheduledGameMusic(audio: AudioContext): () => void {
  const master = audio.createGain();
  master.gain.setValueAtTime(0.88, audio.currentTime);
  master.connect(audio.destination);
  const cycleDuration = 40;
  const scheduleCycle = (cycleStart: number): void => {
    SONG_CHORDS.forEach((chord, chordIndex) => {
      const chordStart = cycleStart + chordIndex * 5;
      chord.forEach((frequency, noteIndex) => {
        scheduleInstrumentNote(
          audio,
          master,
          frequency,
          chordStart + noteIndex * 0.052,
          5.15,
          noteIndex === 0 ? 0.024 : 0.017,
          "triangle",
          "piano",
        );
        scheduleInstrumentNote(audio, master, frequency * 2, chordStart + noteIndex * 0.052, 3.9, 0.003, "sine", "piano");
      });
    });
    ORGAN_PHRASES.forEach((phrase, phraseIndex) => {
      phrase.forEach(([offset, frequency, volume, duration]) => {
        const start = cycleStart + 2 + phraseIndex * 10 + offset;
        scheduleInstrumentNote(audio, master, frequency, start, duration, volume, "sine", "organ");
        scheduleInstrumentNote(audio, master, frequency * 2, start, duration * 0.9, volume * 0.16, "square", "organ");
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

export function startGameMusic(): () => void {
  if (!gameMusicEnabled()) return () => undefined;
  let cancelled = false;
  let stop = (): void => undefined;
  void runningContext().then((audio) => {
    if (!audio || cancelled) return;
    stop = startScheduledGameMusic(audio);
  });
  return () => {
    cancelled = true;
    stop();
  };
}

export function installButtonSounds(): () => void {
  const unlock = (): void => {
    void runningContext();
  };
  const handlePointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    if (!soundEffectsEnabled()) return;
    if (button.closest(".rack")) playTileClick();
    else if (button.classList.contains("enter-button")) playEnterClick();
    else playButtonClick();
  };
  document.addEventListener("touchstart", unlock, { capture: true, passive: true });
  document.addEventListener("pointerdown", handlePointerDown, { capture: true });
  return () => {
    document.removeEventListener("touchstart", unlock, { capture: true });
    document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
  };
}
