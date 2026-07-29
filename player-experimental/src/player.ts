// Playback engine + control UI ported from mediabunny's own reference player
// (github.com/Vanilagy/mediabunny/tree/main/examples/media-player), adapted from its
// file-picker/drag-drop demo onto our "one URL from the link hash" use case, and restyled
// from Tailwind onto the plain CSS in index.html (no build step available at deploy time,
// so this file is compiled locally with `npm run build:experimental` and the *output*
// player.js is what's committed and served).
import {
    ALL_FORMATS,
    AudioBufferSink,
    CanvasSink,
    Input,
    type InputAudioTrack,
    type InputVideoTrack,
    UrlSource,
    type WrappedAudioBuffer,
    type WrappedCanvas,
} from 'mediabunny';

type AnyTrack = InputVideoTrack | InputAudioTrack;

const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;
const context = canvas.getContext('2d')!;
const playerContainer = document.querySelector<HTMLDivElement>('#player-container')!;
const loadBtn = document.querySelector<HTMLButtonElement>('#load-btn')!;
const statusOverlay = document.querySelector<HTMLDivElement>('#status-overlay')!;
const controlsElement = document.querySelector<HTMLDivElement>('#controls')!;
const playPauseBtn = document.querySelector<HTMLButtonElement>('#play-pause-btn')!;
const volumeBtn = document.querySelector<HTMLButtonElement>('#volume-btn')!;
const volumeBarContainer = document.querySelector<HTMLDivElement>('#volume-bar-container')!;
const volumeBar = document.querySelector<HTMLDivElement>('#volume-bar')!;
const currentTimeEl = document.querySelector<HTMLSpanElement>('#current-time')!;
const durationEl = document.querySelector<HTMLSpanElement>('#duration-time')!;
const progressBarContainer = document.querySelector<HTMLDivElement>('#progress-bar-container')!;
const progressBar = document.querySelector<HTMLDivElement>('#progress-bar')!;
const liveDot = document.querySelector<HTMLButtonElement>('#live-dot')!;
const fullscreenBtn = document.querySelector<HTMLButtonElement>('#fullscreen-btn')!;
const homeBtn = document.querySelector<HTMLAnchorElement>('#home-btn')!;
const originalBtn = document.querySelector<HTMLButtonElement>('#original-btn')!;
const shareBtn = document.querySelector<HTMLButtonElement>('#share-btn')!;

function setStatus(msg: string) {
    console.log('[experimental-player]', msg);
    statusOverlay.textContent = msg;
    statusOverlay.style.display = '';
}

function appendStatus(msg: string) {
    console.log('[experimental-player]', msg);
    statusOverlay.textContent += '\n' + msg;
    statusOverlay.style.display = '';
}

// --- Player state ---
// AudioContext's clock is the single source of truth for both audio scheduling and video frame
// pacing; play/pause/seek all just move playbackTimeAtStart and restart the relevant iterator.
let audioContext: AudioContext | null = null;
let gainNode: GainNode | null = null;

let fileLoaded = false;
let videoSink: CanvasSink | null = null;
let audioSink: AudioBufferSink | null = null;

let firstTimestamp = 0;
let endTimestamp = 0;
let isRelativeToUnixEpoch = false;
let audioContextStartTime: number | null = null;
let playing = false;
let playbackTimeAtStart = 0;
// Guards replaceUrlWithCurrentTime(): only meaningful (and only correct — firstTimestamp is set)
// once a stream has actually loaded.
let allowPlaybackUrlSync = false;

let videoFrameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
let audioBufferIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | null = null;
let nextFrame: WrappedCanvas | null = null;
const queuedAudioNodes = new Set<AudioBufferSourceNode>();

// Incremented on every seek/reload so stale in-flight async work from before it is discarded.
let asyncId = 0;

let liveRefreshTimeoutId = -1;

let draggingProgressBar = false;
let volume = 0.7;
let draggingVolumeBar = false;
let volumeMuted = false;

// --- Init ---

