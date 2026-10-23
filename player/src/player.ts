// The player page. Default: a plain <video> (hls.js where the browser has MSE but no native
// HLS) with YouTube-style gestures. Opt-in: <movi-player>
// (https://github.com/mrujjwalg/movi-player), switched on with the 🎞️ header button.
//
// Compiled by esbuild (npm run build:player) with code splitting: this file is
// player/player.js, and movi-player and hls.js are separate chunks loaded only when used.
// movi's WASM is a separate file too, copied to player/movi.wasm by the same script.
import type { MoviElement } from 'movi-player/element/slim';
import { buildDvr } from './dvr';

const container = document.getElementById('player-container')!;
const homeBtn = document.getElementById('home-btn') as HTMLAnchorElement;
const originalBtn = document.getElementById('original-btn') as HTMLButtonElement;
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const engineBtn = document.getElementById('engine-btn') as HTMLButtonElement;
const errorBox = document.getElementById('player-error')!;

const m3u8Url = CMP.parseM3u8FromHash();
if (!m3u8Url) {
    // Opened without a stream: nothing to play, back to the page that finds one.
    window.location.replace('../');
    throw new Error('player: no stream in the URL hash');
}

const startSeconds = CMP.startSecondsFromQuery();
const originalUrl = CMP.originalUrlFromQuery();
// A live stream opened at a wall-clock time (?at=): the playlist is rebuilt from there to now
// (dvr.ts) and played as a VOD. What is played, and where it starts, is settled in
// prepareSource() before a player is mounted.
const atEpoch = CMP.atEpochFromQuery();
let playUrl: string = m3u8Url;
let startOffset: number | undefined = startSeconds;
let dvrStartEpoch: number | undefined;

// ---- which player ------------------------------------------------------------------------

const ENGINE_KEY = 'm3u8-engine';
function moviPreferred(): boolean {
    try {
        return localStorage.getItem(ENGINE_KEY) === 'movi';
    } catch {
        return false;
    }
}
const useMovi = moviPreferred();

// ---- address-bar position (?t=) and share ------------------------------------------------

// Only meaningful once the stream is open: before that currentTime says nothing.
let allowPlaybackUrlSync = false;
// Whatever is playing right now.
let activeMedia: { currentTime: number } | null = null;

function urlWithCurrentTime(): URL {
    const u = new URL(window.location.href);
    const now = activeMedia ? activeMedia.currentTime : 0;
    if (dvrStartEpoch !== undefined) {
        // Playlist time means nothing after a reload; the wall-clock time does.
        u.searchParams.set('at', String(Math.round(dvrStartEpoch + now)));
        u.searchParams.delete('t');
        return u;
    }
    const param = CMP.formatTimeParam(now);
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

function showError(message: string) {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
}

// ---- the plain player: <video> + hls.js, with gestures -----------------------------------

const SEEK_GESTURE_SECONDS = 10;
const SEEK_KEY_SECONDS = 5;
// Height of the browser's own control bar, where a double-click is the viewer working the
// seek bar, not a gesture.
const NATIVE_BAR_PX = 56;

function makeFlash(side: 'back' | 'fwd', text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = 'seek-flash seek-flash-' + side;
    d.textContent = text;
    container.appendChild(d);
    return d;
}

function wirePlainGestures(video: HTMLVideoElement) {
    const flashes = { back: makeFlash('back', '⏪ 10s'), fwd: makeFlash('fwd', '10s ⏩') };
    const timers = { back: 0, fwd: 0 };

    function flash(side: 'back' | 'fwd') {
        const el = flashes[side];
        el.classList.remove('show');
        void el.offsetWidth; // restart the fade-out on a repeat tap
        el.classList.add('show');
        window.clearTimeout(timers[side]);
        timers[side] = window.setTimeout(() => el.classList.remove('show'), 500);
    }

    function seekBy(delta: number) {
        const next = video.currentTime + delta;
        const end = video.duration;
        video.currentTime = Number.isFinite(end) && end > 0
            ? Math.min(Math.max(next, 0), end) : Math.max(next, 0);
    }

    // Double-tap / double-click the left or right third. The browser's own click handling
    // (play/pause) runs for each of the two clicks and cancels itself out; the middle third
    // is left to the browser (its double-click is fullscreen).
    video.addEventListener('dblclick', (e) => {
        const rect = video.getBoundingClientRect();
        if (e.clientY > rect.bottom - NATIVE_BAR_PX) {
            return;
        }
        const frac = (e.clientX - rect.left) / rect.width;
        if (frac < 1 / 3) {
            seekBy(-SEEK_GESTURE_SECONDS);
            flash('back');
        } else if (frac > 2 / 3) {
            seekBy(SEEK_GESTURE_SECONDS);
            flash('fwd');
        }
    });

    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }
        switch (e.code) {
            case 'Space':
            case 'KeyK':
                void (video.paused ? video.play() : video.pause());
                break;
            case 'ArrowLeft':
                seekBy(-SEEK_KEY_SECONDS);
                break;
            case 'ArrowRight':
                seekBy(SEEK_KEY_SECONDS);
                break;
            case 'ArrowUp':
                video.volume = Math.min(1, video.volume + 0.1);
                break;
            case 'ArrowDown':
                video.volume = Math.max(0, video.volume - 0.1);
                break;
            case 'KeyF':
                if (document.fullscreenElement) {
                    void document.exitFullscreen();
                } else {
                    void video.requestFullscreen();
                }
                break;
            case 'KeyM':
                video.muted = !video.muted;
                break;
            default:
                return;
        }
        // Also stops the browser's own handling of the same key (it would seek twice).
        e.preventDefault();
    });
}

const MOVI_BUFFER_MB = 128;

