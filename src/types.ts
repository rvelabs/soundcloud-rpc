export interface TrackInfo {
    title: string;
    author: string;
    artwork: string;
    elapsed: string;
    duration: string;
    isPlaying: boolean;
    isLiked: boolean;
    url: string;
}
export interface LastFmTrackData {
    title: string;
    author: string;
    duration: string;
    elapsed: string;
}
export interface WebhookTrackData extends LastFmTrackData {
    url: string;
    artwork: string;
}
export interface ParsedTrackInfo {
    artist: string | null;
    track: string;
}
export interface NormalizedTrackInfo {
    artist: string;
    track: string;
}
export interface Translations {
    client: string;
    darkMode: string;
    adBlocker: string;
    enableAdBlocker: string;
    changesAppRestart: string;
    proxy: string;
    proxyHost: string;
    proxyPort: string;
    enableProxy: string;
    enableLastFm: string;
    lastfm: string;
    lastFmApiKey: string;
    lastFmApiSecret: string;
    createApiKeyLastFm: string;
    noCallbackUrl: string;
    webhooks: string;
    discord: string;
    enableWebhooks: string;
    webhookUrl: string;
    webhookTrigger: string;
    webhookDescription: string;
    showWebhookExample: string;
    enableRichPresence: string;
    displayWhenPaused: string;
    displaySmallIcon: string;
    displayButtons: string;
    useArtistInStatusLine: string;
    enableRichPresencePreview: string;
    richPresencePreview: string;
    richPresencePreviewDescription: string;
    applyChanges: string;
    minimizeToTray: string;
    enableNavigationControls: string;
    enableTrackParser: string;
    trackParserDescription: string;
    enableAutoUpdater: string;
    customThemes: string;
    selectCustomTheme: string;
    noTheme: string;
    openThemesFolder: string;
    refreshThemes: string;
    customThemeDescription: string;
    plugins: string;
    openPluginsFolder: string;
    refreshPlugins: string;
    pluginsDescription: string;
    noPluginsFound: string;
    pressF1ToOpenSettings: string;
    closeSettings: string;
    noActivityToShow: string;
    richPresencePreviewTitle: string;
    listenOnSoundcloud: string;
}
export type TrackUpdateReason = 'playback-state-change' | 'track-change' | 'seek-change' | 'initial-state';
export interface TrackUpdateMessage {
    data: TrackInfo;
    reason: TrackUpdateReason;
}
