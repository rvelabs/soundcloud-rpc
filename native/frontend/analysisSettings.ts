import { invoke } from './bridge';

export function installAnalysisSettings(ru: boolean): void {
    const text = (russian: string, english: string) => (ru ? russian : english);
    const panel = document.createElement('section');
    panel.className = 'settings-section';
    panel.dataset.pane = 'client';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.textContent = text('Обучение «Моей волны»', 'My Wave learning');
    const description = document.createElement('p');
    description.textContent = text(
        'Сброс удалит локальный аудиоанализ, историю обучения и кэш рекомендаций текущего аккаунта. Лайки, плейлисты в SoundCloud и выбранные настройки сохранятся. Лайки будут загружены заново. Счётчик прослушиваний начнёт отсчёт заново. Сохраняется резервная копия предыдущего обучения.',
        'Reset clears local audio analysis, learning history and recommendation cache for this account. Your SoundCloud likes, playlists and selected settings stay intact. Likes will be loaded again. The listening counter starts over. A backup of the previous learning is saved.',
    );
    const open = document.createElement('button');
    open.id = 'native-analysis-reset';
    open.type = 'button';
    open.textContent = text('Сбросить анализ и обучение', 'Reset analysis and learning');
    const confirmation = document.createElement('div');
    confirmation.id = 'native-analysis-confirmation';
    confirmation.hidden = true;
    const warning = document.createElement('p');
    warning.textContent = text(
        'SoundCloud перезапустится, текущая музыка остановится. Очистить обучение этого аккаунта?',
        'SoundCloud will restart and current playback will stop. Clear learning for this account?',
    );
    const confirm = document.createElement('button');
    confirm.id = 'native-analysis-confirm';
    confirm.type = 'button';
    confirm.textContent = text('Очистить и перезапустить', 'Clear and restart');
    const cancel = document.createElement('button');
    cancel.id = 'native-analysis-cancel';
    cancel.type = 'button';
    cancel.textContent = text('Отмена', 'Cancel');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    open.onclick = () => {
        open.hidden = true;
        confirmation.hidden = false;
        cancel.focus();
    };
    cancel.onclick = () => {
        confirmation.hidden = true;
        open.hidden = false;
        open.focus();
    };
    confirm.onclick = async () => {
        confirm.disabled = cancel.disabled = true;
        status.textContent = text('Сохраняем резервную копию и очищаем обучение…', 'Backing up and clearing learning…');
        try {
            await invoke('analysis_reset');
        } catch (error) {
            status.textContent = text('Сброс не завершён: ', 'Reset did not complete: ') + String(error);
            confirm.disabled = cancel.disabled = false;
        }
    };
    confirmation.append(warning, confirm, cancel);
    panel.append(heading, description, open, confirmation, status);
    document.body.append(panel);
}
