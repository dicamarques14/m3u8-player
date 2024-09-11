function parseClipMyHorseUrl(url) {
    const clipMyHorseRegex = /^https:\/\/www\.clipmyhorse\.tv\/[a-z]{2}_[A-Z]{2}\/(ondemand|horse|live)\/(.+)/;

    // Check if it's a valid ClipMyHorse URL
    const isValidClipMyHorseUrl = clipMyHorseRegex.test(url);
    if (!isValidClipMyHorseUrl) {
        console.log('Invalid URL for ClipMyHorse');
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
        console.log('URL does not match any recognized format');
        return null;
    }

    return result;
}

async function fetchPlayerData(url) {
    const parsedUrl = parseClipMyHorseUrl(url);

    if (!parsedUrl) {
        console.log('Invalid URL or unable to parse the URL');
        return;
    }

    let playerdataUrl = '';

    // Build the playerdata URL based on the type
    if (parsedUrl.type === 'A') {
        playerdataUrl = `https://www.clipmyhorse.tv/en_US/archive/playerdata/${parsedUrl.eventId}/${parsedUrl.competition}`;
    } else if (parsedUrl.type === 'B') {
        playerdataUrl = `https://www.clipmyhorse.tv/en_US/playlist/playerdata/${parsedUrl.horse}`;
    } else if (parsedUrl.type === 'C') {
        playerdataUrl = `https://www.clipmyhorse.tv/en_US/live/playerdata/14178/${parsedUrl.eventId}`;
    } else {
        console.log('Unknown URL type');
        return;
    }

    try {

        const response = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(playerdataUrl)}`)
                    .then(response => {
                      if (response.ok) return response.json()
                      throw new Error('Network response was not ok.')
                    })
                    .then(data => {return data});

        const data = await response.json();
        console.log('Fetched data:', data);
        return data;
    } catch (error) {
        console.error('Error fetching playerdata:', error);
    }
}

/*
// Test the function with an example URL
const testUrlA = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
fetchPlayerData(testUrlA);



// Test with Type A, Type B, and Type C URLs
const urlA = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802';
const urlAWithStart = 'https://www.clipmyhorse.tv/en_US/ondemand/event/13934/competition/266802?start_at=10690213';
const urlB = 'https://www.clipmyhorse.tv/pt_BR/horse/9a3ab1ad-6ae0-42fb-b2e7-7c69b806584c#65';
const urlC = 'https://www.clipmyhorse.tv/en_US/live/19395/international-24-7-clipmyhorse-tv-global-highlights-from-sport-breeding-academy-and-entertainment';

console.log(parseClipMyHorseUrl(urlA));          // {type: 'A', eventId: '13934', competition: '266802'}
console.log(parseClipMyHorseUrl(urlAWithStart)); // {type: 'A', eventId: '13934', competition: '266802'}
console.log(parseClipMyHorseUrl(urlB));          // {type: 'B', horse: '9a3ab1ad-6ae0-42fb-b2e7-7c69b806584c', videoNum: '65'}
console.log(parseClipMyHorseUrl(urlC));          // {type: 'C', eventId: '19395'}
*/

$(window).on('load', function () {
    $('#m3u8-placeholder')[0].value = localStorage.getItem('m3u8-link') || '';
    $('#play-btn').on('click', function () {
        localStorage.setItem('m3u8-link', $('#m3u8-placeholder')[0].value);
        fetchPlayerData($('#m3u8-placeholder')[0].value);
        //window.location.href = './player' + '#' + $('#m3u8-placeholder')[0].value;
    });
});

