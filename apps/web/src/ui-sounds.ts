import * as Tone from "tone";

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

const SONG_CHORDS: readonly (readonly string[])[] = [
  ["C3", "G3", "B3", "D4", "E4"],
  ["A2", "E3", "G3", "C#4", "E4"],
  ["D3", "A3", "C4", "E4", "F4"],
  ["G2", "F3", "A3", "B3", "E4"],
  ["E3", "G3", "B3", "D4", "F#4"],
  ["A2", "E3", "G3", "C#4", "F#4"],
  ["D3", "A3", "C4", "E4", "F4"],
  ["G2", "F3", "A3", "B3", "E4"],
];

type ExpressiveNote = readonly [offset: number, note: string, velocity: number, duration: number];

const PIANO_PHRASES: readonly (readonly ExpressiveNote[])[] = [
  [[0, "E4", 0.58, 0.7], [0.42, "G4", 0.66, 0.68], [0.88, "B4", 0.6, 0.82], [1.5, "D5", 0.72, 0.72], [2.08, "C5", 0.57, 1.2]],
  [[0, "F4", 0.6, 0.72], [0.36, "A4", 0.68, 0.7], [0.92, "C5", 0.56, 0.9], [1.58, "E5", 0.73, 0.74], [2.2, "D5", 0.6, 1.22]],
  [[0, "G4", 0.59, 0.7], [0.48, "B4", 0.69, 0.68], [0.98, "D5", 0.58, 0.86], [1.62, "F#5", 0.74, 0.72], [2.24, "E5", 0.61, 1.26]],
  [[0, "A4", 0.68, 0.72], [0.42, "G4", 0.55, 0.68], [0.9, "F4", 0.64, 0.84], [1.5, "E4", 0.54, 0.76], [2.12, "D4", 0.7, 1.3]],
];

let pianoPromise: Promise<Tone.Sampler> | undefined;

function sampledPiano(): Promise<Tone.Sampler> {
  pianoPromise ??= new Promise<Tone.Sampler>((resolve) => {
    const sampler = new Tone.Sampler({
      urls: {
        C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3", A2: "A2.mp3",
        C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3", A3: "A3.mp3",
        C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
      },
      baseUrl: "/audio/salamander/",
      release: 2.4,
      volume: -7,
      onload: () => resolve(sampler),
    }).toDestination();
  });
  return pianoPromise;
}

function startSampledPianoSong(piano: Tone.Sampler): () => void {
  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.bpm.value = 72;
  const events: [number, { note: string; duration: number; velocity: number }][] = [];
  SONG_CHORDS.forEach((chord, chordIndex) => {
    chord.forEach((note, noteIndex) => {
      events.push([chordIndex * 5 + noteIndex * 0.055, {
        note,
        duration: 4.75,
        velocity: noteIndex === 0 ? 0.52 : 0.4,
      }]);
    });
  });
  PIANO_PHRASES.forEach((phrase, phraseIndex) => {
    phrase.forEach(([offset, note, velocity, duration]) => {
      events.push([2 + phraseIndex * 10 + offset, { note, duration, velocity }]);
    });
  });
  const part = new Tone.Part((time, event) => {
    piano.triggerAttackRelease(event.note, event.duration, time, event.velocity);
  }, events).start(0);
  part.loop = true;
  part.loopEnd = 40;
  transport.start("+0.08");
  return () => {
    part.dispose();
    transport.stop();
    transport.cancel();
    piano.releaseAll(Tone.now());
  };
}

export function startGameMusic(): () => void {
  if (!gameMusicEnabled()) return () => undefined;
  let cancelled = false;
  let stop = (): void => undefined;
  void Tone.start()
    .then(() => sampledPiano())
    .then((piano) => {
      if (!cancelled) stop = startSampledPianoSong(piano);
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    stop();
  };
}

export function installButtonSounds(): () => void {
  const unlock = (): void => {
    void runningContext();
    void Tone.start().catch(() => undefined);
    void sampledPiano().catch(() => undefined);
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
