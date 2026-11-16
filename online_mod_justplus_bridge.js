/*
 * Online MOD -> Just+ Player Bridge v2.0.0
 * Community plugin for Lampa Android.
 * Source, series, season, voice, and episode-resolved URL cache.
 * No background downloads, no DRM changes and no remote backend.
 */
(function () {
  'use strict';

  var VERSION = '2.0.0';
  var FLAG = 'online_mod_justplus_bridge_enabled';
  var SETTINGS = 'online_mod_justplus_bridge';
  var CACHE_PREFIX = 'online_mod_justplus_cache_v2_';
  var CACHE_INDEX = 'online_mod_justplus_cache_index_v2';
  var CHUNK_SIZE = 100;
  var installed = false;
  var generation = 0;
  var pending = null;
  var overlay = null;
  var currentJob = null;

  function log() {
    try { console.log.apply(console, ['[Just+ Bridge ' + VERSION + ']'].concat([].slice.call(arguments))); } catch (ignore) {}
  }
  function notify(message) {
    try { if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(message); } catch (ignore) {}
  }
  function enabled() {
    try { return Lampa.Storage.field(FLAG) === true; } catch (ignore) { return false; }
  }
  function applicable(data) {
    try {
      if (!enabled() || !Lampa.Platform || !Lampa.Platform.is('android')) return false;
      var act = Lampa.Activity && Lampa.Activity.active && Lampa.Activity.active();
      if (!act || act.component !== 'online_mod') return false;
      var player = Lampa.Storage.field('player');
      return (!player || player === 'android') && data && typeof data.url === 'string' && !!data.url && !data.torrent_hash && !data.iptv;
    } catch (ignore) { return false; }
  }
  function finiteNumber(value) {
    var n = Number(value);
    return isFinite(n) && n >= 0 && Math.floor(n) === n ? n : null;
  }
  function inferMetadata(item) {
    if (!item || !item.title) return;
    var title = String(item.title);
    var pair = /S(\d+)\s*E(\d+)/i.exec(title);
    var season = /(?:^|\s)(?:S|Season|Сезон)\s*(\d+)(?:\s|\/|-|:|$)/i.exec(title);
    var episode = /(?:Серия|Эпизод|Episode|Ep\.?|E)\s*(\d+)\b/i.exec(title);
    if (item.season == null) item.season = finiteNumber(pair ? pair[1] : season && season[1]);
    if (item.episode == null) item.episode = finiteNumber(pair ? pair[2] : episode && episode[1]);
  }
  function copyPlain(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (ignore) { return null; }
  }
  function cleanCopy(item) {
    var output = {};
    Object.keys(item || {}).forEach(function (key) {
      if (key !== 'playlist' && typeof item[key] !== 'function') output[key] = item[key];
    });
    inferMetadata(output);
    return output;
  }
  function playableCopy(item) {
    if (!item || typeof item.url !== 'string' || !item.url) return null;
    var output = {url: item.url};
    // Cache only serializable playback fields. Don't cache UI objects/timeline.
    ['title', 'season', 'episode', 'quality', 'subtitles', 'headers', 'useragent', 'referer', 'info'].forEach(function (key) {
      if (item[key] !== undefined && typeof item[key] !== 'function') {
        var value = copyPlain(item[key]);
        if (value !== null) output[key] = value;
      }
    });
    inferMetadata(output);
    return output;
  }
  function findCurrent(list, first) {
    var i;
    for (i = 0; i < list.length; i++) if (list[i] === first) return i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && typeof list[i].url === 'string' && list[i].url === first.url) return i;
    }
    var found = -1;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].title && list[i].title === first.title) {
        if (found !== -1) return -1;
        found = i;
      }
    }
    return found;
  }
  function hash(input) {
    var h = 2166136261;
    for (var i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }
  function movieContext(first) {
    try {
      var act = Lampa.Activity.active() || {};
      var card = act.movie || act.card || (act.data && (act.data.movie || act.data.card)) || (act.object && act.object.movie) || {};
      var title = card.original_title || card.original_name || card.title || card.name || act.title || '';
      var movieId = card.imdb_id || card.kinopoisk_id || card.id || '';
      // Do not mix different shows when the activity does not identify the title.
      if (!movieId && (!title || title === first.title)) return null;
      var selected = Lampa.Storage.get('online_mod_balanser', 'unknown') + '';
      var last = Lampa.Storage.get('online_mod_last_balanser', {});
      if (movieId && last && typeof last === 'object' && last[card.id]) selected = last[card.id] + '';
      var filters = Lampa.Storage.get('online_mod_filter', {});
      if (!filters || typeof filters !== 'object') filters = {};
      var copy = cleanCopy(first);
      var season = copy.season;
      if (season == null) season = filters.season == null ? 'unknown' : 'selected-' + filters.season;
      var voice = filters.voice_name || (filters.voice == null ? 'default' : String(filters.voice));
      var key = JSON.stringify([String(movieId), String(title), String(selected), String(season), String(voice), String(filters.server == null ? '' : filters.server)]);
      return {key: key, id: hash(key), source: String(selected), show: String(title), season: String(season), voice: String(voice)};
    } catch (e) {
      log('Cache key error:', e);
      return null;
    }
  }
  function loadIndex() {
    var value = Lampa.Storage.get(CACHE_INDEX, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function cacheFor(context, total) {
    if (!context) return null;
    var chunks = {};
    var dirty = {};
    var writes = 0;
    var number = Math.ceil(total / CHUNK_SIZE);
    var group = context.key;
    for (var n = 0; n < number; n++) {
      var data = Lampa.Storage.get(CACHE_PREFIX + context.id + '_' + n, {});
      chunks[n] = data && data.group === group && data.items && typeof data.items === 'object'
        ? data : {group: group, items: {}};
    }
    function keyAt(index, item) {
      // The position AND title prevent mistaken reuse if the source reorders episodes.
      return String(index) + ':' + String(item && item.title || '');
    }
    function flush() {
      var used = Object.keys(dirty);
      if (!used.length) return;
      for (var i = 0; i < used.length; i++) {
        var n = used[i];
        try {
          Lampa.Storage.set(CACHE_PREFIX + context.id + '_' + n, chunks[n], true);
          delete dirty[n];
        } catch (e) { log('Cache write error:', e); }
      }
      try {
        var index = loadIndex();
        index[context.id] = {
          group: group,
          name: context.show,
          source: context.source,
          season: context.season,
          chunks: number,
          updated: Date.now()
        };
        Lampa.Storage.set(CACHE_INDEX, index, true);
      } catch (e) { log('Cache index error:', e); }
    }
    return {
      get: function (i, item) {
        var chunk = chunks[Math.floor(i / CHUNK_SIZE)];
        var entry = chunk && chunk.items[keyAt(i, item)];
        return entry && entry.url && typeof entry.url === 'string' ? entry : null;
      },
      put: function (i, item, result) {
        var safe = playableCopy(result);
        if (!safe) return;
        var n = Math.floor(i / CHUNK_SIZE);
        if (!chunks[n]) chunks[n] = {group: group, items: {}};
        chunks[n].items[keyAt(i, item)] = safe;
        dirty[n] = true;
        if (++writes % 10 === 0) flush();
      },
      flush: flush
    };
  }
  function clearSavedLists() {
    var count = 0;
    try {
      var keys = Lampa.Storage.keys ? Lampa.Storage.keys() : [];
      keys.forEach(function (name) {
        if (name.indexOf(CACHE_PREFIX) === 0) {
          Lampa.Storage.erase(name);
          count++;
        }
      });
      Lampa.Storage.erase(CACHE_INDEX);
    } catch (e) { log('Clear cache:', e); }
    notify('Just+: сохранённые списки удалены (' + count + ')');
  }
  function cacheStats() {
    try {
      var index = loadIndex();
      var groups = Object.keys(index).length;
      var chunks = 0;
      Object.keys(index).forEach(function (id) { chunks += index[id].chunks || 0; });
      return groups + ' источников/сезонов, ' + chunks + ' блоков';
    } catch (ignore) { return 'Данные сохранены на устройстве'; }
  }
  function removeDialog() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }
  function createDialog(title, subtitle) {
    removeDialog();
    var root = document.createElement('div');
    root.id = 'justplus-bridge-modal';
    root.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(3,8,19,.76)!important;backdrop-filter:blur(7px);padding:16px;box-sizing:border-box;font:15px Arial,sans-serif;color:#f5f7fd;text-align:left';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    var panel = document.createElement('div');
    panel.style.cssText = 'background:linear-gradient(145deg,#202a3c,#141b28);border:1px solid rgba(152,177,210,.24);border-radius:24px;max-width:440px;width:100%;padding:24px;box-sizing:border-box;box-shadow:0 24px 75px rgba(0,0,0,.62)';
    var mark = document.createElement('div');
    mark.style.cssText = 'display:inline-block;padding:6px 11px;background:rgba(94,214,166,.14);color:#81e6be;border:1px solid rgba(94,214,166,.3);border-radius:999px;font-weight:600;font-size:12px;letter-spacing:.4px;margin-bottom:13px';
    mark.textContent = 'ONLINE MOD  /  JUST+';
    var heading = document.createElement('div');
    heading.style.cssText = 'font-size:23px;font-weight:700;line-height:1.18;margin-bottom:8px;letter-spacing:-.4px';
    heading.textContent = title;
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;color:#b3c0d4;line-height:1.45;margin-bottom:19px;word-break:break-word';
    sub.textContent = subtitle || '';
    panel.appendChild(mark);
    panel.appendChild(heading);
    panel.appendChild(sub);
    root.appendChild(panel);
    root.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(root);
    overlay = root;
    return panel;
  }
  function makeButton(label, primary, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = 'appearance:none;-webkit-appearance:none;border:' +
      (primary ? '0' : '1px solid rgba(177,195,220,.3)') +
      ';border-radius:13px;padding:13px 15px;font:600 14px Arial,sans-serif;cursor:pointer;color:' +
      (primary ? '#0c2020' : '#f2f6fd') +
      ';background:' + (primary ? '#78e7bd' : '#313c4e') + ';width:100%;min-height:46px';
    button.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); handler(); });
    return button;
  }
  function confirmDialog(title, description, yes) {
    try {
      var panel = createDialog(title, description);
      panel.appendChild(makeButton('Да, удалить', true, function () { removeDialog(); yes(); }));
      var gap = document.createElement('div');
      gap.style.height = '9px';
      panel.appendChild(gap);
      panel.appendChild(makeButton('Отмена', false, removeDialog));
    } catch (e) { log('Dialog error:', e); notify('Just+: не удалось открыть подтверждение'); }
  }
  function showProgress(total, meta, launchEarly) {
    try {
      var panel = createDialog('Подготовка серий', (meta ? meta.show + ' · ' + meta.source + ' · сезон ' + meta.season : 'Online MOD') + ' · сохранение на этом устройстве');
      var count = document.createElement('div');
      count.style.cssText = 'font-size:27px;font-weight:700;margin-bottom:10px;font-variant-numeric:tabular-nums';
      count.textContent = '0 / ' + total;
      var track = document.createElement('div');
      track.style.cssText = 'height:10px;background:#364153;border-radius:999px;overflow:hidden;margin-bottom:13px';
      var bar = document.createElement('div');
      bar.style.cssText = 'height:100%;width:0%;border-radius:999px;background:linear-gradient(90deg,#65d1ec,#78e7bd);transition:width .18s';
      track.appendChild(bar);
      var info = document.createElement('div');
      info.style.cssText = 'font-size:13px;color:#b6c5d8;min-height:34px;line-height:1.4';
      info.textContent = 'Проверяю сохранённые серии…';
      var help = document.createElement('div');
      help.style.cssText = 'font-size:12px;line-height:1.5;color:#8190a7;margin:14px 0 17px';
      help.textContent = 'Результат сохраняется по источнику, сезону и серии. Без тайм-аута: можно смотреть сразу, не дожидаясь остальных ссылок.';
      panel.appendChild(count);
      panel.appendChild(track);
      panel.appendChild(info);
      panel.appendChild(help);
      var confirm = document.createElement('div');
      confirm.style.display = 'none';
      var question = document.createElement('div');
      question.style.cssText = 'color:#fff;font-size:15px;font-weight:700;margin-bottom:12px';
      question.textContent = 'Запустить без сбора? Уже найденные серии сохранятся, но сейчас откроется только выбранная серия.';
      confirm.appendChild(question);
      var yes = makeButton('Да, запустить серию', true, launchEarly);
      var no = makeButton('Продолжить сбор', false, function () {
        confirm.style.display = 'none';
        manual.style.display = '';
      });
      var confirmGap = document.createElement('div');
      confirmGap.style.height = '9px';
      confirm.appendChild(yes);
      confirm.appendChild(confirmGap);
      confirm.appendChild(no);
      panel.appendChild(confirm);
      var manual = makeButton('▶  Запустить без сбора', false, function () {
        manual.style.display = 'none';
        confirm.style.display = '';
      });
      panel.appendChild(manual);
      return {
        render: function (completed, all, failed, reused) {
          if (!overlay || !overlay.contains(panel)) return;
          var percent = all ? Math.round(completed / all * 100) : 100;
          count.textContent = completed + ' / ' + all + ' · ' + percent + '%';
          bar.style.width = percent + '%';
          info.textContent = 'Из кэша: ' + reused + ' · недоступно: ' + failed +
            (completed < all ? ' · осталось: ' + (all - completed) : ' · готово');
        }
      };
    } catch (e) {
      log('Progress UI error:', e);
      removeDialog();
      notify('Just+: не удалось открыть окно прогресса');
      return {render: function () {}};
    }
  }
  function resolveOne(item, callback) {
    if (!item) return callback(null);
    if (typeof item.url === 'string') return callback(item.url ? item : null);
    if (typeof item.url !== 'function') return callback(null);
    // Intentionally no timer; user chooses when to stop via the dialog.
    var resolver = item.url;
    var called = false;
    try {
      resolver(function () {
        if (called) return;
        called = true;
        callback(typeof item.url === 'string' && item.url ? item : null);
      });
    } catch (e) {
      if (!called) { called = true; callback(null); }
    }
  }
  function prepare(first, list, token, report, callback) {
    var selected = findCurrent(list, first);
    if (selected < 0) { list = list.concat([first]); selected = list.length - 1; }
    var context = movieContext(first);
    var cache = cacheFor(context, list.length);
    var results = new Array(list.length);
    var completed = 0;
    var failed = 0;
    var reused = 0;
    var index = 0;
    var stopped = false;

    function reportNow() { report(completed, list.length, failed, reused); }
    function finish() {
      if (stopped || generation !== token) return;
      if (cache) cache.flush();
      var valid = results.filter(function (v) { return !!v; });
      var originalSelected = results[selected];
      if (!originalSelected || !valid.length) return callback(null, failed, reused);
      var pos = valid.indexOf(originalSelected);
      if (pos < 0) return callback(null, failed, reused);
      try {
        if (first.quality && Object.keys(first.quality).length > 1 && Lampa.Player.getUrlQuality) {
          var qualityUrl = Lampa.Player.getUrlQuality(first.quality, false);
          if (typeof qualityUrl === 'string' && qualityUrl) first.url = qualityUrl;
        }
      } catch (ignore) {}
      var current = cleanCopy(first);
      current.url = first.url;
      valid[pos] = current;
      first.playlist = valid;
      inferMetadata(first);
      if (cache) { cache.put(selected, list[selected], first); cache.flush(); }
      callback(first, failed, reused);
    }
    function move() {
      if (stopped || generation !== token) return;
      var batch = 0;
      while (index < list.length && batch < 40) {
        var at = index++;
        var item = list[at];
        if (at === selected) {
          results[at] = first;
          completed++;
          if (cache) cache.put(at, item, first);
          reportNow();
          batch++;
          continue;
        }
        var stored = cache && cache.get(at, item);
        if (stored) {
          results[at] = cleanCopy(stored);
          completed++;
          reused++;
          reportNow();
          batch++;
          continue;
        }
        if (item && typeof item.url === 'string' && item.url) {
          results[at] = cleanCopy(item);
          completed++;
          if (cache) cache.put(at, item, item);
          reportNow();
          batch++;
          continue;
        }
        resolveOne(item, function (source) {
          if (stopped || generation !== token) return;
          var targetIndex = at;
          if (source) {
            var value = cleanCopy(source);
            results[targetIndex] = value;
            if (cache) cache.put(targetIndex, item, value);
          } else {
            failed++;
          }
          completed++;
          reportNow();
          setTimeout(move, 0);
        });
        return;
      }
      if (index >= list.length) finish();
      else setTimeout(move, 0);
    }
    reportNow();
    move();
    return {stop: function () { stopped = true; if (cache) cache.flush(); }};
  }
  function registerSettings() {
    if (!Lampa.SettingsApi || !Lampa.SettingsApi.addParam) return;
    try {
      if (Lampa.SettingsApi.addComponent && Lampa.SettingsApi.getComponent &&
          !Lampa.SettingsApi.getComponent(SETTINGS)) {
        Lampa.SettingsApi.addComponent({component: SETTINGS, name: 'Online MOD + Just+', icon: '<svg><use xlink:href="#sprite-settings"></use></svg>'});
      }
      Lampa.SettingsApi.addParam({
        component: SETTINGS,
        param: {name: FLAG, type: 'trigger', 'default': false},
        field: {name: 'Переключение серий в Just+', description: 'Работает при выборе внешнего Android-плеера'}
      });
      Lampa.SettingsApi.addParam({
        component: SETTINGS,
        param: {name: 'online_mod_justplus_clear_lists', type: 'button'},
        field: {name: 'Удалить сохранённые списки серий', description: 'Очистить только кэш Just+ Bridge. ' + cacheStats()},
        onChange: function () {
          confirmDialog('Удалить списки серий?', 'Данные источников, сезонов и серий будут удалены. Другие расширения и история просмотра Lampa не затрагиваются.', clearSavedLists);
        }
      });
    } catch (e) { log('Settings registration error:', e); }
  }
  function install() {
    if (installed || !window.Lampa || !Lampa.Player || !Lampa.Player.play || !Lampa.Player.playlist) return;
    installed = true;
    var playOriginal = Lampa.Player.play;
    var listOriginal = Lampa.Player.playlist;
    Lampa.Player.play = function (data) {
      if (!applicable(data)) {
        generation++;
        pending = null;
        if (currentJob) { currentJob.stop(); currentJob = null; }
        removeDialog();
        return playOriginal.apply(this, arguments);
      }
      var token = ++generation;
      if (currentJob) { currentJob.stop(); currentJob = null; }
      removeDialog();
      var args = arguments;
      var self = this;
      pending = {token: token, first: data, args: args, self: self};
      setTimeout(function () {
        if (!pending || pending.token !== token) return;
        pending = null;
        playOriginal.apply(self, args);
      }, 0);
    };
    Lampa.Player.playlist = function (items) {
      var result = listOriginal.apply(this, arguments);
      var request = pending;
      if (!request || request.token !== generation) return result;
      pending = null;
      if (!Array.isArray(items) || items.length < 2 || !enabled()) {
        playOriginal.apply(request.self, request.args);
        return result;
      }
      var token = request.token;
      var launched = false;
      function launch(ready, failed, reused) {
        if (launched || token !== generation) return;
        launched = true;
        currentJob = null;
        removeDialog();
        if (ready) notify('Just+: плейлист готов · из кэша ' + reused);
        else notify('Just+: запускаю выбранную серию');
        playOriginal.apply(request.self, request.args);
      }
      function launchWithoutCollection() {
        if (launched || token !== generation) return;
        if (currentJob) { currentJob.stop(); currentJob = null; }
        // Only the chosen URL: old cached playlist must not accidentally leak.
        delete request.first.playlist;
        launch(null, 0, 0);
      }
      var context = movieContext(request.first);
      var view = showProgress(items.length, context, launchWithoutCollection);
      try {
        currentJob = prepare(request.first, items, token, view.render, launch);
      } catch (e) {
        log('Prepare error:', e);
        launchWithoutCollection();
      }
      return result;
    };
    Lampa.Player.play.__onlineModJustPlusBridge = VERSION;
    Lampa.Player.playlist.__onlineModJustPlusBridge = VERSION;
    registerSettings();
    log('Installed. Persistent cache and user-controlled collection are enabled.');
  }
  function boot() {
    if (window.Lampa && Lampa.Player) install();
    else if (window.Lampa && Lampa.Listener && Lampa.Listener.follow) {
      Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') install(); });
    }
  }
  if (!window.__onlineModJustPlusBridgeLoaded) {
    window.__onlineModJustPlusBridgeLoaded = VERSION;
    boot();
  }
}());