async function initPlayer(m3u8Url: string, startSeconds: number | undefined) {
    setStatus('Opening input via WebCodecs/mediabunny…\n' + m3u8Url);

    videoFrameIterator?.return();
    audioBufferIterator?.return();
    asyncId++;
    fileLoaded = false;
    liveDot.style.display = 'none';
    window.clearTimeout(liveRefreshTimeoutId);

    const input = new Input({ source: new UrlSource(m3u8Url), formats: ALL_FORMATS });

    let videoTrack = await input.getPrimaryVideoTrack();
    let audioTrack = await input.getPrimaryAudioTrack();
    const tracks = [videoTrack, audioTrack].filter((t): t is NonNullable<typeof t> => t !== null);

    if (!tracks.length) {
        appendStatus('No audio or video track found in this stream.');
        return;
    }

    // Streams (especially HLS) commonly don't start at timestamp 0 (encoder offsets, PTS
    // discontinuities); anchoring to 0 made playback wait "frozen" until real time caught up.
    firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    // skipLiveWait returns the best-known extent immediately instead of hanging for a live/growing
    // stream, so this also gives a (growing) seek range for clipmyhorse's live streams.
    endTimestamp = (await input.getDurationFromMetadata(tracks, { skipLiveWait: true }))
        ?? (await input.computeDuration(tracks, { skipLiveWait: true })) ?? 0;
    isRelativeToUnixEpoch = (await Promise.all(tracks.map(t => t.isRelativeToUnixEpoch()))).some(Boolean);
    playbackTimeAtStart = firstTimestamp + (startSeconds || 0);
    durationEl.textContent = formatTimestamp(endTimestamp);

    let problem = '';
    if (videoTrack && !(await videoTrack.canDecode())) {
        problem += 'Unable to decode the video track. ';
        videoTrack = null;
    }
    if (audioTrack && !(await audioTrack.canDecode())) {
        problem += 'Unable to decode the audio track. ';
        audioTrack = null;
    }
    if (!videoTrack && !audioTrack) {
        appendStatus(problem || 'Neither track could be decoded.');
        return;
    }
    if (problem) {
        appendStatus(problem);
    }

    const AudioContextCtor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // Must match the track's sample rate for correct results, especially on low-sample-rate audio.
    audioContext = new AudioContextCtor({ sampleRate: await audioTrack?.getSampleRate() });
    gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    updateVolume();
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    const canBeTransparent = videoTrack ? await videoTrack.canBeTransparent() : false;
    videoSink = videoTrack && new CanvasSink(videoTrack, { poolSize: 2, fit: 'contain', alpha: canBeTransparent });
    audioSink = audioTrack && (await audioTrack.canDecode()) ? new AudioBufferSink(audioTrack) : null;

    if (videoTrack) {
        canvas.style.display = '';
        canvas.width = await videoTrack.getDisplayWidth();
        canvas.height = await videoTrack.getDisplayHeight();
    } else {
        canvas.style.display = 'none';
        appendStatus('No usable video track, playing audio only.');
    }
    volumeBtn.style.display = audioSink ? '' : 'none';
    volumeBarContainer.style.display = audioSink ? '' : 'none';

    fileLoaded = true;
    allowPlaybackUrlSync = true;
    await startVideoIterator();

    statusOverlay.style.display = 'none';
    controlsElement.style.opacity = '1';
    controlsElement.style.pointerEvents = '';

    scheduleLiveRefreshIfNeeded(input, tracks);

    await play();
}

function scheduleLiveRefreshIfNeeded(input: Input, tracks: AnyTrack[]) {
    Promise.all(tracks.map(t => t.getLiveRefreshInterval())).then(intervals => {
        const nonNull = intervals.filter((x): x is number => x !== null);
        if (!nonNull.length) {
            return;
        }
        const interval = Math.min(...nonNull);
        liveDot.style.display = '';
        liveDot.onclick = () => {
            void seekToTime(endTimestamp - interval * 1.5);
        };

        const scheduleNext = () => {
            liveRefreshTimeoutId = window.setTimeout(async () => {
                endTimestamp = (await input.getDurationFromMetadata(tracks, { skipLiveWait: true }))
                    ?? (await input.computeDuration(tracks, { skipLiveWait: true })) ?? endTimestamp;
                durationEl.textContent = formatTimestamp(endTimestamp);

                const stillLive = await Promise.all(tracks.map(t => t.isLive()));
                if (stillLive.every(live => !live)) {
                    liveDot.style.display = 'none';
                } else {
                    scheduleNext();
                }
            }, interval * 1000);
        };
        scheduleNext();
    });
}

// --- Video rendering ---

async function startVideoIterator() {
    if (!videoSink) {
        return;
    }
    asyncId++;
    await videoFrameIterator?.return();
    videoFrameIterator = videoSink.canvases(getPlaybackTime());

    const first = (await videoFrameIterator.next()).value ?? null;
    nextFrame = (await videoFrameIterator.next()).value ?? null;
    if (first) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(first.canvas, 0, 0, canvas.width, canvas.height);
    }
}

