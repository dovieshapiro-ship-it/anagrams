type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | undefined {
  const candidate: unknown = Reflect.get(window, "AudioContext");
  return typeof candidate === "function"
    ? candidate as AudioContextConstructor
    : undefined;
}

let context: AudioContext | undefined;

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
  [[0.5, 554.37], [1.25, 659.25], [3, 587.33], [4.5, 493.88], [5.25, 554.37], [7, 440], [8.75, 493.88], [10.5, 587.33], [12.25, 554.37], [13.5, 659.25], [15, 493.88]],
  [[0.75, 659.25], [2.5, 554.37], [3.25, 493.88], [5, 587.33], [6.5, 659.25], [8.25, 554.37], [9.5, 440], [11, 493.88], [12.75, 587.33], [14.25, 554.37], [15.25, 440]],
];

const PIANO_SCALE_RUNS: readonly (readonly number[])[] = [
  [293.66, 329.63, 369.99, 415.3, 440, 493.88, 554.37, 659.25],
  [659.25, 587.33, 554.37, 493.88, 440, 369.99, 329.63, 293.66],
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
    if (cycleNumber % 2 === 1) {
      const run = PIANO_SCALE_RUNS[Math.floor(cycleNumber / 2) % PIANO_SCALE_RUNS.length] ?? [];
      run.forEach((frequency, index) => {
        const start = cycleStart + 6.4 + index * 0.19;
        schedulePianoNote(audio, master, frequency, start, 0.7, 0.018, "sine");
        schedulePianoNote(audio, master, frequency * 2, start, 0.48, 0.005, "triangle");
      });
    }
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
    if (button.closest(".rack")) playTileClick();
    else if (button.classList.contains("enter-button")) playEnterClick();
    else playButtonClick();
  };
  document.addEventListener("pointerdown", handlePointerDown, { capture: true });
  return () => document.removeEventListener("pointerdown", handlePointerDown, { capture: true });
}
