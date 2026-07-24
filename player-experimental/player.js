import { Input, UrlSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from 'https://cdn.jsdelivr.net/npm/mediabunny/+esm';

// Mirrors parseM3u8FromHash()/startSecondsFromQuery() in ../player/player.js so both
// players accept the exact same "#<encoded m3u8 url>" + "?t=<seconds>" link shape.
function parseM3u8FromHash() {
    var raw = window.location.hash.slice(1);
    if (!raw) {
        return undefined;
    }
    try {
        return decodeURIComponent(raw);
    } catch (e) {
        return raw;
    }
}

function startSecondsFromQuery() {
    var t = new URLSearchParams(window.location.search).get('t');
    if (t === null || t === '') {
        return undefined;
    }
    var n = parseFloat(t);
    return Number.isFinite(n) ? n : undefined;
}

function formatSeconds(s) {
    s = Math.max(0, s || 0);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = Math.floor(s % 60);
    var mm = String(m).padStart(2, '0');
    var sss = String(ss).padStart(2, '0');
    return h > 0 ? (h + ':' + mm + ':' + sss) : (m + ':' + sss);
}

// --- DOM ---
var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');
var statusEl = document.getElementById('status');
var playBtn = document.getElementById('play-btn');
var controlsEl = document.getElementById('controls');
var playPauseBtn = document.getElementById('play-pause-btn');
var progressBarContainer = document.getElementById('progress-bar-container');
var progressBar = document.getElementById('progress-bar');
var timeLabel = document.getElementById('time-label');

function setStatus(msg) {
    console.log('[experimental-player]', msg);
    statusEl.textContent = msg;
}

function appendStatus(msg) {
    console.log('[experimental-player]', msg);
    statusEl.textContent += '\n' + msg;
}

// --- Player state ---
// Playback architecture mirrors the reference player at TeslaVid/player.js, itself built on
// mediabunny's own reference (github.com/Vanilagy/mediabunny examples/media-player):
// AudioContext's clock is the single source of truth for both audio scheduling and video frame
// pacing; play/pause/seek all just move playbackTimeAtStart and restart the relevant iterator.
var videoTrack = null;
var audioTrack = null;
var videoSink = null;
var audioSink = null;
var firstTimestamp = 0;
var endTimestamp = 0;
var audioContext = null;
var audioContextStartTime = null;
var playing = false;
var playbackTimeAtStart = 0;
var videoFrameIterator = null;
var audioBufferIterator = null;
var nextFrame = null;
var queuedAudioNodes = new Set();
// Incremented on every seek so a stale in-flight video drain from before the seek is discarded.
var asyncId = 0;
var draggingProgressBar = false;

function getPlaybackTime() {
    if (playing) {
        return audioContext.currentTime - audioContextStartTime + playbackTimeAtStart;
    }
    return playbackTimeAtStart;
}

function updateProgressBar(t) {
    timeLabel.textContent = formatSeconds(t - firstTimestamp) + ' / ' + formatSeconds(endTimestamp - firstTimestamp);
    var pct = endTimestamp > firstTimestamp ? ((t - firstTimestamp) / (endTimestamp - firstTimestamp)) * 100 : 0;
    progressBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
}

// --- Video rendering ---

async function startVideoIterator() {
    if (!videoSink) {
        return;
    }
    asyncId++;
    if (videoFrameIterator) {
        await videoFrameIterator.return();
    }
    videoFrameIterator = videoSink.canvases(getPlaybackTime());

    var first = (await videoFrameIterator.next()).value || null;
    nextFrame = (await videoFrameIterator.next()).value || null;
    if (first) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(first.canvas, 0, 0, canvas.width, canvas.height);
    }
}