let moviEl: MoviElement | null = null;

async function mountPlain() {
    if (moviEl) {
        moviEl.remove();
        moviEl = null;
    }

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.volume = 0.3;
    video.style.cssText = 'display:block;width:100%;height:100%;background:#000';
    container.appendChild(video);
    activeMedia = video;
    allowPlaybackUrlSync = false;
    wirePlainGestures(video);

    video.addEventListener('loadedmetadata', () => {
        allowPlaybackUrlSync = true;
        if (startOffset !== undefined) {
            video.currentTime = Number.isFinite(video.duration) && video.duration > 0
                ? Math.min(startOffset, video.duration) : startOffset;
        }
    }, { once: true });
    video.addEventListener('pause', replaceUrlWithCurrentTime);

    try {
        const { default: Hls } = await import('hls.js');
        if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource(playUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play(); });
            window.addEventListener('pagehide', (ev) => { if (!ev.persisted) hls.destroy(); });
            return;
        }
    } catch (err) {
        console.error('[player] hls.js failed to load', err);
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playUrl;
        return;
    }
    showError('This browser cannot play this stream.');
}

// ---- the opt-in player: movi-player ------------------------------------------------------

let fellBackFromMovi = false;
function fallBackFromMovi() {
    // Only when movi failed before it ever opened the stream; an error once playing is not a
    // reason to throw the viewer's position away.
    if (fellBackFromMovi) {
        return;
    }
    fellBackFromMovi = true;
    void mountPlain();
}

async function mountMovi() {
    // Loads the engine chunk (and registers <movi-player>) only now.
    await import('movi-player/element/slim');

    const el = document.createElement('movi-player') as MoviElement;
    moviEl = el;
    // The slim build resolves movi.wasm itself only from its own import.meta.url; naming it
    // here keeps that independent of how the bundle was produced or where it is served from.
    // Relative to this bundle, so it also holds under a sub-path (GitHub Pages project site).
    el.setAttribute('wasmurl', new URL('movi.wasm', import.meta.url).href);
    el.setAttribute('src', playUrl);
    el.setAttribute('controls', '');
    el.setAttribute('autoplay', '');
    el.setAttribute('theme', 'dark');
    el.setAttribute('volume', '0.3');
    // Prefetch window in MB. movi's default buffers much less ahead than hls.js does.
    el.setAttribute('buffersize', String(MOVI_BUFFER_MB));
    // Arrow keys and double-tap in the left/right third seek +/-10s; no extra bar buttons.
    el.setAttribute('fastseek', 'keys gestures');
    if (startOffset !== undefined) {
        el.setAttribute('startat', String(startOffset));
    }
    activeMedia = el;

    el.addEventListener('loadedmetadata', () => {
        allowPlaybackUrlSync = true;
        // startat is the primary way to open mid-stream. If it did not take (the position is
        // clearly short of what was asked), seek there once the tracks are known.
        if (startOffset !== undefined && el.currentTime < startOffset - 1) {
            el.currentTime = startOffset;
        }
    });
    el.addEventListener('pause', replaceUrlWithCurrentTime);
    el.addEventListener('error', (e) => {
        console.error('[player] movi-player error', e);
        if (!allowPlaybackUrlSync) {
            fallBackFromMovi();
            return;
        }
        showError('This stream could not be played. See the console for details.');
    });

    container.appendChild(el);
}

// ---- start -------------------------------------------------------------------------------

// No WebCodecs and no MSE: movi-player has nothing to run on.
const moviPossible = 'VideoDecoder' in window || 'MediaSource' in window || 'ManagedMediaSource' in window;

async function prepareSource() {
    if (atEpoch === undefined) {
        return;
    }
    try {
        const dvr = await buildDvr(m3u8Url!, atEpoch);
        playUrl = dvr.masterUrl;
        dvrStartEpoch = dvr.startEpoch;
        startOffset = Math.max(0, atEpoch - dvr.startEpoch);
    } catch (err) {
        // Not an archive-able stream (or the CDN refused): play it live rather than not at all.
        console.error('[player] could not rebuild the DVR', err);
        showError('Could not rewind this live stream; playing it live.');
    }
}

void prepareSource().then(() => {
    if (useMovi && moviPossible) {
        mountMovi().catch((err) => {
            console.error('[player] movi-player failed to load', err);
            fallBackFromMovi();
        });
    } else {
        void mountPlain();
    }
});

// ---- header buttons ----------------------------------------------------------------------

// Switch between the plain player and movi-player; reloads at the same position.
engineBtn.classList.toggle('btn-light', useMovi);
engineBtn.classList.toggle('btn-outline-light', !useMovi);
engineBtn.title = useMovi ? 'Using movi-player (click for the plain video player)'
    : 'Using the plain video player (click for movi-player)';
engineBtn.addEventListener('click', () => {
    try {
        if (useMovi) {
            localStorage.removeItem(ENGINE_KEY);
        } else {
            localStorage.setItem(ENGINE_KEY, 'movi');
        }
    } catch {
        /* storage blocked: the switch cannot be remembered */
    }
    replaceUrlWithCurrentTime();
    window.location.reload();
});

shareBtn.addEventListener('click', () => {
    replaceUrlWithCurrentTime();
    const shareUrl = urlWithCurrentTime().href;
    const at = CMP.formatTimeParam(activeMedia ? activeMedia.currentTime : 0) || '0';
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

if (originalUrl) {
    originalBtn.style.display = '';
    originalBtn.addEventListener('click', () => window.open(originalUrl, '_blank'));
    // Home carries the source URL back, so the picker reopens on the same event /
    // competition instead of an empty box.
    homeBtn.href = '../?u=' + encodeURIComponent(originalUrl);
}
