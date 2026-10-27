const booleans = new Set([
    'adBlocker',
    'proxyEnabled',
    'lastFmEnabled',
    'webhookEnabled',
    'displayWhenIdling',
    'displaySCSmallIcon',
    'discordRichPresence',
    'displayButtons',
    'minimizeToTray',
    'navigationControlsEnabled',
    'trackParserEnabled',
    'richPresencePreviewEnabled',
    'hidePromotions',
    'hideEventsNearYou',
    'hideArtistUpsells',
]);
const strings = new Set([
    'proxyHost',
    'proxyPort',
    'proxyUser',
    'proxyPassword',
    'lastFmApiKey',
    'lastFmSecret',
    'lastFmSessionKey',
    'webhookUrl',
    'customTheme',
]);
export function validSetting(data: unknown): data is { key: string; value: unknown } {
    if (!data || typeof data !== 'object') return false;
    const { key, value } = data as Record<string, unknown>;
    if (typeof key !== 'string') return false;
    if (booleans.has(key)) return typeof value === 'boolean';
    if (key === 'proxyData') {
        if (!value || typeof value !== 'object') return false;
        const credentials = value as Record<string, unknown>;
        return ['user', 'password'].every(
            (field) => typeof credentials[field] === 'string' && (credentials[field] as string).length <= 4096,
        );
    }
    if (strings.has(key)) return typeof value === 'string' && value.length <= 4096;
    if (key === 'theme') return value === 'dark' || value === 'light';
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (key === 'uiScale') return value >= 0.5 && value <= 3;
    if (key === 'webhookTriggerPercentage') return value >= 0 && value <= 100;
    return key === 'statusDisplayType' && Number.isInteger(value) && value >= 0 && value <= 2;
}
