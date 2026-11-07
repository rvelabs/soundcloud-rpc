export function playbackRate(): number {
    try {
        const rate =
            (
                window as unknown as { __scrpcPlaybackSpeedApi?: { getRate: () => number } }
            ).__scrpcPlaybackSpeedApi?.getRate() ?? 1;
        return Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? rate : 1;
    } catch {
        return 1;
    }
}
