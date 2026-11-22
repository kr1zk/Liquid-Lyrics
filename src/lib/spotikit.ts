// Spicetify adapter. Exposes the same small surface the rest of the code used
// from SpotiKit. Built on Spicetify.Platform (Spotify's own internal APIs),
// because on newer Spotify builds the Spicetify.Player / CosmosAsync wrappers
// are partly missing (Player.data, CosmosAsync, ReactDOM, Locale...).
export type PlayerEvent = "track" | "playpause" | "state" | "progress";

const sp = (): any => (window as any).Spicetify;
const P = (): any => sp()?.Platform;
const playerApi = (): any => P()?.PlayerAPI;
const playbackApi = (): any => P()?.PlaybackAPI;

function emitterOf(events: any): any {
  if (!events) return null;
  if (typeof events.addListener === "function") return events;
  if (typeof events._emitter?.addListener === "function") return events._emitter;
  return null;
}

function rawState(): any {
  const api = playerApi();
  try {
    return api?.getState?.() ?? api?._state ?? null;
  } catch {
    return api?._state ?? null;
  }
}

export const isSpotiKitReady = (): boolean => {
  const api = playerApi();
  return Boolean(api?.getState && api?.getEvents && P()?.AuthorizationAPI && document.body);
};

const REPEAT_TO_NUM: Record<string, number> = { off: 0, context: 1, track: 2 };
const NUM_TO_REPEAT = ["off", "context", "track"];

// ---- volume / mute cache (PlaybackAPI.getVolume is async) ----
let volumeCache = 0;
let volumeInit = false;
const volumeListeners = new Set<() => void>();

function muteHelper(): any {
  try {
    return playbackApi()?.getMuteHelper?.() ?? null;
  } catch {
    return null;
  }
}

function initVolume() {
  if (volumeInit) return;
  const api = playbackApi();
  if (!api) return;
  volumeInit = true;
  const refresh = () => {
    try {
      Promise.resolve(api.getVolume?.())
        .then((v: any) => {
          const n = Number(v);
          if (Number.isFinite(n)) volumeCache = n;
          volumeListeners.forEach((fn) => fn());
        })
        .catch(() => {});
    } catch {}
  };
  refresh();
  const emitter = emitterOf(api.getEvents?.());
  emitter?.addListener?.("volume", (event: any) => {
    const n = Number(event?.data?.volume ?? event?.volume);
    if (Number.isFinite(n)) {
      volumeCache = n;
      volumeListeners.forEach((fn) => fn());
    } else refresh();
  });
  emitter?.addListener?.("muted_changed", () => volumeListeners.forEach((fn) => fn()));
}

export function onVolumeChange(fn: () => void): () => void {
  initVolume();
  volumeListeners.add(fn);
  return () => volumeListeners.delete(fn);
}

// ---- liked state cache ----
const likedCache = new Map<string, boolean>();
let likedListening = false;

function readLiked(item: any): boolean {
  const uri = item?.uri;
  if (!uri) return false;
  if (likedCache.has(uri)) return likedCache.get(uri)!;
  const meta = item?.metadata?.["collection.in_collection"];
  const fromMeta = meta === true || meta === "true";
  likedCache.set(uri, fromMeta);
  try {
    Promise.resolve(P()?.LibraryAPI?.contains?.(uri))
      .then((res: any) => {
        const value = Array.isArray(res) ? Boolean(res[0]) : Boolean(res);
        likedCache.set(uri, value);
      })
      .catch(() => {});
  } catch {}
  if (!likedListening) {
    likedListening = true;
    try {
      const emitter = emitterOf(P()?.LibraryAPI?.getEvents?.());
      const clear = () => likedCache.clear();
      emitter?.addListener?.("operation_complete", clear);
      emitter?.addListener?.("update", clear);
    } catch {}
  }
  return fromMeta;
}