async function updateNextFrame() {
    var id = asyncId;
    while (true) {
        var result;
        try {
            result = await videoFrameIterator.next();
        } catch (e) {
            console.error('[experimental-player] video pipeline error', e);
            appendStatus('Video error: ' + (e && e.message ? e.message : e));
            return;
        }
        var frame = result.value || null;
        if (!frame || id !== asyncId) {
            if (!frame && id === asyncId) {
                setStatus('Playback ended.');
            }
            return;
        }
        if (frame.timestamp <= getPlaybackTime()) {
            // Already due: draw immediately and keep draining instead of stalling on it.
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height);
        } else {
            nextFrame = frame;
            return;
        }
    }
}

// requestAnimationFrame stops firing entirely once the tab is backgrounded/hidden, so also
// drive render() from a setInterval fallback (throttled by the browser, but never fully
// stopped) to keep playback progressing while the tab isn't in the foreground.
function render(requestFrame) {
    var pt = getPlaybackTime();
    if (nextFrame && nextFrame.timestamp <= pt) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(nextFrame.canvas, 0, 0, canvas.width, canvas.height);
        nextFrame = null;
        updateNextFrame();
    }
    if (!draggingProgressBar) {
        updateProgressBar(pt);
    }
    if (requestFrame) {
        requestAnimationFrame(function () { render(true); });
    }
}
render(true);
setInterval(function () { render(false); }, 500);

// --- Audio playback ---

async function runAudioIterator() {
    if (!audioSink) {
        return;
    }
    try {
        for await (var chunk of audioBufferIterator) {
            var node = audioContext.createBufferSource();
            node.buffer = chunk.buffer;
            node.connect(audioContext.destination);

            var when = audioContextStartTime + chunk.timestamp - playbackTimeAtStart;
            when = Math.round(audioContext.sampleRate * when) / audioContext.sampleRate;

            if (when >= audioContext.currentTime) {
                node.start(when);
            } else {
                // Already due (decode fell behind real time): play only what's left of it.
                node.start(audioContext.currentTime, audioContext.currentTime - when);
            }

            queuedAudioNodes.add(node);
            node.onended = function () { queuedAudioNodes.delete(node); };

            // Back-pressure: don't decode/schedule more than 1s ahead of playback.
            if (chunk.timestamp - getPlaybackTime() >= 1) {
                await new Promise(function (resolve) {
                    var id = setInterval(function () {
                        if (chunk.timestamp - getPlaybackTime() < 1) {
                            clearInterval(id);
                            resolve();
                        }
                    }, 100);
                });
            }
        }
    } catch (e) {
        console.error('[experimental-player] audio pipeline error', e);
        appendStatus('Audio error: ' + (e && e.message ? e.message : e));
    }
}

// --- Playback control ---

async function play() {
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    if (endTimestamp > 0 && getPlaybackTime() >= endTimestamp) {
        playbackTimeAtStart = firstTimestamp;
        await startVideoIterator();
    }

    audioContextStartTime = audioContext.currentTime;
    playing = true;

    if (audioSink) {
        if (audioBufferIterator) {
            await audioBufferIterator.return();
        }
        audioBufferIterator = audioSink.buffers(getPlaybackTime());
        runAudioIterator();
    }

    playPauseBtn.textContent = '⏸';
}

function pause() {
    playbackTimeAtStart = getPlaybackTime();
    playing = false;

    if (audioBufferIterator) {
        audioBufferIterator.return();
        audioBufferIterator = null;
    }
    for (var node of queuedAudioNodes) {
        try {
            node.stop();
        } catch (e) {
            /* already stopped/ended */
        }
    }
    queuedAudioNodes.clear();

    playPauseBtn.textContent = '▶';
}

function togglePlay() {
    if (playing) {
        pause();
    } else {
        play();
    }
}

async function seekToTime(t) {
    t = Math.max(firstTimestamp, endTimestamp > 0 ? Math.min(t, endTimestamp) : t);
    updateProgressBar(t);
    var wasPlaying = playing;
    if (wasPlaying) {
        pause();
    }
    playbackTimeAtStart = t;
    await startVideoIterator();
    if (wasPlaying) {
        await play();
    }
}