async function updateNextFrame() {
    const id = asyncId;
    while (true) {
        let result;
        try {
            result = await videoFrameIterator!.next();
        } catch (e) {
            console.error('[experimental-player] video pipeline error', e);
            appendStatus('Video error: ' + (e instanceof Error ? e.message : e));
            return;
        }
        const frame = result.value ?? null;
        if (!frame || id !== asyncId) {
            return;
        }
        if (frame.timestamp <= getPlaybackTime()) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
        } else {
            nextFrame = frame;
            return;
        }
    }
}

// requestAnimationFrame stops firing entirely once the tab is backgrounded/hidden, so also
// drive render() from a setInterval fallback (throttled by the browser, but never fully
// stopped) to keep playback progressing while the tab isn't in the foreground.
function render(requestFrame: boolean) {
    if (fileLoaded) {
        const playbackTime = getPlaybackTime();
        if (playbackTime >= endTimestamp && endTimestamp > 0) {
            pause();
            playbackTimeAtStart = endTimestamp;
        }

        if (nextFrame && nextFrame.timestamp <= playbackTime) {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(nextFrame.canvas, 0, 0, canvas.width, canvas.height);
            nextFrame = null;
            void updateNextFrame();
        }

        if (!draggingProgressBar) {
            updateProgressBarTime(playbackTime);
        }
    }
    if (requestFrame) {
        requestAnimationFrame(() => render(true));
    }
}
render(true);
setInterval(() => render(false), 500);

// --- Audio playback ---

async function runAudioIterator() {
    if (!audioSink) {
        return;
    }
    try {
        for await (const { buffer, timestamp } of audioBufferIterator!) {
            const node = audioContext!.createBufferSource();
            node.buffer = buffer;
            node.connect(gainNode!);

            let when = audioContextStartTime! + timestamp - playbackTimeAtStart;
            when = Math.round(audioContext!.sampleRate * when) / audioContext!.sampleRate;

            if (when >= audioContext!.currentTime) {
                node.start(when);
            } else {
                // Already due (decode fell behind real time): play only what's left of it.
                node.start(audioContext!.currentTime, audioContext!.currentTime - when);
            }

            queuedAudioNodes.add(node);
            node.onended = () => queuedAudioNodes.delete(node);

            // Back-pressure: don't decode/schedule more than 1s ahead of playback.
            if (timestamp - getPlaybackTime() >= 1) {
                await new Promise<void>(resolve => {
                    const id = setInterval(() => {
                        if (timestamp - getPlaybackTime() < 1) {
                            clearInterval(id);
                            resolve();
                        }
                    }, 100);
                });
            }
        }
    } catch (e) {
        console.error('[experimental-player] audio pipeline error', e);
        appendStatus('Audio error: ' + (e instanceof Error ? e.message : e));
    }
}

// --- Playback control ---

function getPlaybackTime() {
    if (playing) {
        return audioContext!.currentTime - audioContextStartTime! + playbackTimeAtStart;
    }
    return playbackTimeAtStart;
}

async function play() {
    if (audioContext!.state === 'suspended') {
        await audioContext!.resume();
    }
    if (endTimestamp > 0 && getPlaybackTime() >= endTimestamp) {
        playbackTimeAtStart = firstTimestamp;
        await startVideoIterator();
    }

    audioContextStartTime = audioContext!.currentTime;
    playing = true;

    if (audioSink) {
        await audioBufferIterator?.return();
        audioBufferIterator = audioSink.buffers(getPlaybackTime());
        void runAudioIterator();
    }
    playPauseBtn.textContent = '⏸';
}

function pause() {
    playbackTimeAtStart = getPlaybackTime();
    playing = false;

    audioBufferIterator?.return();
    audioBufferIterator = null;
    for (const node of queuedAudioNodes) {
        try {
            node.stop();
        } catch {
            /* already stopped/ended */
        }
    }
    queuedAudioNodes.clear();
    playPauseBtn.textContent = '▶';
    replaceUrlWithCurrentTime();
}

function togglePlay() {
    if (playing) {
        pause();
    } else {
        void play();
    }
}

async function seekToTime(t: number) {
    t = Math.max(firstTimestamp, endTimestamp > 0 ? Math.min(t, endTimestamp) : t);
    updateProgressBarTime(t);
    const wasPlaying = playing;
    if (wasPlaying) {
        pause();
    }
    playbackTimeAtStart = t;
    await startVideoIterator();
    if (wasPlaying) {
        await play();
    }
}

// --- Progress bar ---

