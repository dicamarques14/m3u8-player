var video = document.getElementById('video');
var hlsInstance = null;
var allowPlaybackUrlSync = false;

function destroyHls() {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
}

// Link shape helpers live in ../shared/link-params.js so both players agree on it.
var parseM3u8FromHash = CMP.parseM3u8FromHash;
var startSecondsFromQuery = CMP.startSecondsFromQuery;
var formatTimeParam = CMP.formatTimeParam;

function buildPlayerUrlWithCurrentTime() {
    var u = new URL(window.location.href);
    var param = formatTimeParam(video.currentTime);
    if (param !== null) {
        u.searchParams.set('t', param);
    } else {
        u.searchParams.delete('t');
    }
    u.hash = window.location.hash;
    return u.href;
}

function replaceUrlWithCurrentTime() {
    if (!allowPlaybackUrlSync || !parseM3u8FromHash()) {
        return;
    }
    var u = new URL(window.location.href);
    var param = formatTimeParam(video.currentTime);
    if (param !== null) {
        u.searchParams.set('t', param);
    } else {
        u.searchParams.delete('t');
    }
    var next = u.pathname + u.search + u.hash;
    var cur = window.location.pathname + window.location.search + window.location.hash;
    if (next !== cur) {
        history.replaceState(null, '', next);
    }
}

function applyStartTime(seconds) {
    if (seconds === undefined || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
        return;
    }
    var apply = function () {
        var end = video.duration;
        if (Number.isFinite(end) && end > 0 && seconds > end) {
            video.currentTime = end;
        } else {
            video.currentTime = seconds;
        }
    };
    video.addEventListener('loadedmetadata', apply, { once: true });
}

function playM3u8(m3u8Url, startSeconds) {
    if (m3u8Url === undefined || m3u8Url === '') {
        window.location.href = '../';
        return;
    }

    destroyHls();
    applyStartTime(startSeconds);

    if (Hls.isSupported()) {
        video.volume = 0.3;
        hlsInstance = new Hls();
        hlsInstance.loadSource(m3u8Url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
            video.play();
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = m3u8Url;
        video.addEventListener('canplay', function onCanPlay() {
            video.removeEventListener('canplay', onCanPlay);
            video.play();
        });
        video.volume = 0.3;
    }
}

function playPause() {
    video.paused ? video.play() : video.pause();
}

function flashSeek(el) {
    el.classList.remove('show');
    // Force reflow so re-adding the class restarts the fade-out transition on a repeat tap.
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(function () { el.classList.remove('show'); }, 500);
}

function seekBy(delta) {
    var next = video.currentTime + delta;
    var end = video.duration;
    video.currentTime = Number.isFinite(end) && end > 0 ? Math.min(Math.max(next, 0), end) : Math.max(next, 0);
    flashSeek(delta < 0 ? document.getElementById('seek-flash-back') : document.getElementById('seek-flash-fwd'));
}

// YouTube-style: single tap toggles play/pause, double tap in the left/right third seeks
// +/-10s. A single click is held for the double-click window so a following second click
// can cancel it instead of toggling play/pause twice (which would just flicker back).
var clickTimer = null;
$('#video').on('click', function () {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(playPause, 250);
});
$('#video').on('dblclick', function (e) {
    clearTimeout(clickTimer);
    var rect = this.getBoundingClientRect();
    var frac = (e.clientX - rect.left) / rect.width;
    if (frac < 1 / 3) {
        seekBy(-10);
    } else if (frac > 2 / 3) {
        seekBy(10);
    } else {
        playPause();
    }
});

function volumeUp() {
    if (video.volume <= 0.9) video.volume += 0.1;
}

function volumeDown() {
    if (video.volume >= 0.1) video.volume -= 0.1;
}

function seekRight() {
    video.currentTime += 5;
}

function seekLeft() {
    video.currentTime -= 5;
}

function vidFullscreen() {
    if (video.requestFullscreen) {
        video.requestFullscreen();
    } else if (video.mozRequestFullScreen) {
        video.mozRequestFullScreen();
    } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
    }
}

// Only tear down Hls when the page is actually discarded. Skip when persisted (bfcache /
// frozen page): destroying there would break restore, Back navigation, and any path that
// keeps the document alive while hidden. pagehide is not the same as visibilitychange;
// minimizing or switching apps usually does not fire pagehide (PiP keeps the page loaded).
window.addEventListener('pagehide', function (event) {
    if (event.persisted) {
        return;
    }
    destroyHls();
});

$(window).on('load', function () {
    playM3u8(parseM3u8FromHash(), startSecondsFromQuery());

    var originalUrl = CMP.originalUrlFromQuery();
    if (originalUrl) {
        $('#original-btn').show().click(function () {
            window.open(originalUrl, '_blank');
        });
        // Home goes back carrying the source URL, so the picker reopens on the same
        // event / competition instead of an empty box.
        $('#home-btn').attr('href', '../?u=' + encodeURIComponent(originalUrl));
    }
    $('#video').one('loadedmetadata', function () {
        allowPlaybackUrlSync = true;
    });

    Mousetrap.bind('space', playPause);
    Mousetrap.bind('up', volumeUp);
    Mousetrap.bind('down', volumeDown);
    Mousetrap.bind('right', seekRight);
    Mousetrap.bind('left', seekLeft);
    Mousetrap.bind('f', vidFullscreen);

    $('#video').on('pause', function () {
        replaceUrlWithCurrentTime();
    });

    $('#share-btn').click(function () {
        replaceUrlWithCurrentTime();
        var shareUrl = buildPlayerUrlWithCurrentTime();
        if (navigator.share) {
            navigator.share({
                title: document.title,
                text: 'Video at ' + (formatTimeParam(video.currentTime) || '0') + 's',
                url: shareUrl,
            }).then(() => {
                console.log('Thanks for sharing!');
            }).catch(function (error) {
                console.error('Error sharing', error);
            });
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(function () {
                alert('Link with timestamp copied to clipboard.');
            }).catch(function () {
                prompt('Copy this link:', shareUrl);
            });
        } else {
            prompt('Copy this link (includes current time):', shareUrl);
        }
    });
});
