export function invitation(hash) {
    const values = new URLSearchParams(hash.replace(/^#/, ''));
    const room = values.get('room'),
        invite = values.get('invite');
    if (
        [...values].length !== 2 ||
        !/^[A-Za-z0-9_-]{24}$/.test(room || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(invite || '')
    )
        return null;
    return `scwave://join?${new URLSearchParams({ room, invite })}`;
}
const labels = {
    ru: [
        'Приглашение послушать вместе',
        'Музыка объединяет.',
        'Откройте SoundCloud Desktop, чтобы слушать музыку вместе с другом — с общей сменой треков, паузами и перемоткой.',
        'Открыть SoundCloud',
        'Приложение ещё не установлено?',
        'Установите бесплатный клиент для Windows, войдите в SoundCloud и вернитесь к этому приглашению.',
        'Скачать для Windows ↗',
        'Браузер может запросить разрешение на открытие приложения. Каждый слушает музыку через свой аккаунт SoundCloud.',
        'Разрешите открыть приложение. Если ничего не произошло, установите новую версию клиента и нажмите кнопку ещё раз.',
        'Приглашение повреждено или неполное. Попросите отправить ссылку заново.',
    ],
    en: [
        'A shared listening session',
        'Music sounds better together.',
        'Open SoundCloud Desktop to follow your friend’s music, pauses and track changes.',
        'Open SoundCloud',
        'Don’t have the app yet?',
        'Install the free Windows app, sign in to SoundCloud, then return to this invitation.',
        'Download for Windows ↗',
        'Your browser may ask permission to open the app. Each listener plays music through their own SoundCloud account.',
        'Allow the browser to open the app. If nothing happens, install the latest client and try again.',
        'This invitation is incomplete or invalid. Ask your friend for a new link.',
    ],
    pt: [
        'Uma sessão para ouvir juntos',
        'A música fica melhor juntos.',
        'Abra o SoundCloud Desktop para acompanhar as músicas, pausas e mudanças de faixa do seu amigo.',
        'Abrir o SoundCloud',
        'Ainda não tem o aplicativo?',
        'Instale o aplicativo gratuito para Windows, entre no SoundCloud e volte a este convite.',
        'Baixar para Windows ↗',
        'Seu navegador pode pedir permissão para abrir o aplicativo. Cada pessoa ouve pelo próprio perfil do SoundCloud.',
        'Permita que o navegador abra o aplicativo. Se nada acontecer, instale a versão mais recente e tente novamente.',
        'Este convite está incompleto ou é inválido. Peça um novo link ao seu amigo.',
    ],
};
if (typeof document !== 'undefined') {
    const language = /^ru\b/i.test(navigator.language) ? 'ru' : /^pt\b/i.test(navigator.language) ? 'pt' : 'en';
    document.documentElement.lang = language === 'pt' ? 'pt-BR' : language;
    const text = labels[language];
    ['eyebrow', 'heading', 'description', 'open', 'install-heading', 'install-description', 'download', 'note'].forEach(
        (id, index) => {
            document.getElementById(id).textContent = text[index];
        },
    );
    const link = invitation(location.hash),
        open = document.getElementById('open'),
        status = document.getElementById('status');
    if (link) {
        open.href = link;
        open.onclick = () => {
            status.textContent = text[8];
        };
    } else {
        open.hidden = true;
        status.textContent = text[9];
    }
}