function updateProgressBarTime(seconds: number) {
    currentTimeEl.textContent = formatTimestamp(seconds);
    const pct = endTimestamp > firstTimestamp ? ((seconds - firstTimestamp) / (endTimestamp - firstTimestamp)) * 100 : 0;
    progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

function pctFromPointerEvent(e: PointerEvent, container: HTMLElement) {
    const rect = container.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

progressBarContainer.addEventListener('pointerdown', e => {
    draggingProgressBar = true;
    progressBarContainer.setPointerCapture(e.pointerId);
    updateProgressBarTime(firstTimestamp + pctFromPointerEvent(e, progressBarContainer) * (endTimestamp - firstTimestamp));
    showControlsTemporarily();
});
progressBarContainer.addEventListener('pointermove', e => {
    if (draggingProgressBar) {
        updateProgressBarTime(firstTimestamp + pctFromPointerEvent(e, progressBarContainer) * (endTimestamp - firstTimestamp));
    }
});
window.addEventListener('pointerup', e => {
    if (!draggingProgressBar) {
        return;
    }
    draggingProgressBar = false;
    void seekToTime(firstTimestamp + pctFromPointerEvent(e, progressBarContainer) * (endTimestamp - firstTimestamp));
});

// --- Volume ---

function updateVolume() {
    const actual = volumeMuted ? 0 : volume;
    volumeBar.style.width = actual * 100 + '%';
    if (gainNode) {
        gainNode.gain.value = actual ** 2; // Quadratic for more fine-grained perceived control.
    }
    volumeBtn.textContent = actual === 0 ? '🔇' : actual < 0.5 ? '🔉' : '🔊';
}

volumeBarContainer.addEventListener('pointerdown', e => {
    draggingVolumeBar = true;
    volumeBarContainer.setPointerCapture(e.pointerId);
    volume = pctFromPointerEvent(e, volumeBarContainer);
    volumeMuted = false;
    updateVolume();
    showControlsTemporarily();
});
volumeBarContainer.addEventListener('pointermove', e => {
    if (draggingVolumeBar) {
        volume = pctFromPointerEvent(e, volumeBarContainer);
        updateVolume();
    }
});
window.addEventListener('pointerup', () => {
    draggingVolumeBar = false;
});
volumeBtn.addEventListener('click', () => {
    volumeMuted = !volumeMuted;
    updateVolume();
});

// --- Auto-hide controls ---

let hideControlsTimeout = -1;

function showControlsTemporarily() {
    controlsElement.style.opacity = '1';
    playerContainer.style.cursor = '';
    window.clearTimeout(hideControlsTimeout);
    hideControlsTimeout = window.setTimeout(() => {
        if (draggingProgressBar || draggingVolumeBar) {
            return;
        }
        hideControls();
        playerContainer.style.cursor = 'none';
    }, 2000);
}

function hideControls() {
    controlsElement.style.opacity = '0';
}

playerContainer.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' && fileLoaded) {
        showControlsTemporarily();
    }
});
playerContainer.addEventListener('pointerleave', e => {
    if (draggingProgressBar || draggingVolumeBar || e.pointerType === 'touch' || !fileLoaded) {
        return;
    }
    hideControls();
    window.clearTimeout(hideControlsTimeout);
});

const isTouchDevice = () => 'ontouchstart' in window;

// YouTube-style: single tap toggles play/pause (or shows controls, on touch), double tap in
// the left/right third seeks +/-10s. The single-tap action is held for the double-click window
// so a following second click cancels it instead of running twice (toggle-toggle would just
// flicker back to where it started).
let clickTimer = -1;
playerContainer.addEventListener('click', () => {
    if (!fileLoaded) {
        return;
    }
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(() => {
        if (isTouchDevice()) {
            controlsElement.style.opacity === '1' ? hideControls() : showControlsTemporarily();
        } else {
            togglePlay();
        }
    }, 250);
});
playerContainer.addEventListener('dblclick', e => {
    if (!fileLoaded) {
        return;
    }
    window.clearTimeout(clickTimer);
    const rect = playerContainer.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    if (frac < 1 / 3) {
        void seekToTime(getPlaybackTime() - 10);
        flashSeek('back');
    } else if (frac > 2 / 3) {
        void seekToTime(getPlaybackTime() + 10);
        flashSeek('fwd');
    } else {
        togglePlay();
    }
    showControlsTemporarily();
});
controlsElement.addEventListener('click', e => {
    e.stopPropagation();
    showControlsTemporarily();
});
controlsElement.addEventListener('dblclick', e => e.stopPropagation());

