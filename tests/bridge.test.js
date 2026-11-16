'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plugin = fs.readFileSync(path.join(__dirname, '..', 'online_mod_justplus_bridge.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.style = {};
    this.parentNode = null;
    this.children = [];
    this.events = {};
    this.textContent = '';
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter(item => item !== child);
    child.parentNode = null;
  }
  setAttribute() {}
  contains(element) {
    return element === this || this.children.some(child => child.contains(element));
  }
  addEventListener(type, handler) { this.events[type] = handler; }
}

function env() {
  const storage = {
    online_mod_balanser: 'fanserials',
    online_mod_filter: { voice: 1, season: 0 },
    unrelated_app_setting: 'keep-me'
  };
  const flags = {
    online_mod_justplus_bridge_enabled: true,
    player: 'android'
  };
  const queue = [];
  const plays = [];
  const notices = [];
  const settings = [];
  const resolveCounts = { count: 0 };
  const activity = { component: 'online_mod', movie: { id: 42, title: 'The Mentalist' } };
  const Lampa = {
    Platform: { is: value => value === 'android' },
    Activity: { active: () => activity },
    Player: {
      play: data => plays.push({ url: data.url, playlist: data.playlist ? data.playlist.map(p => p.url) : null }),
      playlist() {},
      getUrlQuality() { return null; }
    },
    Storage: {
      get: (key, fallback) => key in storage ? storage[key] : fallback,
      set: (key, value) => { storage[key] = JSON.parse(JSON.stringify(value)); },
      erase: key => { delete storage[key]; },
      keys: () => Object.keys(storage),
      field: key => flags[key]
    },
    SettingsApi: {
      addComponent() {},
      getComponent() { return null; },
      addParam: param => settings.push(param)
    },
    Noty: { show: message => notices.push(message) }
  };
  const document = { body: new Element('body'), createElement: tag => new Element(tag) };
  const sandbox = {
    window: { Lampa },
    Lampa,
    document,
    setTimeout: callback => (queue.push(callback), queue.length),
    console,
    Date,
    Math,
    Number,
    isFinite
  };
  vm.runInNewContext(plugin, sandbox, { filename: 'online_mod_justplus_bridge.js' });
  const tick = () => { let count = 0; while (queue.length) { queue.shift()(); if (++count > 20000) throw new Error('Too many scheduled steps'); } };
  function list(n = 8, chosen = 3, stuck = -1) {
    return Array.from({ length: n }, (_, i) => {
      const item = { title: 'S1 / Серия ' + (i + 1) };
      if (i === chosen) item.url = 'https://example.org/video/' + (i + 1);
      else item.url = function (done) {
        resolveCounts.count++;
        if (i === stuck) return;
        item.url = 'https://example.org/video/' + (i + 1);
        done();
      };
      return item;
    });
  }
  function play(items, selected = 3, drain = true) {
    Lampa.Player.play(items[selected]);
    Lampa.Player.playlist(items);
    if (drain) tick();
  }
  function button(label) {
    const walk = node => node.tag === 'button' && node.textContent.includes(label) ? node :
      node.children.map(walk).find(Boolean);
    return walk(document.body);
  }
  function click(btn) {
    assert.ok(btn, 'Required button must exist');
    btn.events.click({ preventDefault() {}, stopPropagation() {} });
  }
  return { storage, flags, queue, plays, notices, settings, resolveCounts, activity, document, tick, list, play, button, click };
}

test('transfers complete playlist to external player', () => {
  const e = env();
  e.play(e.list());
  assert.equal(e.plays.length, 1);
  assert.equal(e.plays[0].playlist.length, 8);
  assert.equal(e.plays[0].playlist[3], 'https://example.org/video/4');
  assert.equal(e.resolveCounts.count, 7);
  assert.equal(e.document.body.children.length, 0, 'overlay auto-closes');
});

test('reuses local cache for the same show, source, season and voice', () => {
  const e = env();
  e.play(e.list());
  e.play(e.list());
  assert.equal(e.plays.length, 2);
  assert.equal(e.resolveCounts.count, 7, 'no new URL lookups');
  assert.equal(e.plays[1].playlist.length, 8);
  assert.ok(e.notices.some(m => m.includes('из кэша 7')));
});

test('changing source prevents accidental cross-source URL reuse', () => {
  const e = env();
  e.play(e.list());
  e.storage.online_mod_balanser = 'kodik';
  e.play(e.list());
  assert.equal(e.resolveCounts.count, 14);
});

test('stuck resolver waits indefinitely until user confirms manual playback', () => {
  const e = env();
  e.play(e.list(8, 3, 1), 3, false);
  e.tick();
  assert.equal(e.plays.length, 0, 'no automatic timeout or premature start');
  e.click(e.button('Запустить без сбора'));
  assert.equal(e.plays.length, 0, 'requires confirmation');
  e.click(e.button('Да, запустить серию'));
  assert.equal(e.plays.length, 1);
  assert.equal(e.plays[0].playlist, null, 'launch only selected episode');
  assert.equal(e.document.body.children.length, 0);
});

test('cache-clearing action is separate, confirmed and leaves other settings untouched', () => {
  const e = env();
  e.play(e.list());
  const clear = e.settings.find(param => param.param.type === 'button');
  assert.ok(clear);
  clear.onChange();
  assert.ok(Object.keys(e.storage).some(key => key.startsWith('online_mod_justplus_cache')));
  e.click(e.button('Да, удалить'));
  assert.ok(!Object.keys(e.storage).some(key => key.startsWith('online_mod_justplus_cache')));
  assert.equal(e.storage.unrelated_app_setting, 'keep-me');
});

test('large season is stored in 100-episode chunks and can be reused', () => {
  const e = env();
  e.play(e.list(250, 3));
  assert.equal(e.plays[0].playlist.length, 250);
  assert.equal(Object.keys(e.storage).filter(key => key.startsWith('online_mod_justplus_cache_v2_')).length, 3);
  const lookups = e.resolveCounts.count;
  e.play(e.list(250, 3));
  assert.equal(e.resolveCounts.count, lookups);
});
