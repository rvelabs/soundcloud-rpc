# SoundCloud Desktop

**Your SoundCloud library, a personal radio, and playlists from other services — in one Windows app.**

The current Windows release is **0.2.9**, built with **Rust + WebView2**. It keeps the SoundCloud player and adds
personal radio, playlist import, an equalizer and desktop integrations. The previous Electron build remains available in
[release 0.32.2](https://github.com/rvelabs/soundcloud-rpc/releases/tag/v0.32.2).

[Download for Windows](https://github.com/rvelabs/soundcloud-rpc/releases/latest) ·
[Website](https://rvelabs.github.io/soundcloud-rpc/) ·
[Report a bug](https://github.com/rvelabs/soundcloud-rpc/issues/new/choose)

## Why install it?

- **My Wave** finds music related to tracks you enjoy, learns from your reactions and prepares the next tracks while you
  listen. Choose a mood, activity or music language. A static background avoids continuous animation; music keeps
  playing when the app is minimized.
- **Playlist import** brings public Spotify, Yandex Music and YouTube Music playlists to SoundCloud. Review matches and
  save the found part even when some tracks are unavailable, and resume saved checks after restarting. YouTube
  continuations and Spotify's scrolling track list are read automatically, up to 500 tracks. Import a CSV/TXT/TSV track
  list when a source cannot be reached.
- **10-band equalizer** in the native player: 42 presets grouped by sound, genre and instrument, manual tuning, preamp
  and automatic headroom. Settings persist across restarts; processing continues when minimized. Protected or non-CORS
  streams may not support processing.
- **Familiar SoundCloud controls**, plus Discord Rich Presence, Last.fm, themes and plugins. My Wave and playlist import
  and client settings support **English and Russian**, with an automatic language option.

## Get started

1. Download and install the Windows x64 release, then sign in to SoundCloud.
2. Like a few tracks or play a favorite, then open **Home → My Wave → Listen**.
3. Use **Customize** for mood, activity, music language and interface language. Playlist import has its own card below
   My Wave.
4. Open the **equalizer** beside the native player's queue button to choose a preset or tune the sound.

The Windows installer replaces the previous Electron installation and imports its supported listening history,
preferences and audio-analysis cache. WebView2 uses its own sign-in session, so sign in again after migration. Existing
Native profiles are preserved. The installer has no trusted publisher signature yet; updater packages are signed
separately and SHA-256 checksums are included with releases.

## Updates

Use **F1 → SoundCloud updates** to check for updates or choose notifications only. Native uses a separate signed
`native-v…` update channel; Electron does not install Native through its own updater. Install the Windows package once
to migrate. Closing the main window fully quits the app. A deployed Cloudflare Worker is updated separately.

## What to expect

Recommendations combine related tracks, stations, shared playlists and local ranking; home selections help new accounts.
Liked-track IDs and blocked uploaders sync in the background. This is an independent algorithm; it does not reproduce
Yandex Music's proprietary model. Cold starts depend on SoundCloud. Tempo, mood and language matching depend on
available metadata. Balanced mode mixes new and older familiar recordings; New excludes known recordings. When the
browser permits it, short samples from the SoundCloud player supply local loudness and spectrum measurements; protected
or unsuitable sources remain unmeasured. Signal loudness is not a mood classifier.

Import finds existing SoundCloud uploads; it does not copy audio. Source services may return partial playlists, and
versions or regional availability can differ. Spotify album links are also supported and become SoundCloud playlists.
SoundCloud playlists are limited to 500 tracks. When Spotify returns only part of a list, the app first tries to read
more anonymously, then offers an optional Spotify sign-in window. It explains why; declining or closing the window keeps
the tracks already read. A complete anonymous list never prompts for sign-in.

Public playlist metadata can load through your configured Worker when the source fails locally. Private playlists still
need an authorized export. Files up to 4 MB are supported: CSV/TSV with **Track Name** and **Artist Name(s)** columns,
or TXT with one **Artist — Title** per line. The filename becomes the playlist name unless the file supplies one.

## Optional fallback connection

Press **F1** → **Резервное подключение SoundCloud**. The wizard deploys a personal Cloudflare Worker and saves its HTTPS
address. It needs a Cloudflare API token with **Account Settings: Read** and **Workers Scripts: Edit**, scoped to your
account. Revoke the setup token after deployment; never publish it or the relay key.

**For YouTube pagination and the optional Spotify browser through Worker, update both the client and Worker to 0.30.0.**
In F1, choose **Создать или обновить Worker** and enter a new setup token in the app. Updating an existing app-created
Worker in the same Cloudflare account preserves its address and relay key. The public metadata endpoint does not forward
source-platform cookies or account credentials. The separate Spotify browser can use an allowlisted TLS tunnel; its
sign-in stays encrypted between the browser and Spotify.

From 0.29, an updated Worker can negotiate a bounded four-frame transfer window. Older Workers remain compatible with
the new client using the previous one-frame mode; update the Worker to enable pipelining.

For manual deployment, open the Worker folder from settings: run `npx wrangler@4 login`, `npx wrangler@4 deploy`, then
`npx wrangler@4 secret put RELAY_TOKEN`. Enter the Worker URL and the same randomly generated secret in the client.
Cloudflare TCP restrictions apply; this is not a system VPN or a guarantee of access in every region.

If the check fails, use **F1 → Проверить Worker → Скопировать диагностику подключения**. The report separates Worker
authentication, connection and SoundCloud response errors without including keys or cookies. Cloudflare itself must be
reachable from your network;
[ISP restrictions can also affect Workers](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/service-disruption/).

The connection check covers HTML, sampled CSS/JavaScript, API and the authentication endpoint. Copied diagnostics show
the page's load errors and website/CDN/API/auth/media routing; third-party failures are marked separately. Saving
**Always through Worker** reloads the open page; automatic recovery waits while the player is active. Workers only route
SoundCloud and `sndcdn.com` for playback. The isolated Spotify import browser additionally routes Spotify and its
`scdn.co` / `spotifycdn.com` / `spotifycdn.net` resources; the separate import endpoint reads public playlist metadata
and YouTube continuation pages. Availability still depends on Cloudflare and the source service.

For Workers deployed before 0.28.2, add `no_websocket_standard_binary_type` in the Worker's Cloudflare compatibility
flags and save/deploy, or redeploy the updated Worker code. This fixes immediate closure after the first binary packet;
updating the desktop app alone does not change an already deployed Worker. Keep the existing `RELAY_TOKEN` when
updating.

## Development

The separate `native/` Windows build uses **Rust + WebView2**, with no Electron or Node.js at runtime. Its Rust services
handle API transport, request priority, bounded caches, encrypted credentials, profile isolation, Discord,
Last.fm/webhooks, Worker setup and signed Native updates. F1 opens a right-hand panel inside the main window with client
settings, integrations, plugins/themes, accounts and connection diagnostics. CommonJS plugin hooks run in limited
QuickJS workers; browser content scripts and the tested recommendation/UI/Web Audio modules remain shared
TypeScript/JavaScript.

Native keeps its own WebView2 session and imports supported Electron library data. Spotify sign-in is optional when a
public list is incomplete; Yandex imports try direct access on a confirmed Russian IP, with Worker fallback. The main
SoundCloud player retains playback and queue control. Build with `npm run native:build`, validate with
`npm run native:test` and `npm run native:smoke`. Windows x64, Rust MSVC, C++ Build Tools and WebView2 are required.
`npm run native:installer` additionally needs the Native release signing key (`TAURI_SIGNING_PRIVATE_KEY`) or the
existing local Windows-protected key. Never regenerate the official key when preparing an update. Native packages use a
separate `native-v…` release/channel, with signed version binding; Electron updates cannot install them. A local build
does not publish the update feed or install over Electron.

Node.js 22 and npm:

```sh
npm ci
npm test
npm run test:worker
npm run test:import
npm run test:runtime
npm run test:assets
npm run lint
npm run dev
npm run build-win
```

Source: [recommendations](src/wave/recommendation), [playlist import](src/import), [network transport](src/network). The
[API adapter](src/soundcloud) reuses the web session for search, batch metadata, stations, likes, history and playlist
import. It verifies playlist writes and preserves partial imports. Credentials stay in memory; cached responses are
shared by import and radio. Page readers remain a fallback; rate limits pause new requests. These web endpoints are
undocumented and may change. A native queue adapter adds tracks without searching or navigating; page controls remain a
fallback when that interface is unavailable. Reproducible Electron checks are in [scripts](scripts). Detailed changes
and verification notes are in [Releases](https://github.com/rvelabs/soundcloud-rpc/releases).

For a bug report, use **Customize → Copy diagnostics**. Check the public track links before sharing; the report excludes
sign-in cookies and tokens.

<details>
<summary><strong>По-русски</strong></summary>

### Для чего этот клиент?

Слушать SoundCloud с персональной «Моей волной», переносить плейлисты из других сервисов и пользоваться привычным
штатным плеером.

- **Моя волна** подбирает похожие записи к вашим любимым трекам, учитывает реакции и готовит продолжение заранее.
  «Баланс» смешивает новые и знакомые записи, «Незнакомое» исключает уже известные треки. Настроение, занятие, язык
  музыки и язык интерфейса выбираются в «Настроить».
- **Импорт** находится в отдельной карточке. Вставьте публичную ссылку Spotify, Яндекс Музыки или YouTube Music,
  проверьте совпадения и сохраните найденную часть. Ошибка отдельного трека не отменяет уже добавленные записи. Если
  источник недоступен, используйте Worker или кнопку импорта CSV/TXT/TSV. Продолжения YouTube и прокручиваемый список
  Spotify читаются автоматически, максимум 500 треков. Если Spotify всё ещё отдаёт часть списка, клиент предложит вход в
  отдельном окне и объяснит причину. Можно отказаться или закрыть окно — прочитанные треки сохранятся. Для полного
  анонимного списка вход не предлагается.
- Статичный фон карточки без постоянной анимации и реакции на звук снижает затраты на отрисовку. Музыка продолжает
  играть.

Установите сборку из [Releases](https://github.com/rvelabs/soundcloud-rpc/releases/latest), войдите в SoundCloud и
нажмите «Слушать» на главной. Для нового аккаунта сначала добавьте несколько лайков или включите любимую запись.
Обновление сохраняет профиль; доверенной подписи Windows пока нет.

С версии 0.28.3 небольшие исправления скачиваются в фоне и устанавливаются при обычном выходе из клиента. О крупных
обновлениях клиент уведомит; перезапуск выбираете вы. Режим меняется в **F1 → Обновления SoundCloud**. Для старых сборок
один раз установите новую версию вручную. Worker в Cloudflare обновляется отдельно.

Для продолжений YouTube и окна Spotify через Worker нужны клиент **0.30.0** и обновлённый Worker: **F1 → Создать или
обновить Worker**. Введите новый установочный API-токен внутри приложения. Для ранее созданного клиентом Worker в том же
аккаунте адрес и ключ сохраняются. Файлы до 4 МБ можно импортировать без доступа к исходному сервису: CSV/TSV с
колонками названия и исполнителя или TXT со строками «Исполнитель — Название». Приватный плейлист требует доступного вам
экспорта.

Алгоритм собственный, на основе похожих треков SoundCloud и ваших реакций. Поиска по словам жанра нет. Скорость зависит
от сервиса, а точность темпа, настроения и языка — от метаданных. Импорт переносит найденные версии SoundCloud, не
аудиофайлы; часть треков может отсутствовать. Быстрые пропуски корректируют текущую сессию мягче явного дизлайка.
Учитываются исполнители уже подготовленной очереди; в объяснении выбора различаются метаданные, измеренный звук и
неизвестные признаки.

Для сообщения об ошибке: «Настроить» → «Скопировать диагностику». Перед публикацией проверьте ссылки на треки в отчёте.
История изменений и результаты проверок доступны в релизах.

</details>

## Credits

An unofficial fork of [richardhbtz/soundcloud-rpc](https://github.com/richardhbtz/soundcloud-rpc), maintained by
[rvelabs](https://github.com/rvelabs). [MIT license](LICENSE). Not affiliated with SoundCloud or the other streaming
services mentioned here.
