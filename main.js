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

    // Determine playerdata URL based on the type
    switch (parsedUrl.type) {
        case 'A':
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/archive/playerdata/${parsedUrl.eventId}/${parsedUrl.event_channel_id}`;
            break;
        case 'B':
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/playlist/playerdata/${parsedUrl.horse}`;
            break;
        case 'C':
            //<any_valid_event_ID>/event_channel_id
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/live/playerdata/14178/${parsedUrl.event_channel_id}`;
            break;
        default:
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

// Helper to display error messages and re-enable the play buttons
function displayError(message) {
    console.warn("fetchPlayerData", message);
    var msgEl = document.getElementById('alert-message');
    if (msgEl) {
        msgEl.textContent = message;
    }
    document.getElementById('alert-box').style.display = 'block';
    $('#play-btn').prop('disabled', false);
    $('#play-exp-btn').prop('disabled', false);
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
        fetchPlayerData($('#m3u8-placeholder')[0].value);
    });
    $('#play-exp-btn').on('click', function () {
        document.getElementById('alert-box').style.display = 'none';
        $('#play-exp-btn').prop('disabled', true);
        localStorage.setItem('m3u8-link', $('#m3u8-placeholder')[0].value);
        fetchPlayerData($('#m3u8-placeholder')[0].value, './player-experimental/');
    });
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
