function parseCMPonyUrl(url) {
    const clipMPonyRegex = /^https:\/\/www\.clipmyhorse\.tv\/[a-z]{2}_[A-Z]{2}\/(ondemand|horse|live|events)\/(.+)/;

    // Check if it's a valid CMPony URL
    const isValidCMPonyUrl = clipMPonyRegex.test(url);
    if (!isValidCMPonyUrl) {
        console.warn("parseCMPonyUrl", 'Invalid URL for CMPony');
        return null;
    }

    // Type A: slug segments may follow competition id before ?query (e.g. .../443288/csn-b-...?start_at=)
    const typeAPathRegex = /\/event\/(\d+)\/competition\/(\d+)(?:\/[^?#]*)?/;

    // Type B URL regex
    const typeBRegex = /\/horse\/([a-z0-9\-]+)#(\d+)/;

    // Type C URL regex (live event)
    const typeCRegex = /\/live\/(\d+)(?:\/.+)?/;

    // Type D: event overview page, links out to one or more live arenas (e.g. /events/19807/slug)
    const typeDRegex = /\/events\/(\d+)(?:\/[^?#]*)?/;

    let result = {};

    if (typeAPathRegex.test(url)) {
        const [, eventId, event_channel_id] = url.match(typeAPathRegex);
        result = {
            type: 'A',
            eventId,
            event_channel_id
        };
        try {
            const u = new URL(url);
            const startAtParam = u.searchParams.get('start_at');
            if (startAtParam != null && String(startAtParam).trim() !== '') {
                result.startAtId = String(startAtParam).trim();
            }
            const frag = u.hash.length > 1 ? u.hash.slice(1) : '';
            if (frag && /^\d+$/.test(frag)) {
                result.subpartId = frag;
            }
        } catch (e) {
            /* ignore malformed URL */
        }
    } else if (typeBRegex.test(url)) {
        // Extract horse and videoNum for Type B URL
        const [, horse, videoNum] = url.match(typeBRegex);
        result = {
            type: 'B',
            horse,
            videoNum
        };
    } else if (typeCRegex.test(url)) {
        // Extract eventId for Type C URL
        const [, event_channel_id] = url.match(typeCRegex);
        result = {
            type: 'C',
            event_channel_id
        };
    } else if (typeDRegex.test(url)) {
        // Extract eventId for Type D URL (overview page, resolved to a live arena later)
        const [, eventId] = url.match(typeDRegex);
        result = {
            type: 'D',
            eventId
        };
    } else {
        console.warn("parseCMPonyUrl", 'URL does not match any recognized format');
        return null;
    }

    return result;
}

async function doFetchWithCors(url, silent) {
    try {
        return await fetch(`https://allorigins.thedg.xyz/get?url=${encodeURIComponent(url)}`)
            .then(response => {
                if (response.ok) return response.json()
                throw new Error('Network response was not ok.')
            })
            .then(data => {
                return JSON.parse(data.contents);
            }
            );
    } catch (error) {
        console.error("doFetchWithCors", error);
        if (!silent) {
            displayError('Could not load playlist metadata. Check your connection or try again.');
        }
    }
}

// Fetches a page's raw HTML through the CORS proxy without assuming it's JSON (unlike doFetchWithCors).
async function doFetchRawWithCors(url, silent) {
    try {
        const response = await fetch(`https://allorigins.thedg.xyz/get?url=${encodeURIComponent(url)}`);
        if (!response.ok) {
            throw new Error('Network response was not ok.');
        }
        const data = await response.json();
        return data.contents;
    } catch (error) {
        console.error("doFetchRawWithCors", error);
        if (!silent) {
            displayError('Could not load the event page. Check your connection or try again.');
        }
        return null;
    }
}

function looksLikeM3u8(url) {
    try {
        return /\.m3u8$/i.test(new URL(url, window.location.href).pathname);
    } catch (e) {
        return /\.m3u8(\?|#|$)/i.test(String(url));
    }
}

function playerdataUrlForParsed(parsedUrl) {
    switch (parsedUrl.type) {
        case 'A':
            return `https://www.clipmyhorse.tv/en_US/archive/playerdata/${parsedUrl.eventId}/${parsedUrl.event_channel_id}`;
        case 'B':
            return `https://www.clipmyhorse.tv/en_US/playlist/playerdata/${parsedUrl.horse}`;
        case 'C':
            //<any_valid_event_ID>/event_channel_id
            return `https://www.clipmyhorse.tv/en_US/live/playerdata/14178/${parsedUrl.event_channel_id}`;
        default:
            return null;
    }
}

function navigateToPlayer(playlistUrl, startSeconds, originalUrl, playerPath) {
    if (!looksLikeM3u8(playlistUrl)) {
        displayError('Resolved stream does not look like an m3u8 playlist: ' + (playlistUrl || '(empty)'));
        return;
    }
    var encoded = encodeURIComponent(playlistUrl);
    var params = new URLSearchParams();
    if (typeof startSeconds === 'number' && Number.isFinite(startSeconds) && startSeconds >= 0) {
        params.set('t', String(startSeconds));
    }
    if (originalUrl) {
        params.set('orig', originalUrl);
    }
    var query = params.toString();
    var href = (playerPath || './player/') + (query ? '?' + query : '') + '#' + encoded;
    window.location.href = href;
}

async function fetchPlayerData(url, playerPath) {
    let parsedUrl = parseCMPonyUrl(url);

    if (!parsedUrl) {
        if (looksLikeM3u8(url)) {
            window.location.href = (playerPath || './player/') + '#' + encodeURIComponent(url);
        } else {
            displayError('Could not parse this URL as a clipmyhorse.tv link, and it does not look like a direct .m3u8 URL: ' + url);
        }
        return;
    }

    let playerdataUrl = '';

    if (parsedUrl.type === 'C' || parsedUrl.type === 'D') {
        // Both a live page (/live/<id>/slug) and an event overview page (/events/<id>/slug) embed
        // a <cmh-video-player-live data-path="playerdata/<eventId>/<event_channel_id>?..."> tag.
        // Scraping it is more accurate than guessing from the URL (handles multi-arena overview
        // pages correctly), so try it for both types; only the trailing id pair matters.
        const html = await doFetchRawWithCors(url, true);
        const dataPathMatch = html && html.match(/<cmh-video-player-live[^>]*\bdata-path="([^"]+)"/);
        const idsMatch = dataPathMatch && dataPathMatch[1].match(/playerdata\/(\d+)\/(\d+)/);

        if (idsMatch) {
            const [, eventId, event_channel_id] = idsMatch;
            parsedUrl = { type: 'C', eventId, event_channel_id };
        } else if (parsedUrl.type === 'C') {
            // Fallback: confirmed the server ignores the first id entirely, so a /live/ URL can
            // skip scraping and go straight from its own event_channel_id.
            parsedUrl = { type: 'C', eventId: '14178', event_channel_id: parsedUrl.event_channel_id };
        } else {
            displayError('Could not find a live player on this event page (eventId ' + parsedUrl.eventId + ').');
            return;
        }
    }

    playerdataUrl = playerdataUrlForParsed(parsedUrl);
    if (!playerdataUrl) {
        displayError('Unknown URL type');
        return;
    }

    // Fetch and handle the player data
    try {
        const response = await doFetchWithCors(playerdataUrl);
        if (!response) {
            return;
        }
        await handlePlayerRedirect(parsedUrl, response, url, playerPath);
    } catch (error) {
        console.error('fetchPlayerData error:', error.message);
        displayError('Failed to fetch player data.');
    }
}

// Helper to handle redirection based on parsed URL type
function pickStreamFromStreams(streams, subpartId) {
    if (!Array.isArray(streams) || streams.length === 0) {
        return null;
    }
    if (subpartId == null || subpartId === '') {
        return streams[0];
    }
    return streams.find(function (s) {
        return s && String(s.subpart_id) === String(subpartId);
    }) || null;
}

function videoDataUrlForSubpart(subpartId) {
    return 'https://d3j92f3aek4h9x.cloudfront.net/en/us/videodata/' + encodeURIComponent(String(subpartId).trim());
}

function secondFromVideoDataEntries(entries, startAtId) {
    var cue = entries.find(function (e) {
        return e && String(e.id) === String(startAtId);
    });
    if (!cue) {
        return null;
    }
    var sec = typeof cue.second === 'number' ? cue.second : parseFloat(String(cue.second));
    return Number.isFinite(sec) && sec >= 0 ? sec : null;
}

async function fetchVideoDataEntriesForSubpart(subpartId, silentFetch) {
    var videoData = await doFetchWithCors(videoDataUrlForSubpart(subpartId), silentFetch);
    if (!videoData) {
        return null;
    }
    var entries = Array.isArray(videoData) ? videoData : (videoData && videoData.data);
    if (!Array.isArray(entries)) {
        if (!silentFetch) {
            displayError('Video timeline data was not in the expected format.');
        }
        return null;
    }
    return entries;
}

async function resolveStartSecondsForTypeA(streamA, startAtId) {
    if (startAtId == null || startAtId === '') {
        return undefined;
    }
    var subpartId = streamA && streamA.subpart_id;
    if (subpartId == null || String(subpartId).trim() === '') {
        displayError('Cannot resolve start time: stream has no subpart_id.');
        return null;
    }
    var entries = await fetchVideoDataEntriesForSubpart(String(subpartId).trim(), false);
    if (!entries) {
        return null;
    }
    var sec = secondFromVideoDataEntries(entries, startAtId);
    if (sec === null) {
        displayError('Could not find a timeline entry for start_at id ' + startAtId + '.');
        return null;
    }
    return sec;
}

async function findStreamByStartAtAcrossStreams(streams, startAtId) {
    var tried = new Set();
    for (var i = 0; i < streams.length; i++) {
        var s = streams[i];
        if (!s || !s.playlistfile) {
            continue;
        }
        if (s.subpart_id == null || String(s.subpart_id).trim() === '') {
            continue;
        }
        var sid = String(s.subpart_id).trim();
        if (tried.has(sid)) {
            continue;
        }
        tried.add(sid);
        var entries = await fetchVideoDataEntriesForSubpart(sid, true);
        if (!entries) {
            continue;
        }
        var sec = secondFromVideoDataEntries(entries, startAtId);
        if (sec !== null) {
            return { stream: s, startSeconds: sec };
        }
    }
    displayError('Could not find which part matches this start_at id.');
    return null;
}

async function handlePlayerRedirect(parsedUrl, response, originalUrl, playerPath) {
    if (parsedUrl.type === 'A') {
        var streamsA = response && response.streams;
        if (!Array.isArray(streamsA) || streamsA.length === 0) {
            displayError('Player data did not include a stream.');
            return;
        }

        var hasSubpart = parsedUrl.subpartId != null && parsedUrl.subpartId !== '';
        var hasStartAt = parsedUrl.startAtId != null && parsedUrl.startAtId !== '';

        var streamA;
        var startSecondsA;

        if (hasSubpart) {
            streamA = pickStreamFromStreams(streamsA, parsedUrl.subpartId);
            if (!streamA || !streamA.playlistfile) {
                displayError('No stream matched the requested part (#' + parsedUrl.subpartId + ').');
                return;
            }
            if (hasStartAt) {
                var resolvedKnown = await resolveStartSecondsForTypeA(streamA, parsedUrl.startAtId);
                if (resolvedKnown === null) {
                    return;
                }
                startSecondsA = resolvedKnown;
            }
        } else if (hasStartAt) {
            var found = await findStreamByStartAtAcrossStreams(streamsA, parsedUrl.startAtId);
            if (!found) {
                return;
            }
            streamA = found.stream;
            startSecondsA = found.startSeconds;
        } else {
            streamA = streamsA[0];
            if (!streamA || !streamA.playlistfile) {
                displayError('Player data did not include a stream.');
                return;
            }
        }

        navigateToPlayer(streamA.playlistfile, startSecondsA, originalUrl, playerPath);
    } else if (parsedUrl.type === 'C') {
        var streamsC = response && response.streams;
        if (!Array.isArray(streamsC) || streamsC.length === 0 || !streamsC[0] || !streamsC[0].playlistfile) {
            displayError('Player data did not include a stream.');
            return;
        }
        navigateToPlayer(streamsC[0].playlistfile, undefined, originalUrl, playerPath);
    } else if (parsedUrl.type === 'B') {
        try {
            if (!response || response.playlist == null) {
                displayError('Player data did not include a playlist.');
                return;
            }
            var playlist = typeof response.playlist === 'string' ? JSON.parse(response.playlist) : response.playlist;
            var entry = playlist && playlist[parsedUrl.videoNum];
            var streamUrl = entry && entry.stream_url;
            if (!streamUrl) {
                displayError('That horse video index was not found in the playlist.');
                return;
            }
            navigateToPlayer(streamUrl, undefined, originalUrl, playerPath);
        } catch (error) {
            console.error('handlePlayerRedirect error:', error.message);
            displayError('Failed to parse response data.');
        }
    }
}

// ---------------------------------------------------------------------------
// Picker: browse an event's competitions, and a competition's horse/rider list,
// so a stream can be opened at the exact second a given competitor starts.
// ---------------------------------------------------------------------------

var formatClock = CMP.formatClock;

function resetPlayButtons() {
    $('#play-btn').prop('disabled', false);
    $('#play-exp-btn').prop('disabled', false);
}

// opts.onRemove, when given, adds a ✕ on every row that removes it in place (used by the
// history picker) instead of closing the modal.
function showPicker(title, rows, onPick, opts) {
    var onRemove = (opts && opts.onRemove) || null;
    var $list = $('#picker-list').empty();
    $('#picker-title').text(title);

    rows.forEach(function (row) {
        // A div rather than a button: rows may contain their own ✕ button, and nesting
        // buttons is invalid HTML.
        var $row = $('<div class="list-group-item list-group-item-action picker-row" role="button" tabindex="0">');
        $row.attr('data-search', ((row.main || '') + ' ' + (row.sub || '')).toLowerCase());

        var $top = $('<div class="d-flex justify-content-between align-items-center">');
        $top.append($('<span>').text(row.main));
        var $right = $('<span class="d-flex align-items-center ml-2 text-nowrap">');
        if (row.right) {
            $right.append($('<small class="text-muted">').text(row.right));
        }
        if (onRemove) {
            $right.append($('<button type="button" class="close ml-2 picker-remove" aria-label="Remove">')
                .append($('<span aria-hidden="true">').text('×'))
                .on('click', function (e) {
                    e.stopPropagation();
                    $row.remove();
                    onRemove(row);
                }));
        }
        $top.append($right);
        $row.append($top);
        if (row.sub) {
            $row.append($('<small class="text-muted d-block text-truncate">').text(row.sub));
        }
        $row.on('click', function () {
            $('#picker-modal').modal('hide');
            onPick(row);
        });
        $row.on('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                $row.trigger('click');
            }
        });
        $list.append($row);
    });

    var $filter = $('#picker-filter').val('');
    $filter.off('input').on('input', function () {
        var q = this.value.toLowerCase().trim();
        $list.children('.picker-row').each(function () {
            var hay = this.getAttribute('data-search') || '';
            this.style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
        });
    });

    // The picker replaces navigation, so the Play buttons must not stay stuck disabled.
    resetPlayButtons();
    $('#picker-modal').modal('show');
}

// ---------------------------------------------------------------------------
// URL history: every played link is kept locally so old events can be reopened
// without digging the link out of clipmyhorse again.
// ---------------------------------------------------------------------------

var HISTORY_KEY = 'm3u8-history';
var HISTORY_MAX = 30;

function loadHistory() {
    try {
        var raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
        return Array.isArray(raw) ? raw.filter(function (e) { return e && e.url; }) : [];
    } catch (e) {
        return [];
    }
}

function saveHistory(entries) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
    } catch (e) {
        console.warn('saveHistory', e);
    }
}

