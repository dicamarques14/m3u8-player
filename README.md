# m3u8-player
M3U8 Player in browser. Play any live stream m3u8 link with this webapp at https://bharadwajpro.github.io/m3u8-player

I created this website because VLC is unstable in playing live streams. It buffers a lot.

If you want to extract m3u8 files from live streams. You can use `youtube-dl -F <video-url>` to display all formats available
and then type `youtube-dl -f <itag> -g <video-url>` for the direct link. Paste it in the website mentioned above and play it.
If it doesn't work, then raise an issue.
  
If you want live streams legally then visit this repo - https://github.com/notanewbie/LegalStream

This website is tested on Google Chrome and Firefox desktop web browsers. Not tested on android and iOS. Raise an issue if it doesn't work.
## Player

`player/` is a [movi-player](https://github.com/mrujjwalg/movi-player) (`<movi-player>`, WebCodecs +
FFmpeg-WASM; HLS through its bundled Shaka). Its controls, keyboard shortcuts and gestures are
movi-player's own; the page enables `fastseek` (arrow keys and double-tap on the left/right third
seek ±10s).
WebCodecs needs a secure context: HTTPS or `localhost` (not a LAN IP over plain HTTP).
Last resort: if movi-player errors before the stream opens (or the browser has no WebCodecs and
no MSE), the page swaps in a plain `<video>`, using hls.js where the browser lacks native HLS.

The rest of the site is plain static JS. The player page is TypeScript (`player/src/player.ts`),
bundled with esbuild into `player/player.js`, and `movi.wasm` is copied next to it. Neither is
committed; CI builds them on deploy. To run locally:
```
npm install
npm run typecheck:player   # tsc --noEmit
npm run build:player       # writes player/player.js and player/movi.wasm
```
then serve the repo root with any static server (e.g. `python3 -m http.server 8080`).

## Known issues
* The page is served over `https`. So if the stream url is not `https` but `http`, the browser may throw a warning. The content fails to load. Disable web security in Chrome to get around this.
* CORS issue - If the media server blocks other IPs saying CORS. You might have to install this chrome extension to get around this - https://chrome.google.com/webstore/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf
