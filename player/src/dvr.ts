// DVR for a live stream: rebuild a VOD playlist from a wall-clock time up to now.
//
// The live playlist only lists the last ~50 s, but the CDN keeps every segment since the
// stream began, named "<seq>-<unix time>.m4s": the time is floor(t0 + seq * duration), with
// t0 the time of segment 0. Video segments are 10 s, so names are exact. Audio segments are
// 9.984 s and the live playlist gives each name only rounded down, which leaves t0 known
// to a second; calibrate() narrows it by asking the CDN which names exist. So from one live
// playlist any older segment's URL can be written down, and the player is handed a playlist
// made of those.

const LEAD_SECONDS = 8;

interface Anchor {
    seq: number;
    epoch: number;
    /** The unrounded time of segment 0: segment n is named floor(t0 + n * duration). */
    t0: number;
    duration: number;
    /** URL of a segment with its "<seq>-<epoch>.m4s" file name replaced by this prefix. */
    base: string;
    ext: string;
    mapUri: string | null;
    liveLastSeq: number;
}

const SEGMENT_RE = /^(.*\/)(\d+)-(\d+)(\.[a-z0-9]+)$/i;

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' for ' + url);
    }
    return res.text();
}

function absolute(uri: string, base: string): string {
    return new URL(uri, base).href;
}

function parseAnchor(text: string, playlistUrl: string): Anchor {
    const lines = text.split(/\r?\n/);
    let firstDuration = 0;
    let first: RegExpExecArray | null = null;
    let lastSeq = -1;
    let mapUri: string | null = null;
    let pendingDuration = 0;
    for (const line of lines) {
        const map = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line);
        if (map) {
            mapUri = absolute(map[1], playlistUrl);
        } else if (line.startsWith('#EXTINF:')) {
            pendingDuration = parseFloat(line.slice(8));
        } else if (line && !line.startsWith('#')) {
            const m = SEGMENT_RE.exec(absolute(line, playlistUrl));
            if (m) {
                if (!first) {
                    first = m;
                    firstDuration = pendingDuration;
                }
                lastSeq = Number(m[2]);
            }
        }
    }
    if (!first) {
        throw new Error('no "<seq>-<time>" segments in ' + playlistUrl);
    }
    const seq = Number(first[2]);
    const epoch = Number(first[3]);
    return {
        seq,
        epoch,
        // Only known to within a second until calibrate() has run: the name is the time
        // rounded down.
        t0: epoch - seq * firstDuration,
        duration: firstDuration,
        base: first[1],
        ext: first[4],
        mapUri,
        liveLastSeq: lastSeq
    };
}

function epochOf(a: Anchor, seq: number): number {
    return Math.floor(a.t0 + seq * a.duration);
}

async function segmentExists(url: string): Promise<boolean> {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
}

/**
 * Pin t0 down. With whole-second segments (video, 10 s) names are exact and nothing is
 * needed. With 9.984 s segments (audio) one live name only says t0 lies in a one-second
 * range, and the segments whose name falls on the wrong side of that range 404. Each probe
 * asks the CDN whether one such segment's name exists, which halves the range.
 */
async function calibrate(a: Anchor, firstSeq: number, lastSeq: number): Promise<void> {
    const d = a.duration;
    if (Number.isInteger(d)) {
        return;
    }
    let lo = a.epoch - a.seq * d;
    let hi = lo + 1;
    for (let i = 0; i < 16 && hi - lo > 0.002; i++) {
        const mid = (lo + hi) / 2;
        let bestSeq = -1;
        let bestName = 0;
        let bestDist = Infinity;
        for (let s = firstSeq; s <= lastSeq; s++) {
            // The first name above what t0's lower bound allows; it exists iff t0 is high enough.
            const name = Math.floor(lo + s * d) + 1;
            const boundary = name - s * d;
            if (boundary < hi && Math.abs(boundary - mid) < bestDist) {
                bestDist = Math.abs(boundary - mid);
                bestSeq = s;
                bestName = name;
            }
        }
        if (bestSeq < 0) {
            break;
        }
        const boundary = bestName - bestSeq * d;
        let exists: boolean;
        try {
            exists = await segmentExists(a.base + bestSeq + '-' + bestName + a.ext);
        } catch {
            break; // cannot ask: keep the middle of what is known
        }
        if (exists) {
            lo = Math.max(lo, boundary);
        } else {
            hi = Math.min(hi, boundary);
        }
    }
    a.t0 = (lo + hi) / 2;
}

