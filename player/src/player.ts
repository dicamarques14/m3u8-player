// The player page: a <movi-player> (https://github.com/mrujjwalg/movi-player) fed the m3u8
// playlist that the index page resolved. movi-player draws its own controls, keyboard,
// gestures and fullscreen; this module only mounts it and keeps the page's own parts
// (home / original link / share, and the ?t= position in the address bar) around it.
//
// Compiled by esbuild (npm run build:player) into player/player.js. The slim build is
// imported, so the engine's WASM is a separate file, copied next to this bundle as
// player/movi.wasm by the same script.
import 'movi-player/element/slim';

const container = document.getElementById('player-container')!;
const homeBtn = document.getElementById('home-btn') as HTMLAnchorElement;
const originalBtn = document.getElementById('original-btn') as HTMLButtonElement;
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const errorBox = document.getElementById('player-error')!;

const m3u8Url = CMP.parseM3u8FromHash();
if (!m3u8Url) {
    // Opened without a stream: nothing to play, back to the page that finds one.
    window.location.replace('../');
    throw new Error('player: no stream in the URL hash');
}

const startSeconds = CMP.startSecondsFromQuery();
const originalUrl = CMP.originalUrlFromQuery();

const el = document.createElement('movi-player');
// The slim build resolves movi.wasm itself only from its own import.meta.url; naming it
// here keeps that independent of how the bundle was produced or where it is served from.
// Relative to this bundle, so it also holds under a sub-path (GitHub Pages project site).
el.setAttribute('wasmurl', new URL('movi.wasm', import.meta.url).href);
el.setAttribute('src', m3u8Url);
el.setAttribute('controls', '');
el.setAttribute('autoplay', '');
el.setAttribute('theme', 'dark');
el.setAttribute('volume', '0.3');
// A source movi's own pipeline cannot open (or a browser without WebCodecs) is handed to the
// browser's <video> inside movi's controls, instead of a dead end.
el.setAttribute('fallback', 'native');
// The viewer can also choose the browser's <video> from the start (header button below).
const ENGINE_KEY = 'm3u8-engine';
function nativePreferred(): boolean {
    try {
        return localStorage.getItem(ENGINE_KEY) === 'native';
    } catch {
        return false;
    }
}
if (nativePreferred()) {
    el.setAttribute('engine', 'native');
}
// Arrow keys and double-tap in the left/right third seek +/-10s; no extra bar buttons.
el.setAttribute('fastseek', 'keys gestures');
if (startSeconds !== undefined) {
    el.setAttribute('startat', String(startSeconds));
}
container.appendChild(el);

// ---- address-bar position (?t=) and share ------------------------------------------------

// Only meaningful once the stream is open: before that currentTime says nothing.
let allowPlaybackUrlSync = false;
// Whatever is playing right now: movi-player, or the last-resort <video> below.
let activeMedia: { currentTime: number } = el;

function urlWithCurrentTime(): URL {
    const u = new URL(window.location.href);
    const param = CMP.formatTimeParam(activeMedia.currentTime);
    if (param !== null) {
        u.searchParams.set('t', param);
    } else {
        u.searchParams.delete('t');
    }
    return u;
}

function replaceUrlWithCurrentTime() {
    if (!allowPlaybackUrlSync) {
        return;
    }
    const u = urlWithCurrentTime();
    const next = u.pathname + u.search + u.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) {
        history.replaceState(null, '', next);
    }
}

el.addEventListener('loadedmetadata', () => {
    allowPlaybackUrlSync = true;
    // startat is the primary way to open mid-stream. If it did not take (the position is
    // clearly short of what was asked), seek there once the tracks are known.
    if (startSeconds !== undefined && el.currentTime < startSeconds - 1) {
        el.currentTime = startSeconds;
    }
});
el.addEventListener('pause', replaceUrlWithCurrentTime);

function showError(message: string) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}

// Last resort: a plain <video>, with hls.js where the browser has MSE but no native HLS.
// Only when movi-player failed before it ever opened the stream; an error once playing is
// not a reason to throw the viewer's position away.
let fellBack = false;
async function fallBackToPlainVideo() {
    if (fellBack) {
        return;
    }
    fellBack = true;
    el.remove();
    errorBox.style.display = 'none';

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.volume = 0.3;
    video.style.cssText = 'display:block;width:100%;height:100%;background:#000';
    container.appendChild(video);
    activeMedia = video;
    allowPlaybackUrlSync = false;

    video.addEventListener('loadedmetadata', () => {
        allowPlaybackUrlSync = true;
        if (startSeconds !== undefined) {
            video.currentTime = Number.isFinite(video.duration) && video.duration > 0
                ? Math.min(startSeconds, video.duration) : startSeconds;
        }
    }, { once: true });
    video.addEventListener('pause', replaceUrlWithCurrentTime);

    try {
        const { default: Hls } = await import('hls.js');
        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(m3u8Url!);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play(); });
            window.addEventListener('pagehide', (ev) => { if (!ev.persisted) hls.destroy(); });
            return;
        }
    } catch (err) {
        console.error('[player] hls.js failed to load', err);
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = m3u8Url!;
        return;
    }
    showError('This browser cannot play this stream.');
}

el.addEventListener('error', (e) => {
    console.error('[player] movi-player error', e);
    if (!allowPlaybackUrlSync) {
        void fallBackToPlainVideo();
        return;
    }
    showError('This stream could not be played. See the console for details.');
});

// No WebCodecs and no MSE: movi-player has nothing to run on, so skip straight to the
// last resort instead of waiting for an error that may never be reported.
if (!('VideoDecoder' in window) && !('MediaSource' in window) && !('ManagedMediaSource' in window)) {
    void fallBackToPlainVideo();
}

shareBtn.addEventListener('click', () => {
    replaceUrlWithCurrentTime();
    const shareUrl = urlWithCurrentTime().href;
    const at = CMP.formatTimeParam(activeMedia.currentTime) || '0';
    if (navigator.share) {
        navigator.share({ title: document.title, text: 'Video at ' + at + 's', url: shareUrl })
            .catch((err) => console.error('Error sharing', err));
    } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shareUrl)
            .then(() => alert('Link with timestamp copied to clipboard.'))
            .catch(() => prompt('Copy this link:', shareUrl));
    } else {
        prompt('Copy this link (includes current time):', shareUrl);
    }
});

// ---- header buttons ----------------------------------------------------------------------

// Switch between movi's own engine and the browser's <video>; reloads at the same position.
const engineBtn = document.getElementById('engine-btn') as HTMLButtonElement;
const native = nativePreferred();
engineBtn.classList.toggle('btn-light', native);
engineBtn.classList.toggle('btn-outline-light', !native);
engineBtn.title = native ? 'Using the browser video player (click for movi-player)'
    : 'Using movi-player (click for the browser video player)';
engineBtn.addEventListener('click', () => {
    try {
        if (native) {
            localStorage.removeItem(ENGINE_KEY);
        } else {
            localStorage.setItem(ENGINE_KEY, 'native');
        }
    } catch {
        /* storage blocked: the switch cannot be remembered */
    }
    replaceUrlWithCurrentTime();
    window.location.reload();
});

if (originalUrl) {
    originalBtn.style.display = '';
    originalBtn.addEventListener('click', () => window.open(originalUrl, '_blank'));
    // Home carries the source URL back, so the picker reopens on the same event /
    // competition instead of an empty box.
    homeBtn.href = '../?u=' + encodeURIComponent(originalUrl);
}
