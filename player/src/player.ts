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
// Arrow keys and double-tap in the left/right third seek +/-10s; no extra bar buttons.
el.setAttribute('fastseek', 'keys gestures');
if (startSeconds !== undefined) {
    el.setAttribute('startat', String(startSeconds));
}
container.appendChild(el);

// ---- address-bar position (?t=) and share ------------------------------------------------

// Only meaningful once the stream is open: before that currentTime says nothing.
let allowPlaybackUrlSync = false;

function urlWithCurrentTime(): URL {
    const u = new URL(window.location.href);
    const param = CMP.formatTimeParam(el.currentTime);
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

el.addEventListener('error', (e) => {
    console.error('[player] movi-player error', e);
    errorBox.textContent = 'This stream could not be played. See the console for details.';
    errorBox.style.display = 'block';
});

shareBtn.addEventListener('click', () => {
    replaceUrlWithCurrentTime();
    const shareUrl = urlWithCurrentTime().href;
    const at = CMP.formatTimeParam(el.currentTime) || '0';
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

if (originalUrl) {
    originalBtn.style.display = '';
    originalBtn.addEventListener('click', () => window.open(originalUrl, '_blank'));
    // Home carries the source URL back, so the picker reopens on the same event /
    // competition instead of an empty box.
    homeBtn.href = '../?u=' + encodeURIComponent(originalUrl);
}
