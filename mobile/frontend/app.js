const status = document.getElementById('status');
const buttons = [...document.querySelectorAll('[data-action]')];
const invoke = (action) => window.__TAURI_INTERNALS__.invoke('android_action', { action });
const statusText = (state) => {
    if (!state?.count) return 'Плеер остановлен';
    if (state.error) return state.error;
    const phase = state.ended ? 'Очередь закончилась' : state.playing ? 'Играет' : 'Пауза';
    return `${phase} · ${state.index + 1}/${state.count} · ${state.title}`;
};
let pending = false;
async function update(action) {
    if (pending) return;
    pending = true;
    try {
        const result = await invoke(action);
        if (action === 'openCatalog') return;
        const next = statusText(result);
        if (status.textContent !== next) status.textContent = next;
        buttons.forEach((button) => {
            button.disabled = !result?.count;
        });
    } catch (error) {
        status.textContent = String(error);
    } finally {
        pending = false;
    }
}
document.getElementById('catalog').addEventListener('click', () => void update('openCatalog'));
document.getElementById('start').addEventListener('click', () => void update('startFixture'));
buttons.forEach((button) => button.addEventListener('click', () => void update(button.dataset.action)));
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void update('status');
});
window.setInterval(() => {
    if (!document.hidden) void update('status');
}, 1000);
void update('status');