const seekFlashHideTimers: Record<'back' | 'fwd', number> = { back: -1, fwd: -1 };
function flashSeek(which: 'back' | 'fwd') {
    const el = document.getElementById('seek-flash-' + which)!;
    el.classList.remove('show');
    void el.offsetWidth; // restart the fade-out transition on a repeat tap
    el.classList.add('show');
    window.clearTimeout(seekFlashHideTimers[which]);
    seekFlashHideTimers[which] = window.setTimeout(() => el.classList.remove('show'), 500);
}

// --- Fullscreen + keyboard shortcuts ---

fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
        void document.exitFullscreen();
    } else {
        playerContainer.requestFullscreen().catch(e => console.error('Failed to enter fullscreen mode:', e));
    }
});

window.addEventListener('keydown', e => {
    if (!fileLoaded) {
        return;
    }
    if (e.code === 'Space' || e.code === 'KeyK') {
        togglePlay();
    } else if (e.code === 'KeyF') {
        fullscreenBtn.click();
    } else if (e.code === 'ArrowLeft') {
        void seekToTime(getPlaybackTime() - 5);
    } else if (e.code === 'ArrowRight') {
        void seekToTime(getPlaybackTime() + 5);
    } else if (e.code === 'KeyM') {
        volumeBtn.click();
    } else {
        return;
    }
    showControlsTemporarily();
    e.preventDefault();
});

// --- Utils ---

function formatTimestamp(seconds: number) {
    if (isRelativeToUnixEpoch) {
        return new Date(seconds * 1000).toISOString().replace('T', '\n');
    }
    return CMP.formatClock(seconds);
}

window.addEventListener('resize', () => {
    if (endTimestamp) {
        updateProgressBarTime(getPlaybackTime());
        durationEl.textContent = formatTimestamp(endTimestamp);
    }
});

// --- Original link + share (mirrors ../../player/player.js so both players behave the same) ---

function buildPlayerUrlWithCurrentTime() {
    const u = new URL(window.location.href);
    const param = CMP.formatTimeParam(getPlaybackTime());
    if (param !== null) {
        u.searchParams.set('t', param);
    } else {
        u.searchParams.delete('t');
    }
    u.hash = window.location.hash;
    return u.href;
}

function replaceUrlWithCurrentTime() {
    if (!allowPlaybackUrlSync || !CMP.parseM3u8FromHash()) {
        return;
    }
    const u = new URL(window.location.href);
    const param = CMP.formatTimeParam(getPlaybackTime());
    if (param !== null) {
        u.searchParams.set('t', param);
    } else {
        u.searchParams.delete('t');
    }
    const next = u.pathname + u.search + u.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) {
        history.replaceState(null, '', next);
    }
}

shareBtn.addEventListener('click', () => {
    replaceUrlWithCurrentTime();
    const shareUrl = buildPlayerUrlWithCurrentTime();
    const timeLabel = CMP.formatTimeParam(getPlaybackTime()) || '0';
    if (navigator.share) {
        navigator.share({ title: document.title, text: 'Video at ' + timeLabel + 's', url: shareUrl })
            .catch(e => console.error('Error sharing', e));
    } else if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shareUrl)
            .then(() => alert('Link with timestamp copied to clipboard.'))
            .catch(() => prompt('Copy this link:', shareUrl));
    } else {
        prompt('Copy this link (includes current time):', shareUrl);
    }
});

// --- Entry point ---

const originalUrl = CMP.originalUrlFromQuery();
if (originalUrl) {
    originalBtn.style.display = '';
    originalBtn.addEventListener('click', () => window.open(originalUrl, '_blank'));
    // Home carries the source URL back so the picker reopens on the same event / competition.
    homeBtn.href = '../?u=' + encodeURIComponent(originalUrl);
}

loadBtn.addEventListener('click', () => {
    const m3u8Url = CMP.parseM3u8FromHash();
    if (!m3u8Url) {
        setStatus('No m3u8 URL provided. Open this page as player-experimental/#<encoded m3u8 url>');
        return;
    }
    loadBtn.style.display = 'none';
    initPlayer(m3u8Url, CMP.startSecondsFromQuery()).catch(e => {
        console.error('[experimental-player] fatal error', e);
        appendStatus('Fatal error: ' + (e instanceof Error ? e.message : e));
        loadBtn.style.display = '';
    });
});

window.addEventListener('load', () => {
    const m3u8Url = CMP.parseM3u8FromHash();
    setStatus(m3u8Url
        ? 'Ready. Click Play to start (experimental WebCodecs + canvas pipeline).'
        : 'No m3u8 URL in hash. Open as player-experimental/#<encoded m3u8 url>');
});
