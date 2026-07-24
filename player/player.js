var video = document.getElementById('video');
var hlsInstance = null;
var allowPlaybackUrlSync = false;

// Force-check for a newer service worker on every visit and reload once it takes over, so the
// player page doesn't get stuck on a stale cached bundle (the SW's stale-while-revalidate serves
// the OLD cached copy immediately and only refreshes the cache for the *next* load otherwise).
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) {
            return;
        }
        reg.update();
        navigator.serviceWorker.addEventListener('controllerchange', function onControllerChange() {
            navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
            window.location.reload();
        });
    });
}

function destroyHls() {
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
}

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

function formatTimeParam(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0.05) {
        return null;
    }
    var rounded = Math.round(seconds * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 1e-6) {
        return String(Math.round(rounded));
    }
    return String(rounded);
}

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

function originalUrlFromQuery() {
    var orig = new URLSearchParams(window.location.search).get('orig');
    return orig || null;
}

$(window).on('load', function () {
    playM3u8(parseM3u8FromHash(), startSecondsFromQuery());

    var originalUrl = originalUrlFromQuery();
    if (originalUrl) {
        $('#original-btn').show().click(function () {
            window.open(originalUrl, '_blank');
        });
    }
    $('#video').on('click', function () { this.paused ? this.play() : this.pause(); });
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