function firstSeqFor(a: Anchor, startEpoch: number): number {
    const seq = Math.floor((startEpoch - LEAD_SECONDS - a.t0) / a.duration);
    return Math.max(0, Math.min(seq, a.liveLastSeq));
}

function isoOf(epoch: number): string {
    return new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
}

/** A VOD playlist from `startEpoch` (minus a lead-in) to the newest segment now listed. */
function buildVodPlaylist(a: Anchor, startEpoch: number): { text: string; firstEpoch: number } {
    const firstSeq = firstSeqFor(a, startEpoch);
    const out = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:' + Math.ceil(a.duration),
        '#EXT-X-MEDIA-SEQUENCE:' + firstSeq,
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXT-X-INDEPENDENT-SEGMENTS'
    ];
    if (a.mapUri) {
        out.push('#EXT-X-MAP:URI="' + a.mapUri + '"');
    }
    for (let seq = firstSeq; seq <= a.liveLastSeq; seq++) {
        const epoch = epochOf(a, seq);
        out.push('#EXT-X-PROGRAM-DATE-TIME:' + isoOf(epoch));
        out.push('#EXTINF:' + a.duration + ',');
        out.push(a.base + seq + '-' + epoch + a.ext);
    }
    out.push('#EXT-X-ENDLIST');
    return { text: out.join('\n') + '\n', firstEpoch: epochOf(a, firstSeq) };
}

function blobUrl(text: string): string {
    // The fragment keeps ".m3u8" in the URL for players that decide the format from it.
    return URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' })) + '#dvr.m3u8';
}

export interface Dvr {
    /** A master playlist (blob URL) covering startEpoch .. now. */
    masterUrl: string;
    /** Unix time of playlist position 0. */
    startEpoch: number;
}

/** `liveMasterUrl` is the live master playlist (as the index page resolved it). */
export async function buildDvr(liveMasterUrl: string, startEpoch: number): Promise<Dvr> {
    const masterText = await fetchText(liveMasterUrl);
    const lines = masterText.split(/\r?\n/);

    // Each variant / audio playlist URI in the master is replaced by a blob of its own DVR.
    const uris = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
        const media = /^#EXT-X-MEDIA:.*URI="([^"]+)"/.exec(lines[i]);
        if (media) {
            uris.add(media[1]);
        } else if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
            uris.add(lines[i + 1].trim());
        }
    }

    const replacements = new Map<string, string>();
    let firstEpoch = 0;
    await Promise.all(Array.from(uris).map(async (uri) => {
        const playlistUrl = absolute(uri, liveMasterUrl);
        // The live playlist for this rendition is fetched without the master's query: it is
        // the rendition's own address, and the master's token is for the master.
        const live = await fetchText(playlistUrl);
        const anchor = parseAnchor(live, playlistUrl);
        await calibrate(anchor, firstSeqFor(anchor, startEpoch), anchor.liveLastSeq);
        const vod = buildVodPlaylist(anchor, startEpoch);
        if (!firstEpoch || vod.firstEpoch < firstEpoch) {
            firstEpoch = vod.firstEpoch;
        }
        replacements.set(uri, blobUrl(vod.text));
    }));

    const master = lines.map((line) => {
        let out = line;
        replacements.forEach((blob, uri) => {
            if (line.trim() === uri) {
                out = blob;
            } else if (line.includes('URI="' + uri + '"')) {
                out = line.replace('URI="' + uri + '"', 'URI="' + blob + '"');
            }
        });
        return out;
    }).join('\n');

    return { masterUrl: blobUrl(master), startEpoch: firstEpoch || startEpoch };
}