playPauseBtn.addEventListener('click', togglePlay);

function pctFromPointerEvent(e) {
    var rect = progressBarContainer.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

progressBarContainer.addEventListener('pointerdown', function (e) {
    draggingProgressBar = true;
    progressBarContainer.setPointerCapture(e.pointerId);
    updateProgressBar(firstTimestamp + pctFromPointerEvent(e) * (endTimestamp - firstTimestamp));
});
progressBarContainer.addEventListener('pointermove', function (e) {
    if (!draggingProgressBar) {
        return;
    }
    updateProgressBar(firstTimestamp + pctFromPointerEvent(e) * (endTimestamp - firstTimestamp));
});
window.addEventListener('pointerup', function (e) {
    if (!draggingProgressBar) {
        return;
    }
    draggingProgressBar = false;
    seekToTime(firstTimestamp + pctFromPointerEvent(e) * (endTimestamp - firstTimestamp));
});

// --- Init ---

async function initPlayer(m3u8Url, startSeconds) {
    setStatus('Opening input via WebCodecs/mediabunny…\n' + m3u8Url);
    var input = new Input({ source: new UrlSource(m3u8Url), formats: ALL_FORMATS });

    videoTrack = await input.getPrimaryVideoTrack();
    audioTrack = await input.getPrimaryAudioTrack();

    if (!videoTrack) {
        appendStatus('No video track found in this stream.');
        return;
    }
    if (!(await videoTrack.canDecode())) {
        appendStatus('This browser cannot decode the video codec via WebCodecs.');
        return;
    }

    var tracks = [videoTrack, audioTrack].filter(Boolean);
    // Streams (especially HLS) commonly don't start at timestamp 0 (encoder offsets, PTS
    // discontinuities); anchoring to 0 made playback wait "frozen" until real time caught up
    // to the stream's actual first timestamp.
    firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    // skipLiveWait returns the best-known extent immediately instead of hanging for a live/growing
    // stream, so this also gives a (growing) seek range for clipmyhorse's live streams.
    endTimestamp = ((await input.getDurationFromMetadata(tracks, { skipLiveWait: true }))
        ?? (await input.computeDuration(tracks, { skipLiveWait: true }))) || 0;
    playbackTimeAtStart = firstTimestamp + (startSeconds || 0);

    canvas.width = videoTrack.displayWidth || canvas.width;
    canvas.height = videoTrack.displayHeight || canvas.height;

    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    if (audioTrack && (await audioTrack.canDecode())) {
        appendStatus('Audio track found, scheduling via Web Audio API.');
        audioSink = new AudioBufferSink(audioTrack);
    } else {
        appendStatus('No usable audio track, playing video only.');
    }

    videoSink = new CanvasSink(videoTrack, { poolSize: 2 });
    await startVideoIterator();

    controlsEl.style.display = 'block';
    updateProgressBar(playbackTimeAtStart);
    appendStatus('Playing…');

    await play();
}

playBtn.addEventListener('click', function () {
    var m3u8Url = parseM3u8FromHash();
    if (!m3u8Url) {
        setStatus('No m3u8 URL provided. Open this page as player-experimental/#<encoded m3u8 url>');
        return;
    }

    playBtn.style.display = 'none';

    initPlayer(m3u8Url, startSecondsFromQuery()).catch(function (e) {
        console.error('[experimental-player] fatal error', e);
        appendStatus('Fatal error: ' + (e && e.message ? e.message : e));
        playBtn.style.display = '';
    });
});

window.addEventListener('load', function () {
    var m3u8Url = parseM3u8FromHash();
    setStatus(m3u8Url
        ? 'Ready. Click Play to start (experimental WebCodecs + canvas pipeline).'
        : 'No m3u8 URL in hash. Open as player-experimental/#<encoded m3u8 url>');
});
