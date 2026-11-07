import { invoke } from './bridge';
import type { Preferences } from './clientPreferences';
export async function checkSettings(): Promise<void> {
    const checks: string[] = [];
    const assert = (ok: unknown, message: string) => {
        if (!ok) throw Error(message);
    };
    try {
        assert(!document.getElementById('settings-error')?.textContent, 'all settings modules initialized');
        assert(
            !/native preview|rust\s*\+\s*webview2/i.test(document.querySelector('header')?.textContent || ''),
            'settings header uses the SoundCloud name',
        );
        assert(
            !document.getElementById('badge') && !document.getElementById('intro'),
            'technical preview labels are removed',
        );
        checks.push('soundcloud-settings-branding');
        const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-pane-target]')];
        assert(tabs.length === 4, 'four settings sections');
        for (const tab of tabs) {
            tab.click();
            const visible = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter((panel) => !panel.hidden);
            assert(visible.length > 0, 'selected section has content');
            assert(
                visible.every((panel) => panel.dataset.pane === tab.dataset.paneTarget),
                'unselected sections are hidden',
            );
        }
        checks.push('settings-sections-layout');
        const preferences = await invoke<Preferences>('client_options');
        const saved = await invoke<Preferences>('client_options', {
            options: { ...preferences, zoom: 1.05, minimizeToTray: false },
        });
        assert(saved.zoom === 1.05 && !saved.minimizeToTray, 'native preferences persist');
        await invoke('client_options', { options: preferences });
        checks.push('client-preferences-roundtrip');
        const integrations = await invoke<Record<string, unknown>>('listening_options');
        assert(
            !('apiSecret' in integrations) && !('sessionKey' in integrations) && !('webhookUrl' in integrations),
            'integration secrets are not returned',
        );
        checks.push('local-integrations-secret-boundary');
        const plugins = await invoke<{ files: Array<{ id: string; enabled: boolean }> }>('extensions_action', {
            action: 'refresh',
        });
        assert(
            plugins.files.some((file) => file.id === 'playback-speed'),
            'bundled plugin discovered',
        );
        const enabled = await invoke<typeof plugins>('extensions_action', {
            action: 'toggle',
            id: 'playback-speed',
            enabled: true,
        });
        assert(
            enabled.files.some((file) => file.id === 'playback-speed' && file.enabled),
            'plugin enabled in Rust sandbox',
        );
        const disabled = await invoke<typeof plugins>('extensions_action', {
            action: 'toggle',
            id: 'playback-speed',
            enabled: false,
        });
        assert(
            disabled.files.every((file) => !file.enabled),
            'plugin stopped',
        );
        checks.push('settings-plugin-lifecycle');
        const update = await invoke<{ currentVersion: string }>('updates_options');
        assert(/^\d+\.\d+\.\d+$/.test(update.currentVersion), 'Native update channel version');
        checks.push('native-update-settings');
        await invoke('settings_test_result', { report: { success: true, checks } });
    } catch (error) {
        await invoke('settings_test_result', { report: { success: false, message: String(error), checks } });
    }
}
