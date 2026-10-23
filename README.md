# m3u8-player
M3U8 Player in browser. Play any live stream m3u8 link with this webapp at https://bharadwajpro.github.io/m3u8-player

I created this website because VLC is unstable in playing live streams. It buffers a lot.

If you want to extract m3u8 files from live streams. You can use `youtube-dl -F <video-url>` to display all formats available
and then type `youtube-dl -f <itag> -g <video-url>` for the direct link. Paste it in the website mentioned above and play it.
If it doesn't work, then raise an issue.
  
If you want live streams legally then visit this repo - https://github.com/notanewbie/LegalStream

This website is tested on Google Chrome and Firefox desktop web browsers. Not tested on android and iOS. Raise an issue if it doesn't work.
## Player

`player/` plays with a plain `<video>` by default (hls.js where the browser has MSE but no native
HLS), with double-tap on the left/right third (±10s) and keys: space/`k` play-pause, arrows seek
5s / volume, `f` fullscreen, `m` mute.

The 🎞️ header button switches to [movi-player](https://github.com/mrujjwalg/movi-player)
(`<movi-player>`, WebCodecs + FFmpeg-WASM; HLS through its bundled Shaka). Its controls, keys and
gestures are movi-player's own (`fastseek`: arrows and double-tap seek ±10s). The choice is
remembered in `localStorage`. WebCodecs needs a secure context: HTTPS or `localhost` (not a LAN IP
over plain HTTP). If movi-player errors before the stream opens, or the browser has no WebCodecs
and no MSE, the page falls back to the plain player.

The rest of the site is plain static JS. The player page is TypeScript (`player/src/player.ts`),
bundled by esbuild with code splitting into `player/player.js` plus lazy chunks (movi-player,
hls.js), and `movi.wasm` is copied next to it. None are committed; CI builds them on deploy.
To run locally:
```
npm install
npm run typecheck:player   # tsc --noEmit
npm run build:player       # writes player/player.js, player/chunk-*.js, player/movi.wasm
```
then serve the repo root with any static server (e.g. `python3 -m http.server 8080`).

## Known issues
* The page is served over `https`. So if the stream url is not `https` but `http`, the browser may throw a warning. The content fails to load. Disable web security in Chrome to get around this.
* CORS issue - If the media server blocks other IPs saying CORS. You might have to install this chrome extension to get around this - https://chrome.google.com/webstore/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf
