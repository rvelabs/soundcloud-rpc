import type { UpdateState } from './updateController';
export function presentUpdate(state: UpdateState, russian: boolean) {
    const labels = russian
        ? {
              title: 'Обновления SoundCloud',
              mode: 'Режим обновления',
              patch: 'Автоматически: небольшие исправления',
              notify: 'Только уведомлять',
              off: 'Не проверять автоматически',
              check: 'Проверить сейчас',
              download: 'Скачать обновление',
              install: 'Перезапустить и установить',
              notes: 'Что нового',
              worker: 'Worker обновлён',
              description:
                  'Исправления внутри одной серии версий скачиваются в фоне. Установка — при обычном выходе; крупные обновления скачиваются по вашему запросу.',
              workerHelp:
                  'В этом релизе изменился Worker. Обновите его отдельно в Cloudflare. После применения отметьте «Worker обновлён».',
          }
        : {
              title: 'SoundCloud updates',
              mode: 'Update mode',
              patch: 'Automatic: small fixes',
              notify: 'Notify only',
              off: 'No automatic checks',
              check: 'Check now',
              download: 'Download update',
              install: 'Restart and install',
              notes: "What's new",
              worker: 'Worker updated',
              description:
                  'Fixes within the same version series download in the background and install on a normal quit. Larger updates download when you choose.',
              workerHelp:
                  'This release changes the Worker. Update it separately in Cloudflare, then select “Worker updated”.',
          };
    const version = state.version || '';
    const text = russian
        ? {
              idle: 'Текущая версия: ' + state.currentVersion,
              checking: 'Проверяем новые версии…',
              current: 'Установлена актуальная версия ' + state.currentVersion,
              available:
                  'Доступна версия ' +
                  version +
                  (state.kind === 'larger' ? ' — обновление с новыми возможностями.' : ''),
              downloading: 'Скачиваем ' + version + ': ' + (state.percent || 0) + '%',
              ready:
                  'Версия ' +
                  version +
                  ' готова.' +
                  (state.mode === 'patch' && state.kind === 'patch'
                      ? ' Установится при обычном выходе из клиента.'
                      : ' Нажмите «Перезапустить и установить», когда будет удобно.'),
              error: 'Обновление сейчас недоступно. Повторите проверку или откройте страницу релиза.',
          }
        : {
              idle: 'Current version: ' + state.currentVersion,
              checking: 'Checking for updates…',
              current: 'You are up to date: ' + state.currentVersion,
              available:
                  'Version ' + version + ' is available' + (state.kind === 'larger' ? ' — a larger update.' : '.'),
              downloading: 'Downloading ' + version + ': ' + (state.percent || 0) + '%',
              ready:
                  'Version ' +
                  version +
                  ' is ready.' +
                  (state.mode === 'patch' && state.kind === 'patch'
                      ? ' It will install when you quit normally.'
                      : ' Restart and install whenever you are ready.'),
              error: 'Updates are unavailable right now. Try again or open the release page.',
          };
    return {
        ...state,
        labels,
        message: state.installSupported
            ? text[state.phase]
            : russian
              ? 'Обновление из клиента доступно в установленной версии для Windows. Релизы можно открыть ниже.'
              : 'In-app updates are available in the installed Windows version. Open releases below.',
        badge: russian
            ? state.phase === 'ready'
                ? 'Обновление готово'
                : 'Обновление ' + version
            : state.phase === 'ready'
              ? 'Update ready'
              : 'Update ' + version,
        releaseUrl:
            'https://github.com/rvelabs/soundcloud-rpc/releases/' +
            (version ? 'tag/v' + encodeURIComponent(version) : 'latest'),
    };
}
