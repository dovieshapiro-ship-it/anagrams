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

function pianoNote(audio: AudioContext, frequency: number, delay: number): void {
  tone(audio, {
    frequency,
    endFrequency: frequency * 0.995,
    duration: 0.24,
    delay,
    volume: 0.06,
    type: "triangle",
  });
  tone(audio, {
    frequency: frequency * 2,
    endFrequency: frequency * 1.99,
    duration: 0.16,
    delay,
    volume: 0.018,
    type: "sine",
  });
}

export function playWordSuccess(anagram: boolean): void {
  const audio = getContext();
  if (!audio) return;
  const notes = anagram
    ? [523.25, 659.25, 783.99, 1046.5, 1318.51]
    : [523.25, 659.25, 783.99];
  notes.forEach((frequency, index) => pianoNote(audio, frequency, index * 0.115));
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
