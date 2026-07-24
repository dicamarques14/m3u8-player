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

var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');
var statusEl = document.getElementById('status');
var playBtn = document.getElementById('play-btn');

var stopped = false;

function setStatus(msg) {
    console.log('[experimental-player]', msg);
    statusEl.textContent = msg;
}

function appendStatus(msg) {
    console.log('[experimental-player]', msg);
    statusEl.textContent += '\n' + msg;
}

// Playback architecture mirrors mediabunny's own reference player
// (github.com/Vanilagy/mediabunny examples/media-player): AudioContext's clock is the single
// source of truth for both audio scheduling and video frame pacing, and the video pipeline
// drains any backlog of already-due frames instead of drawing one frame per animation frame
// (which stalls if decode falls behind, and is what made playback look "stuck").
async function startPlayback(m3u8Url, startSeconds) {
    setStatus('Opening input via WebCodecs/mediabunny…\n' + m3u8Url);
    var input = new Input({ source: new UrlSource(m3u8Url), formats: ALL_FORMATS });

    var videoTrack = await input.getPrimaryVideoTrack();
    var audioTrack = await input.getPrimaryAudioTrack();

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
    var firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0);
    var playbackTimeAtStart = firstTimestamp + (startSeconds || 0);

    canvas.width = videoTrack.displayWidth || canvas.width;
    canvas.height = videoTrack.displayHeight || canvas.height;

    var audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    var audioContextStartTime = audioContext.currentTime;

    function playbackTime() {
        return audioContext.currentTime - audioContextStartTime + playbackTimeAtStart;
    }

    if (audioTrack && (await audioTrack.canDecode())) {
        appendStatus('Audio track found, scheduling via Web Audio API.');
        var audioSink = new AudioBufferSink(audioTrack);
        (async function pumpAudio() {
            try {
                for await (var chunk of audioSink.buffers(playbackTimeAtStart)) {
                    if (stopped) {
                        break;
                    }
                    var node = audioContext.createBufferSource();
                    node.buffer = chunk.buffer;
                    node.connect(audioContext.destination);

                    var when = audioContextStartTime + chunk.timestamp - playbackTimeAtStart;
                    if (when >= audioContext.currentTime) {
                        node.start(when);
                    } else {
                        // Already due (decode fell behind real time): play only what's left of it.
                        node.start(audioContext.currentTime, audioContext.currentTime - when);
                    }

                    // Back-pressure: don't decode/schedule more than 1s ahead of playback.
                    if (chunk.timestamp - playbackTime() >= 1) {
                        await new Promise(function (resolve) {
                            var id = setInterval(function () {
                                if (stopped || chunk.timestamp - playbackTime() < 1) {
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
        })();
    } else {
        appendStatus('No usable audio track, playing video only.');
    }

    appendStatus('Playing…');

    var videoSink = new CanvasSink(videoTrack, { poolSize: 2 });
    var videoFrameIterator = videoSink.canvases(playbackTimeAtStart);
    var nextFrame = null;

    var first = (await videoFrameIterator.next()).value || null;
    nextFrame = (await videoFrameIterator.next()).value || null;
    if (first) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(first.canvas, 0, 0, canvas.width, canvas.height);
    }

    async function updateNextFrame() {
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
            if (!frame || stopped) {
                if (!frame) {
                    setStatus('Playback ended.');
                }
                return;
            }
            if (frame.timestamp <= playbackTime()) {
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
        if (stopped) {
            return;
        }
        var pt = playbackTime();
        if (nextFrame && nextFrame.timestamp <= pt) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(nextFrame.canvas, 0, 0, canvas.width, canvas.height);
            nextFrame = null;
            updateNextFrame();
        }
        if (requestFrame) {
            requestAnimationFrame(function () { render(true); });
        }
    }
    render(true);
    var renderFallbackInterval = setInterval(function () {
        if (stopped) {
            clearInterval(renderFallbackInterval);
            return;
        }
        render(false);
    }, 500);
}

playBtn.addEventListener('click', function () {
    var m3u8Url = parseM3u8FromHash();
    if (!m3u8Url) {
        setStatus('No m3u8 URL provided. Open this page as player-experimental/#<encoded m3u8 url>');
        return;
    }

    playBtn.style.display = 'none';
    stopped = false;

    startPlayback(m3u8Url, startSecondsFromQuery()).catch(function (e) {
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
