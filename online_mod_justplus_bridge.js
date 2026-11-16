/*
 * Online MOD -> Just+ Player bridge, v1.1.0 (2026-11-17)
 * For Lampa Android with the nested Just+ playlist API (1.13.5+).
 * Install AFTER Online MOD. Enable only when you use Just+ Player.
 * This plugin never creates media URLs, changes balancers or resolves DRM.
 */
(function () {
  'use strict';

  var FLAG = 'online_mod_justplus_bridge_enabled';
  var NAME = 'online_mod_justplus_bridge';
  var PATCH = 'online-mod-justplus-bridge-v1';
  var REQUEST_TIMEOUT_MS = 3500;
  var TOTAL_TIMEOUT_MS = 12000;
  var installed = false;
  var generation = 0;
  var pending = null;

  function notify(message) {
    try { if (window.Lampa && Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message); }
    catch (ignore) {}
  }

  // Minimal non-interactive overlay. All DOM operations are optional and
  // isolated so that UI failures cannot break normal playback.
  var progressNode = null;
  function closeProgress() {
    try {
      if (progressNode && progressNode.parentNode) progressNode.parentNode.removeChild(progressNode);
    } catch (ignore) {}
    progressNode = null;
  }
  function updateProgress(done, total, failed) {
    try {
      if (!progressNode || !progressNode.parentNode) return;
      var percent = total ? Math.round(done / total * 100) : 100;
      progressNode.querySelector('.justplus-bridge-count').textContent =
        done + ' / ' + total + ' серий · ' + percent + '%';
      progressNode.querySelector('.justplus-bridge-bar').style.width = percent + '%';
      progressNode.querySelector('.justplus-bridge-note').textContent =
        failed ? 'Недоступных серий: ' + failed : 'Подготовка плейлиста';
    } catch (ignore) {}
  }
  function openProgress(total) {
    closeProgress();
    try {
      if (!document || !document.body) return;
      var node = document.createElement('div');
      node.id = 'justplus-bridge-progress';
      node.setAttribute('role', 'status');
      node.style.cssText = 'position:fixed;z-index:2147483646;left:50%;bottom:7%;transform:translateX(-50%);width:min(88vw,420px);box-sizing:border-box;background:rgba(22,25,31,.96);color:#fff;padding:16px 18px;border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.45);font:16px Arial,sans-serif;pointer-events:none';
      node.innerHTML = '<div style="font-weight:bold;margin-bottom:8px">Just+ · Получение серий</div>' +
        '<div class="justplus-bridge-count" style="font-size:14px;margin-bottom:10px">0 / 0 серий · 0%</div>' +
        '<div style="height:7px;border-radius:8px;background:#454953;overflow:hidden">' +
        '<div class="justplus-bridge-bar" style="height:100%;width:0%;background:#58d7a2;transition:width .2s ease"></div></div>' +
        '<div class="justplus-bridge-note" style="font-size:12px;color:#bbc0ca;margin-top:8px">Подготовка плейлиста</div>';
      document.body.appendChild(node);
      progressNode = node;
      updateProgress(0, total, 0);
    } catch (e) { closeProgress(); }
  }

  function isOn() {
    try { return Lampa.Storage.field(FLAG) === true; }
    catch (ignore) { return false; }
  }

  function target(data) {
    try {
      if (!isOn() || !Lampa.Platform || !Lampa.Platform.is('android')) return false;
      var active = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
      if (!active || active.component !== 'online_mod') return false;
      var chosen = Lampa.Storage.field('player');
      // On Android this is the system (external) player setting.
      if (chosen && chosen !== 'android') return false;
      return data && typeof data.url === 'string' && data.url.length > 0 && !data.torrent_hash && !data.iptv;
    } catch (ignore) { return false; }
  }

  function numericValue(n) {
    var value = Number(n);
    return isFinite(value) && value >= 0 && Math.floor(value) === value ? value : null;
  }

  function metadata(item) {
    if (!item || typeof item.title !== 'string') return;
    var title = item.title;
    var season = /(?:^|\s)(?:S|Season|Сезон)\s*(\d+)\s*(?:\/|[-:])/i.exec(title);
    var episode = /(?:Серия|Эпизод|Episode|Ep\.?|E)\s*(\d+)\b/i.exec(title);
    var short = /\bS(\d+)E(\d+)\b/i.exec(title);
    if (short) { season = short; episode = [null, short[2]]; }
    if (item.season == null && season) item.season = numericValue(season[1]);
    if (item.episode == null && episode) item.episode = numericValue(episode[1]);
  }

  function cleanCopy(source) {
    var copy = {};
    Object.keys(source || {}).forEach(function (k) {
      // Preserve original metadata/headers/quality/subtitles, but never pass JS resolver functions.
      if (k !== 'playlist' && typeof source[k] !== 'function') copy[k] = source[k];
    });
    metadata(copy);
    return copy;
  }

  function findCurrent(list, first) {
    var i;
    for (i = 0; i < list.length; ++i) if (list[i] === first) return i;
    for (i = 0; i < list.length; ++i) {
      if (list[i] && typeof list[i].url === 'string' && list[i].url === first.url) return i;
    }
    // An uncommon source may have different quality URLs on the two objects.
    // Match only uniquely identifiable items, never guess from list position.
    var matches = [];
    for (i = 0; i < list.length; ++i) {
      if (list[i] && list[i].title && list[i].title === first.title) matches.push(i);
    }
    if (matches.length === 1) return matches[0];
    return -1;
  }

  function resolveOne(item, callback) {
    if (!item) return callback(null);
    if (typeof item.url === 'string') return callback(item.url ? item : null);
    if (typeof item.url !== 'function') return callback(null);

    var resolver = item.url;
    var finished = false;
    var timer = setTimeout(function () { done(null); }, REQUEST_TIMEOUT_MS);
    function done(resolved) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback(resolved && typeof item.url === 'string' && item.url ? item : null);
    }
    try {
      // Original Online MOD resolver updates item.url, quality, subtitles, etc.
      // Resolve ONE AT A TIME: balancers use a shared network.clear() instance.
      resolver(function () { done(item); });
    } catch (ignore) { done(null); }
  }

  function build(first, list, done, token, onProgress) {
    var currentIndex = findCurrent(list, first);
    if (currentIndex < 0) {
      // Keep a valid current item rather than pretending episode 1 was chosen.
      list = list.concat([first]);
      currentIndex = list.length - 1;
    }
    var resolved = new Array(list.length);
    var rejected = 0;
    var index = 0;
    var completed = 0;
    if (onProgress) onProgress(0, list.length, 0);

    function step() {
      if (token !== generation) return;
      if (index === list.length) {
        var result = resolved.filter(function (item) { return !!item; });
        var current = resolved[currentIndex];
        if (!current || !result.length) return done(null, rejected);
        var matched = result.indexOf(current);
        if (matched < 0) return done(null, rejected);

        // Mirror Lampa.Player.play()'s explicit preferred-quality selection.
        // A shared object would be cyclic (first.playlist contains first) and
        // JSON.stringify in Android.openPlayer would fail, so copy the entry.
        try {
          if (first.quality && Object.keys(first.quality).length > 1 && Lampa.Player.getUrlQuality) {
            var chosenQuality = Lampa.Player.getUrlQuality(first.quality, false);
            if (typeof chosenQuality === 'string' && chosenQuality) first.url = chosenQuality;
          }
        } catch (ignore) {}
        var chosen = cleanCopy(first);
        chosen.url = first.url; // byte-identical, no URL normalization
        result[matched] = chosen;
        // Lampa.PlayerPlaylist still owns the original list for watched marks.
        // Keep its chosen entry consistent with the launched URL as well.
        if (list[currentIndex] && typeof list[currentIndex].url === 'string') {
          list[currentIndex].url = first.url;
        }
        first.playlist = result;
        metadata(first);
        return done(first, rejected);
      }
      var at = index++;
      var item = list[at];
      if (at === currentIndex) {
        resolved[at] = first;
        completed++;
        if (onProgress) onProgress(completed, list.length, rejected);
        return step();
      }
      resolveOne(item, function (value) {
        if (token !== generation) return;
        if (value) {
          resolved[at] = cleanCopy(value);
        } else {
          ++rejected;
        }
        completed++;
        if (onProgress) onProgress(completed, list.length, rejected);
        // Yield between episodes to avoid starving Android WebView.
        setTimeout(step, 0);
      });
    }
    step();
  }

  function registerSettings() {
    if (!window.Lampa || !Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;
    try {
      // Separate section: does not depend on Online MOD setting registration order.
      if (Lampa.SettingsApi.addComponent && Lampa.SettingsApi.getComponent &&
          !Lampa.SettingsApi.getComponent(NAME)) {
        Lampa.SettingsApi.addComponent({
          component: NAME,
          name: 'Online MOD + Just+',
          icon: '<svg><use xlink:href="#sprite-settings"></use></svg>'
        });
      }
      Lampa.SettingsApi.addParam({
        component: NAME,
        param: { name: FLAG, type: 'trigger', 'default': false },
        field: { name: 'Режим Just+ (только при выбранном Just+ Player)' }
      });
    } catch (e) { console.warn('[Online MOD Just+ bridge] settings:', e); }
  }

  function install() {
    if (installed || !window.Lampa || !Lampa.Player || !Lampa.Player.play || !Lampa.Player.playlist) return;
    installed = true;
    var originalPlay = Lampa.Player.play;
    var originalPlaylist = Lampa.Player.playlist;

    Lampa.Player.play = function (data) {
      if (!target(data)) {
        // A different video/player was started while links were resolving.
        generation++;
        pending = null;
        closeProgress();
        return originalPlay.apply(this, arguments);
      }

      // Cancel any pending bridge launch if another episode is selected.
      var token = ++generation;
      closeProgress();
      var self = this;
      var args = arguments;
      pending = { token: token, first: data, self: self, args: args, captured: false };

      // Online MOD calls Lampa.Player.playlist(...) immediately after play(...).
      // Defer actual external launch so that playlist can be intercepted.
      setTimeout(function () {
        if (!pending || pending.token !== token || pending.captured) return;
        pending = null;
        originalPlay.apply(self, args); // movies and unexpected implementations
      }, 0);
      return undefined;
    };

    Lampa.Player.playlist = function (list) {
      var args = arguments;
      // Preserve Lampa's native playlist state/callbacks for later progress reports.
      var result = originalPlaylist.apply(this, args);
      var p = pending;
      if (!p || p.token !== generation || p.captured) return result;
      p.captured = true;
      pending = null;

      if (!Array.isArray(list) || list.length < 2 || !isOn()) {
        originalPlay.apply(p.self, p.args);
        return result;
      }

      openProgress(list.length);
      // Never block playback indefinitely if a balancer's resolver stalls.
      // Guard both callback completion and a global deadline.
      var launched = false;
      var watchdog = setTimeout(function () {
        if (launched || p.token !== generation) return;
        launched = true;
        generation++; // invalidate pending resolver callbacks
        closeProgress();
        notify('Just+: источник не ответил, запускаю серию без плейлиста');
        try { originalPlay.apply(p.self, p.args); }
        catch (e) { console.warn('[Just+ bridge] fallback launch:', e); }
      }, TOTAL_TIMEOUT_MS);

      try {
        build(p.first, list, function (ready, failed) {
          if (launched || p.token !== generation) return;
          launched = true;
          clearTimeout(watchdog);
          closeProgress();
          if (ready) {
            if (failed) notify('Just+: недоступные серии пропущены: ' + failed);
            notify('Just+: плейлист готов, запускаю плеер');
          } else {
            notify('Just+: не удалось собрать плейлист, открываю выбранную серию');
          }
          originalPlay.apply(p.self, p.args);
        }, p.token, updateProgress);
      } catch (e) {
        if (!launched && p.token === generation) {
          launched = true;
          clearTimeout(watchdog);
          closeProgress();
          generation++;
          console.warn('[Just+ bridge] playlist error:', e);
          notify('Just+: ошибка плейлиста, запускаю выбранную серию');
          originalPlay.apply(p.self, p.args);
        }
      }
      return result;
    };

    Lampa.Player.play.__onlineModJustPlusBridge = PATCH;
    Lampa.Player.playlist.__onlineModJustPlusBridge = PATCH;
    console.log('[Online MOD Just+ bridge] installed; enable in settings to activate');
    registerSettings();
  }

  function boot() {
    if (window.Lampa && Lampa.Player) install();
    else if (window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
      Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') install(); });
    }
  }

  if (!window.__onlineModJustPlusBridgeLoaded) {
    window.__onlineModJustPlusBridgeLoaded = PATCH;
    boot();
  }
}());