const playerFacade = {
  get track(): any {
    return rawState()?.item ?? null;
  },
  get position(): number {
    const s = rawState();
    if (!s) return 0;
    const base = Number(s.positionAsOfTimestamp) || 0;
    if (s.isPaused || s.isBuffering) return base;
    const ts = Number(s.timestamp) || Date.now();
    const speed = Number(s.speed) || 1;
    const pos = base + Math.max(0, Date.now() - ts) * speed;
    const dur = Number(s.duration) || 0;
    return dur > 0 ? Math.min(pos, dur) : pos;
  },
  get duration(): number {
    const s = rawState();
    return Number(s?.duration) || Number(s?.item?.duration?.milliseconds) || 0;
  },
  get state(): any {
    return rawState();
  },
  get isPlaying(): boolean {
    const s = rawState();
    return Boolean(s && s.item && !s.isPaused);
  },
  get shuffle(): boolean {
    return Boolean(rawState()?.shuffle);
  },
  get repeat(): string {
    return NUM_TO_REPEAT[Number(rawState()?.repeat)] ?? "off";
  },
  get liked(): boolean {
    return readLiked(rawState()?.item);
  },
  get volume(): number {
    initVolume();
    return volumeCache;
  },
  get muted(): boolean {
    const helper = muteHelper();
    try {
      return Boolean(helper?.isMuted?.() ?? helper?._isMuted);
    } catch {
      return false;
    }
  },
  seek(ms: number) {
    return playerApi()?.seekTo?.(Math.max(0, Math.round(ms)));
  },
  toggle() {
    const api = playerApi();
    return rawState()?.isPaused ? api?.resume?.() : api?.pause?.();
  },
  pause() {
    return playerApi()?.pause?.();
  },
  next() {
    return playerApi()?.skipToNext?.();
  },
  previous() {
    return playerApi()?.skipToPrevious?.();
  },
  setShuffle(value: boolean) {
    return playerApi()?.setShuffle?.(Boolean(value));
  },
  setRepeat(mode: string | number) {
    const value = typeof mode === "number" ? mode : (REPEAT_TO_NUM[mode] ?? 0);
    return playerApi()?.setRepeat?.(value);
  },
  setVolume(value: number) {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    volumeCache = v;
    return playbackApi()?.setVolume?.(v);
  },
  setMuted(value: boolean) {
    return muteHelper()?.setMuted?.(Boolean(value));
  },
};

// ---- player events ----
type Listener = (state?: any) => void;
const listeners: Record<PlayerEvent, Set<Listener>> = {
  track: new Set(),
  playpause: new Set(),
  state: new Set(),
  progress: new Set(),
};
let eventsStarted = false;
let lastUri = "";
let lastPaused: boolean | null = null;
let lastSig = "";

function fire(type: PlayerEvent, state: any) {
  for (const fn of Array.from(listeners[type])) {
    try {
      fn(state);
    } catch (e) {
      console.error("[Liquid Lyrics]", e);
    }
  }
}

function checkState() {
  const s = rawState();
  if (!s) return;
  const uri = String(s.item?.uri ?? "");
  const paused = Boolean(s.isPaused);
  const sig = `${uri}|${paused}|${s.shuffle}|${s.repeat}|${s.positionAsOfTimestamp}|${s.timestamp}|${s.item?.metadata?.["collection.in_collection"]}`;
  if (uri !== lastUri) {
    lastUri = uri;
    fire("track", s);
  }
  if (paused !== lastPaused) {
    lastPaused = paused;
    fire("playpause", s);
  }
  if (sig !== lastSig) {
    lastSig = sig;
    fire("state", s);
  }
}

function startEvents() {
  if (eventsStarted) return;
  eventsStarted = true;
  const s = rawState();
  lastUri = String(s?.item?.uri ?? "");
  lastPaused = s ? Boolean(s.isPaused) : null;
  try {
    const emitter = emitterOf(playerApi()?.getEvents?.());
    emitter?.addListener?.("update", () => checkState());
  } catch {}
  // Safety net in case the event emitter changes in a future Spotify build.
  setInterval(checkState, 500);
  setInterval(() => {
    if (listeners.progress.size) fire("progress", rawState());
  }, 250);
}