// Most recent first, one entry per URL: replaying an old link floats it back to the top.
function rememberUrl(url) {
    url = String(url || '').trim();
    if (!url) {
        return;
    }
    var entries = loadHistory().filter(function (e) { return e.url !== url; });
    entries.unshift({ url: url, ts: Date.now() });
    saveHistory(entries);
}

function forgetUrl(url) {
    saveHistory(loadHistory().filter(function (e) { return e.url !== url; }));
}

var HISTORY_KIND = { A: 'Competition', B: 'Horse', C: 'Live', D: 'Event' };

// Turns ".../events/19807/csi-3-vilamoura" into "Event · csi 3 vilamoura", falling back to
// the bare URL for anything unrecognised (direct m3u8 links included).
function historyLabel(url) {
    var parsed = parseCMPonyUrl(url);
    var kind = parsed ? HISTORY_KIND[parsed.type] : null;
    var slug = '';
    try {
        var segments = new URL(url).pathname.split('/').filter(Boolean);
        for (var i = segments.length - 1; i >= 0; i--) {
            if (/[a-z]/i.test(segments[i]) && segments[i].indexOf('.') === -1) {
                slug = decodeURIComponent(segments[i]).replace(/[-_]+/g, ' ');
                break;
            }
        }
    } catch (e) {
        /* not a parseable URL; fall through to the raw string */
    }
    if (kind && slug) {
        return kind + ' · ' + slug;
    }
    return kind || slug || url;
}

