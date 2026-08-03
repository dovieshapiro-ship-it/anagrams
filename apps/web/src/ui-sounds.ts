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
  if (!backgroundMusic) return;
  if (enabled) void playBackgroundMusic();
  else backgroundMusic.pause();
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

let backgroundMusic: HTMLAudioElement | undefined;

function getBackgroundMusic(): HTMLAudioElement {
  backgroundMusic ??= new Audio("/audio/playful-piano-atmos.ogg");
  backgroundMusic.loop = true;
  backgroundMusic.preload = "auto";
  backgroundMusic.volume = 0.32;
  return backgroundMusic;
}

async function playBackgroundMusic(): Promise<void> {
  if (!gameMusicEnabled()) return;
  try {
    await getBackgroundMusic().play();
  } catch {
    // Mobile browsers will retry after the first user gesture.
  }
}

export function startGameMusic(): () => void {
  void playBackgroundMusic();
  return () => {
    backgroundMusic?.pause();
  };
}

export function installButtonSounds(): () => void {
  const unlock = (): void => {
    void runningContext();
    void playBackgroundMusic();
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