export const player = (): any => (playerApi() ? playerFacade : undefined);

export const platform = (): any => P();

// ---- HTTP: replaces SpotiKit.Http / Spicetify.CosmosAsync ----
function accessToken(): string {
  try {
    return String(P()?.AuthorizationAPI?.getState?.()?.token?.accessToken ?? "");
  } catch {
    return "";
  }
}

async function request(method: string, url: string, body?: any, headers?: Record<string, string>) {
  const cosmos = sp()?.CosmosAsync;
  const cosmosMethod = method === "DELETE" ? "del" : method.toLowerCase();
  if (cosmos && typeof cosmos[cosmosMethod] === "function") {
    return cosmos[cosmosMethod](url, body, headers);
  }
  if (url.startsWith("sp://oauth/v2/token")) {
    const state = P()?.AuthorizationAPI?.getState?.();
    return {
      accessToken: state?.token?.accessToken,
      expiresAtTime: state?.token?.accessTokenExpirationTimestampMs,
    };
  }
  if (url.startsWith("sp://") || url.startsWith("wg://")) throw new Error(`Unsupported URL: ${url}`);
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "app-platform": "WebPlayer",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const httpFacade = {
  get: (url: string, body?: any, headers?: any) => request("GET", url, body, headers),
  post: (url: string, body?: any, headers?: any) => request("POST", url, body, headers),
  put: (url: string, body?: any, headers?: any) => request("PUT", url, body, headers),
  del: (url: string, body?: any, headers?: any) => request("DELETE", url, body, headers),
};

export const http = (): any => httpFacade;

export function currentItem(): any {
  return rawState()?.item ?? null;
}

export function currentUri(): string {
  return String(currentItem()?.uri ?? "");
}

export function onPlayer(type: PlayerEvent, listener: (state?: any) => void): () => void {
  startEvents();
  listeners[type].add(listener);
  return () => listeners[type].delete(listener);
}

export function navigate(path: string): void {
  P()?.History?.push?.(path);
}

export function notify(message: string): void {
  const s = sp();
  try {
    if (typeof s?.showNotification === "function") return void s.showNotification(message);
    if (typeof s?.Snackbar?.enqueueSnackbar === "function") return void s.Snackbar.enqueueSnackbar(message);
  } catch {}
  console.log("[Liquid Lyrics]", message);
}

export function watchWindowControls(): void {
  // Spotify draws native window controls under Spicetify; nothing to sync.
  document.documentElement.classList.remove("ll-custom-window-controls");
}

export function windowControlsStrip(): { width: number; height: number } {
  return { width: 135, height: 64 };
}

export async function extractColors(uri: string): Promise<{ raw?: string; light?: string; dark?: string } | null> {
  try {
    const colors = await sp()?.colorExtractor?.(uri);
    if (!colors) return null;
    return {
      raw: colors.VIBRANT ?? colors.PROMINENT,
      light: colors.LIGHT_VIBRANT,
      dark: colors.DARK_VIBRANT,
    };
  } catch {
    return null;
  }
}

export function locale(): string {
  const s = sp();
  try {
    const value = s?.Locale?.getLocale?.() ?? s?.Platform?.Session?.locale;
    if (value) return String(value);
  } catch {}
  return navigator.language || "en";
}

export function addProfileMenuItem(label: string, icon: string, onSelect: () => void): void {
  // Spicetify.Menu.Item wraps the icon in its own <svg>, so pass only the inner markup.
  const inner = icon.replace(/^\s*<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
  const add = () => {
    try {
      const Menu = sp()?.Menu;
      if (!Menu?.Item) return false;
      new Menu.Item(label, false, () => onSelect(), inner).register();
      return true;
    } catch {
      return false;
    }
  };
  if (add()) return;
  const timer = setInterval(() => {
    if (add()) clearInterval(timer);
  }, 300);
  setTimeout(() => clearInterval(timer), 30000);
}
