// Shared link shape + formatting helpers.
//
// Every page speaks the same link language: "<player path>/#<encoded m3u8 url>?t=<seconds>&orig=<source url>".
// This file is the single definition of that shape. Loaded as a classic script (not a module) so
// both the classic player and the ES-module experimental player can use it via the CMP global.
window.CMP = (function () {
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

    function originalUrlFromQuery() {
        return new URLSearchParams(window.location.search).get('orig') || null;
    }

    // Returns null when the time is not worth putting in a link (start of the stream).
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

    // h:mm:ss, or m:ss below an hour.
    function formatClock(totalSeconds) {
        var s = Math.max(0, Math.floor(totalSeconds || 0));
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var ss = String(s % 60).padStart(2, '0');
        return h > 0 ? (h + ':' + String(m).padStart(2, '0') + ':' + ss) : (m + ':' + ss);
    }

    return {
        parseM3u8FromHash: parseM3u8FromHash,
        startSecondsFromQuery: startSecondsFromQuery,
        originalUrlFromQuery: originalUrlFromQuery,
        formatTimeParam: formatTimeParam,
        formatClock: formatClock
    };
})();
