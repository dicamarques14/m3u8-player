// Ambient type for the CMP global defined by ../../shared/link-params.js, loaded as a classic
// <script> before this module so both players share one definition of the link shape.
interface CMPGlobal {
    parseM3u8FromHash(): string | undefined;
    startSecondsFromQuery(): number | undefined;
    originalUrlFromQuery(): string | null;
    formatTimeParam(seconds: number): string | null;
    formatClock(totalSeconds: number): string;
}

declare const CMP: CMPGlobal;
