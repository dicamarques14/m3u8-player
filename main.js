function parseCMPonyUrl(url) {
    const clipMPonyRegex = /^https:\/\/www\.clipmyhorse\.tv\/[a-z]{2}_[A-Z]{2}\/(ondemand|horse|live)\/(.+)/;

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
    const typeCRegex = /\/live\/(\d+)\/.+/;

    let result = {};

    if (typeAPathRegex.test(url)) {
        const [, eventId, competition] = url.match(typeAPathRegex);
        result = {
            type: 'A',
            eventId,
            competition
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
        const [, eventId] = url.match(typeCRegex);
        result = {
            type: 'C',
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

function navigateToPlayer(playlistUrl, startSeconds) {
    var encoded = encodeURIComponent(playlistUrl);
    var href = './player/#' + encoded;
    if (typeof startSeconds === 'number' && Number.isFinite(startSeconds) && startSeconds >= 0) {
        href = './player/?t=' + encodeURIComponent(String(startSeconds)) + '#' + encoded;
    }
    window.location.href = href;
}

async function fetchPlayerData(url) {
    const parsedUrl = parseCMPonyUrl(url);

    if (!parsedUrl) {
        displayError('Invalid URL or unable to parse the URL, will try m3u8 link.');
        window.location.href = './player/#' + encodeURIComponent(url);
        return;
    }

    let playerdataUrl = '';

    // Determine playerdata URL based on the type
    switch (parsedUrl.type) {
        case 'A':
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/archive/playerdata/${parsedUrl.eventId}/${parsedUrl.competition}`;
            break;
        case 'B':
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/playlist/playerdata/${parsedUrl.horse}`;
            break;
        case 'C':
            playerdataUrl = `https://www.clipmyhorse.tv/en_US/live/playerdata/14178/${parsedUrl.eventId}`;
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
        await handlePlayerRedirect(parsedUrl, response);
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

async function handlePlayerRedirect(parsedUrl, response) {
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

        navigateToPlayer(streamA.playlistfile, startSecondsA);
    } else if (parsedUrl.type === 'C') {
        var streamsC = response && response.streams;
        if (!Array.isArray(streamsC) || streamsC.length === 0 || !streamsC[0] || !streamsC[0].playlistfile) {
            displayError('Player data did not include a stream.');
            return;
        }
        navigateToPlayer(streamsC[0].playlistfile);
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
            navigateToPlayer(streamUrl);
        } catch (error) {
            console.error('handlePlayerRedirect error:', error.message);
            displayError('Failed to parse response data.');
        }
    }
}

// Helper to display error messages and re-enable the play button
function displayError(message) {
    console.warn("fetchPlayerData", message);
    var msgEl = document.getElementById('alert-message');
    if (msgEl) {
        msgEl.textContent = message;
    }
    document.getElementById('alert-box').style.display = 'block';
    $('#play-btn').prop('disabled', false);
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