function timeAgo(ts) {
    var mins = Math.floor((Date.now() - (ts || 0)) / 60000);
    if (!Number.isFinite(mins) || mins < 1) {
        return 'just now';
    }
    if (mins < 60) {
        return mins + 'm ago';
    }
    var hours = Math.floor(mins / 60);
    if (hours < 24) {
        return hours + 'h ago';
    }
    var days = Math.floor(hours / 24);
    return days < 30 ? days + 'd ago' : new Date(ts).toLocaleDateString();
}

function showHistoryPicker(playerPath) {
    var entries = loadHistory();
    if (!entries.length) {
        displayError('No history yet — play a link first.');
        return;
    }

    var rows = entries.map(function (e) {
        return { main: historyLabel(e.url), sub: e.url, right: timeAgo(e.ts), url: e.url };
    });

    showPicker('Recent links', rows, function (row) {
        $('#m3u8-placeholder')[0].value = row.url;
        localStorage.setItem('m3u8-link', row.url);
        rememberUrl(row.url);
        browseAndPlay(row.url, playerPath);
    }, {
        onRemove: function (row) {
            forgetUrl(row.url);
        }
    });
}

// Each subpart is a separate video with its own m3u8 and its own videodata list, so a
// competitor row has to carry the playlist it belongs to alongside its offset.
async function buildCompetitorRows(response) {
    var subparts = Array.isArray(response && response.subparts) ? response.subparts.slice() : [];
    var streams = (response && response.streams) || [];
    if (!subparts.length) {
        return [];
    }
    subparts.sort(function (a, b) {
        return (a.subpart_display_order || 0) - (b.subpart_display_order || 0);
    });

    var multipart = subparts.length > 1;
    var lists = await Promise.all(subparts.map(function (sp) {
        return fetchVideoDataEntriesForSubpart(String(sp.subpart_id), true);
    }));

    var rows = [];
    subparts.forEach(function (sp, idx) {
        var entries = lists[idx];
        var stream = pickStreamFromStreams(streams, sp.subpart_id);
        if (!Array.isArray(entries) || !stream || !stream.playlistfile) {
            return;
        }
        entries.forEach(function (e) {
            if (!e || e.type !== 'COMPETITOR') {
                return;
            }
            var sec = typeof e.second === 'number' ? e.second : parseFloat(String(e.second));
            if (!Number.isFinite(sec) || sec < 0) {
                return;
            }
            var horse = (e.horse && e.horse.name && e.horse.name.sport) || 'Unknown horse';
            var rider = (e.rider && e.rider.name) || 'Unknown rider';
            var partLabel = sp.subpart_title || ('Part ' + (idx + 1));
            rows.push({
                main: (e.headnumber ? '#' + e.headnumber + '  ' : '') + horse,
                sub: rider + (multipart ? '  •  ' + partLabel : ''),
                right: formatClock(sec),
                playlistfile: stream.playlistfile,
                seconds: sec
            });
        });
    });
    return rows;
}

// Event overview pages list every competition as a <cmh-list-item href=".../competition/<id>/...">
// whose <template> slots hold the title and an epoch timestamp.
function parseCompetitionsFromEventHtml(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var rows = [];

    doc.querySelectorAll('cmh-list-item[href*="/competition/"]').forEach(function (item) {
        var href = item.getAttribute('href');
        if (!href) {
            return;
        }

        var title = '';
        var epoch = null;
        item.querySelectorAll('template').forEach(function (tpl) {
            if (!tpl.content) {
                return;
            }
            var dt = tpl.content.querySelector('local-date-time[timestamp]');
            if (dt && epoch === null) {
                var parsedEpoch = parseInt(dt.getAttribute('timestamp'), 10);
                epoch = Number.isFinite(parsedEpoch) ? parsedEpoch : null;
            }
            // Drop the date block and the action buttons so only the competition name is left.
            var clone = tpl.content.cloneNode(true);
            clone.querySelectorAll('.competition-date, cmh-button').forEach(function (n) { n.remove(); });
            title += ' ' + clone.textContent;
        });

        title = title.replace(/\s+/g, ' ').trim();
        rows.push({
            main: title || href,
            right: epoch ? new Date(epoch * 1000).toLocaleString() : '',
            url: href.indexOf('http') === 0 ? href : 'https://www.clipmyhorse.tv' + href
        });
    });

    return rows;
}

