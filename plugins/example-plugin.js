/**
 * @name example-plugin
 * @author your-name
 * @version 1.0.0
 * @description Plugin description
 * @license MIT
 * @homepage https://github.com/yourname/example-plugin
 */
module.exports = {
    onEnable() {
        console.log('Plugin enabled');
    },
    onDisable() {
        console.log('Plugin disabled');
    },
    onTrackChange(track) {
        if (track.isPlaying) {
            console.log(`Now playing: ${track.title} by ${track.author}`);
        }
    },
    onThemeChange(isDark) {
        console.log(`Theme changed to ${isDark ? 'dark' : 'light'}`);
    },
    contentScript() {
        return `
            (function() {
                if (window.__examplePluginLoaded) return;
                window.__examplePluginLoaded = true;

                console.log('[example-plugin] Content script running on SoundCloud page');
                var observer = new MutationObserver(function() {
                });
                observer.observe(document.body, { childList: true, subtree: true });
                window.__scrpc_cleanup_example_plugin = function() {
                    observer.disconnect();
                    delete window.__examplePluginLoaded;
                    console.log('[example-plugin] Cleaned up');
                };
            })();
        `;
    },
};
