function parseClipMyHorseUrl(url) {
    const clipMyHorseRegex = /^https:\/\/www\.clipmyhorse\.tv\/[a-z]{2}_[A-Z]{2}\/(ondemand|horse|live)\/(.+)/;

    // Check if it's a valid ClipMyHorse URL
    const isValidClipMyHorseUrl = clipMyHorseRegex.test(url);
    if (!isValidClipMyHorseUrl) {
        console.warn("parseClipMyHorseUrl", 'Invalid URL for ClipMyHorse');
        return null;
    }

    // Type A URL regex (with optional query parameter after the question mark)
    const typeARegex = /\/event\/(\d+)\/competition\/(\d+)(\?start_at=\d+)?/;

    // Type B URL regex
    const typeBRegex = /\/horse\/([a-z0-9\-]+)#(\d+)/;

    // Type C URL regex (live event)
    const typeCRegex = /\/live\/(\d+)\/.+/;

    let result = {};

    if (typeARegex.test(url)) {
        // Extract eventId and competition for Type A URL
        const [, eventId, competition] = url.match(typeARegex);
        result = {
            type: 'A',
            eventId,
            competition
        };
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
        console.warn("parseClipMyHorseUrl", 'URL does not match any recognized format');
        return null;
    }

    return result;
}

async function doFetchWithCors(url) {
    try {
        return await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`)
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
        document.getElementById('alert-box').style.display = 'block';
        $('#play-btn').prop('disabled', false);
    }
}
async function fetchPlayerData(url) {
    const parsedUrl = parseClipMyHorseUrl(url);

    if (!parsedUrl) {
        displayError('Invalid URL or unable to parse the URL, will try m3u8 link.');
        window.location.href = './player/' + '#' + url;
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
        if (response) {
            handlePlayerRedirect(parsedUrl, response);
        } else {
            throw new Error('Invalid response data');
        }
    } catch (error) {
        console.error('fetchPlayerData error:', error.message);
        displayError('Failed to fetch player data.');
    }
}

// Helper to handle redirection based on parsed URL type
function handlePlayerRedirect(parsedUrl, response) {
    if (parsedUrl.type === 'A' || parsedUrl.type === 'C') {
        window.location.href = './player/' + '#' + response["streams"][0]["playlistfile"];
    } else if (parsedUrl.type === 'B') {
        window.location.href = './player/' + '#' + playlist[parsedUrl.videoNum]["stream_url"];
    }
}

// Helper to display error messages and re-enable the play button
function displayError(message) {
    console.warn("fetchPlayerData", message);
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
// Test the function with an example URL
const testUrlA = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
fetchPlayerData(testUrlA);

// Test with Type A, Type B, and Type C URLs
const urlA = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
const urlAWithStart = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802?start_at=10690213';
const urlB = 'https://www.clipmyhorse.tv/pt_BR/horse/9a3ab1ad-6ae0-42fb-b2e7-7c69b806584c#65';
const urlC = 'https://www.clipmyhorse.tv/en_US/live/19395/international-24-7-clipmyhorse-tv-global-highlights-from-sport-breeding-academy-and-entertainment';
*/