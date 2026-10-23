export const audioMonitorScript = String.raw`
(() => {
  if (window.__soundCloudMonitorActive) return;
  window.__soundCloudMonitorActive = true;
  let disposed = false, reconcileTimer, notifyTimer, last, lastProgressAt = 0;
  const bindings = new Map();
  const seconds = value => (value || '').split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
  const read = () => {
    const play = document.querySelector('.playControls__play');
    const title = document.querySelector('.playbackSoundBadge__titleLink');
    const art = document.querySelector('.playbackSoundBadge__avatar .image__lightOutline span');
    const like = document.querySelector('.playbackSoundBadge__like');
    const maximum = Number(document.querySelector('.playbackTimeline__progressWrapper[aria-valuemax]')?.getAttribute('aria-valuemax'));
    let duration = document.querySelector('.playbackTimeline__duration span:last-child')?.textContent.trim() || '';
    if (Number.isFinite(maximum) && maximum > 0) {
      const whole = Math.round(maximum);
      duration = Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
    } else if (duration.startsWith('-')) duration = '';
    return {
      title: title?.getAttribute('title') || title?.textContent.trim() || art?.getAttribute('aria-label') || '',
      author: document.querySelector('.playbackSoundBadge__lightLink')?.textContent.trim() || '',
      artwork: art?.style.backgroundImage.replace(/^url\(['"]?|['"]?\)$/g, '') || '',
      elapsed: document.querySelector('.playbackTimeline__timePassed span:last-child')?.textContent.trim() || '',
      duration,
      isPlaying: Boolean(play?.classList.contains('playing')),
      isLiked: Boolean(like && (like.classList.contains('sc-button-selected') || like.getAttribute('aria-pressed') === 'true')),
      url: title?.href.split(/[?#]/)[0] || '',
    };
  };
  const notify = () => {
    if (disposed) return;
    const next = read();
    const sameTrack = last && next.url === last.url;
    const elapsed = seconds(next.elapsed), previous = seconds(last?.elapsed), duration = seconds(next.duration);
    const changed = !last || ['title','author','artwork','url','duration','isPlaying','isLiked'].some(key => next[key] !== last[key]);
    const jumped = sameTrack && Math.abs(elapsed - previous) > 3;
    const nearEnd = duration > 0 && elapsed >= duration - 5 && next.elapsed !== last?.elapsed;
    if (changed || jumped || nearEnd) {
      window.soundcloudAPI.sendTrackUpdate(next, jumped ? 'seek-change' : 'playback-state-change');
      lastProgressAt = Date.now();
    } else if (next.isPlaying && Date.now() - lastProgressAt >= 5000) {
      window.soundcloudAPI.sendTrackProgress?.(next);
      lastProgressAt = Date.now();
    }
    last = next;
  };
  const scheduleNotify = () => {
    if (notifyTimer !== undefined || disposed) return;
    notifyTimer = setTimeout(() => { notifyTimer = undefined; notify(); }, 30);
  };
  const selectors = [
    '.playControls__play', '.playbackSoundBadge', '.playbackTimeline__timePassed',
    '.playbackTimeline__duration', '.playbackTimeline__progressWrapper',
  ];
  const reconcile = () => {
    if (disposed) return;
    for (const selector of selectors) {
      const element = document.querySelector(selector), old = bindings.get(selector);
      if (old?.element === element) continue;
      old?.observer.disconnect();
      bindings.delete(selector);
      if (!element) continue;
      const observer = new MutationObserver(scheduleNotify);
      observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['class','title','aria-label','aria-pressed','aria-valuemax','href','style'] });
      bindings.set(selector, { element, observer });
      scheduleNotify();
    }
  };
  const documentObserver = new MutationObserver(() => {
    if (reconcileTimer !== undefined || disposed) return;
    reconcileTimer = setTimeout(() => { reconcileTimer = undefined; reconcile(); }, 100);
  });
  const onSeek = event => {
    if (event.target instanceof Element && event.target.closest('.playbackTimeline, .waveform')) scheduleNotify();
  };
  const initialize = () => {
    if (disposed) return;
    reconcile(); notify();
    documentObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', onSeek, true);
    document.addEventListener('pointerup', onSeek, true);
  };
  window.addEventListener('beforeunload', () => {
    disposed = true; clearTimeout(reconcileTimer); clearTimeout(notifyTimer);
    documentObserver.disconnect();
    for (const {observer} of bindings.values()) observer.disconnect();
    bindings.clear();
    document.removeEventListener('click', onSeek, true);
    document.removeEventListener('pointerup', onSeek, true);
  }, { once: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
`;