async function playFromParsed(parsedUrl, originalUrl, playerPath) {
    var playerdataUrl = playerdataUrlForParsed(parsedUrl);
    if (!playerdataUrl) {
        displayError('Unknown URL type');
        return;
    }
    var response = await doFetchWithCors(playerdataUrl);
    if (!response) {
        return;
    }
    await handlePlayerRedirect(parsedUrl, response, originalUrl, playerPath);
}

// Entry point for the Play buttons: offers a picker when the URL points at something
// browsable (an event's competitions, a competition's competitors) and otherwise falls
// straight through to the existing resolve-and-navigate path.
async function browseAndPlay(url, playerPath) {
    var parsedUrl = parseCMPonyUrl(url);
    if (!parsedUrl) {
        return fetchPlayerData(url, playerPath);
    }

    if (parsedUrl.type === 'D') {
        var html = await doFetchRawWithCors(url, true);
        if (!html) {
            displayError('Could not load the event page. Check your connection or try again.');
            return;
        }

        var picks = [];
        var dataPathMatch = html.match(/<cmh-video-player-live[^>]*\bdata-path="([^"]+)"/);
        var idsMatch = dataPathMatch && dataPathMatch[1].match(/playerdata\/(\d+)\/(\d+)/);
        if (idsMatch) {
            picks.push({ main: '🔴  Watch live', sub: 'Live arena stream', kind: 'live', channelId: idsMatch[2] });
        }
        picks = picks.concat(parseCompetitionsFromEventHtml(html));

        if (!picks.length) {
            displayError('No live stream or competitions found on this event page.');
            return;
        }

        showPicker('Competitions', picks, function (row) {
            if (row.kind === 'live') {
                playFromParsed({ type: 'C', eventId: '14178', event_channel_id: row.channelId }, url, playerPath);
            } else {
                browseAndPlay(row.url, playerPath);
            }
        });
        return;
    }

    if (parsedUrl.type === 'A') {
        var playerdataUrl = playerdataUrlForParsed(parsedUrl);
        var response = await doFetchWithCors(playerdataUrl);
        if (!response) {
            return;
        }

        var rows = await buildCompetitorRows(response);
        if (!rows.length) {
            // No horse/rider timeline for this competition; behave exactly as before.
            return handlePlayerRedirect(parsedUrl, response, url, playerPath);
        }

        var competitorPicks = [{ main: '▶  Start from the beginning', kind: 'start' }].concat(rows);
        showPicker(response.competition_title || 'Pick a horse / rider', competitorPicks, function (row) {
            if (row.kind === 'start') {
                handlePlayerRedirect(parsedUrl, response, url, playerPath);
            } else {
                navigateToPlayer(row.playlistfile, row.seconds, url, playerPath);
            }
        });
        return;
    }

    return fetchPlayerData(url, playerPath);
}

// Helper to display error messages and re-enable the play buttons
function displayError(message) {
    console.warn("fetchPlayerData", message);
    var msgEl = document.getElementById('alert-message');
    if (msgEl) {
        msgEl.textContent = message;
    }
    document.getElementById('alert-box').style.display = 'block';
    resetPlayButtons();
}

$(window).on('load', function () {
    $('#m3u8-placeholder')[0].value = localStorage.getItem('m3u8-link') || '';
    $('#play-btn').prop('disabled', false);
    $('#paste-btn').on('click', async function () {
        try {
            const clipboardText = await navigator.clipboard.readText();
            document.getElementById('m3u8-placeholder').value = clipboardText;
            localStorage.setItem('m3u8-link', clipboardText);
        } catch (err) {
            console.error('Failed to read clipboard contents: ', err);
        }
    });
    $('#play-btn').on('click', function () {
        document.getElementById('alert-box').style.display = 'none';
        $('#play-btn').prop('disabled', true);
        localStorage.setItem('m3u8-link', $('#m3u8-placeholder')[0].value);
        rememberUrl($('#m3u8-placeholder')[0].value);
        browseAndPlay($('#m3u8-placeholder')[0].value);
    });
    $('#play-exp-btn').on('click', function () {
        document.getElementById('alert-box').style.display = 'none';
        $('#play-exp-btn').prop('disabled', true);
        localStorage.setItem('m3u8-link', $('#m3u8-placeholder')[0].value);
        rememberUrl($('#m3u8-placeholder')[0].value);
        browseAndPlay($('#m3u8-placeholder')[0].value, './player-experimental/');
    });
    $('#history-btn').on('click', function () {
        document.getElementById('alert-box').style.display = 'none';
        showHistoryPicker();
    });

    // Only meaningful once CI has substituted a real sha into it.
    var stamp = document.getElementById('build-stamp');
    if (stamp && stamp.textContent.indexOf('__BUILD__') !== -1) {
        stamp.style.display = 'none';
    }

    // The player page's home button returns here as ?u=<original url> so the
    // same event/competition can be reopened and a different entry picked.
    var returnUrl = new URLSearchParams(window.location.search).get('u');
    if (returnUrl) {
        $('#m3u8-placeholder')[0].value = returnUrl;
        localStorage.setItem('m3u8-link', returnUrl);
        rememberUrl(returnUrl);
        history.replaceState(null, '', window.location.pathname);
        browseAndPlay(returnUrl);
    }
});

/*
Test the function with an example URL
const testUrlA = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
fetchPlayerData(testUrlA);
start_at is a videodata entry id; seconds come from https://d3j92f3aek4h9x.cloudfront.net/en/us/videodata/{subpart_id}
// Test with Type A, Type B, and Type C URLs
const urlA(archive) = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
const urlAWithStart(archive) = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802?start_at=10690213';
const urlB(horse) = 'https://www.clipmyhorse.tv/pt_BR/horse/9a3ab1ad-6ae0-42fb-b2e7-7c69b806584c#65';
const urlC(live) = 'https://www.clipmyhorse.tv/en_US/live/19395/international-24-7-clipmyhorse-tv-global-highlights-from-sport-breeding-academy-and-entertainment';
*/
