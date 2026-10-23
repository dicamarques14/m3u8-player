// Ambient type for the CMP global defined by ../../shared/link-params.js, loaded as a classic
// <script> before this module so every page shares one definition of the link shape.
interface CMPGlobal {
    parseM3u8FromHash(): string | undefined;
    startSecondsFromQuery(): number | undefined;
    originalUrlFromQuery(): string | null;
    atEpochFromQuery(): number | undefined;
    formatTimeParam(seconds: number): string | null;
    formatClock(totalSeconds: number): string;
}

declare const CMP: CMPGlobal;
