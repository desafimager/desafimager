// ==UserScript==
// @name         Aerial
// @namespace    aerial-app
// @version      0.1.0
// @description  Personal podcast + radio manager, running as a userscript-hosted app
// @match        https://YOUR-USERNAME.github.io/aerial/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ---------- storage helpers (works whether GM_getValue is sync or Promise-based) ---------- */
  function gmGet(key, fallback) {
    try {
      const v = GM_getValue(key, undefined);
      if (v && typeof v.then === 'function') {
        return v.then(r => (r === undefined ? fallback : JSON.parse(r)));
      }
      return Promise.resolve(v === undefined ? fallback : JSON.parse(v));
    } catch (e) {
      return Promise.resolve(fallback);
    }
  }
  function gmSet(key, value) {
    try { GM_setValue(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  /* ---------- state ---------- */
  const state = {
    feeds: [],   // { id, url, title, episodes: [{title, url, pubDate}] }
    radios: [],  // { id, name, url }
    tab: 'podcasts',
    nowPlaying: null, // { title, url }
  };

  function uid() { return Math.random().toString(36).slice(2, 10); }

  /* ---------- fetch + RSS parsing ---------- */
  function fetchText(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error('HTTP ' + res.status));
        },
        onerror: () => reject(new Error('network error')),
      });
    });
  }

  function parseFeed(xmlText, feedUrl) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const channelTitleEl = doc.querySelector('channel > title');
    const title = (channelTitleEl ? channelTitleEl.textContent : feedUrl).trim();
    const episodes = Array.from(doc.querySelectorAll('item')).map((item) => {
      const enclosure = item.querySelector('enclosure');
      const titleEl = item.querySelector('title');
      const dateEl = item.querySelector('pubDate');
      return {
        title: (titleEl ? titleEl.textContent : 'Untitled').trim(),
        pubDate: dateEl ? dateEl.textContent : '',
        url: enclosure ? enclosure.getAttribute('url') : null,
      };
    }).filter((ep) => ep.url);
    return { title, episodes };
  }

  async function addFeed(url) {
    const text = await fetchText(url);
    const parsed = parseFeed(text, url);
    state.feeds.push({ id: uid(), url, title: parsed.title, episodes: parsed.episodes });
    gmSet('aerial_feeds', state.feeds);
    render();
  }

  function removeFeed(id) {
    state.feeds = state.feeds.filter((f) => f.id !== id);
    gmSet('aerial_feeds', state.feeds);
    render();
  }

  function addRadio(name, url) {
    state.radios.push({ id: uid(), name, url });
    gmSet('aerial_radios', state.radios);
    render();
  }

  function removeRadio(id) {
    state.radios = state.radios.filter((r) => r.id !== id);
    gmSet('aerial_radios', state.radios);
    render();
  }

  /* ---------- shared player ---------- */
  const audio = new Audio();
  audio.preload = 'none';

  function play(title, url) {
    state.nowPlaying = { title, url };
    audio.src = url;
    audio.play().catch(() => {});
    renderPlayer();
  }

  function togglePlay() {
    if (!state.nowPlaying) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
    renderPlayer();
  }

  audio.addEventListener('play', renderPlayer);
  audio.addEventListener('pause', renderPlayer);

  /* ---------- rendering ---------- */
  let listEl, playerEl;

  function injectStyles() {
    const css = `
      #aerial-app { font-family: -apple-system, system-ui, sans-serif; background:#0b0b0d; color:#eee; min-height:100vh; padding-bottom:72px; box-sizing:border-box; }
      #aerial-app * { box-sizing: border-box; }
      .ar-tabs { display:flex; gap:8px; padding:12px; position:sticky; top:0; background:#0b0b0d; z-index:2; }
      .ar-tab { flex:1; text-align:center; padding:10px; border-radius:8px; background:#1a1a1e; font-size:14px; }
      .ar-tab.active { background:#3a6df0; }
      .ar-list { padding: 0 12px; }
      .ar-card { background:#16161a; border-radius:10px; padding:12px; margin-bottom:10px; }
      .ar-card-title { font-size:15px; font-weight:600; margin-bottom:6px; display:flex; justify-content:space-between; }
      .ar-episode { padding:8px 0; border-top:1px solid #232327; font-size:13px; display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .ar-episode:first-child { border-top:none; }
      .ar-btn { background:#3a6df0; color:#fff; border:none; border-radius:8px; padding:8px 12px; font-size:13px; }
      .ar-add-row { display:flex; gap:8px; padding: 12px; }
      .ar-add-row input { flex:1; background:#1a1a1e; border:1px solid #2a2a2e; color:#eee; border-radius:8px; padding:8px; font-size:13px; min-width:0; }
      .ar-remove { color:#ff6b6b; font-size:12px; }
      #ar-player { position:fixed; left:0; right:0; bottom:0; background:#141417; padding:10px 14px; align-items:center; gap:12px; border-top:1px solid #232327; display:none; }
      #ar-player .ar-title { flex:1; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #ar-player button { background:#3a6df0; border:none; color:#fff; border-radius:50%; width:36px; height:36px; font-size:14px; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function el(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    return wrap.firstChild;
  }

  function render() {
    listEl.innerHTML = '';
    if (state.tab === 'podcasts') {
      const addRow = el(`
        <div class="ar-add-row">
          <input id="ar-feed-input" placeholder="Paste RSS feed URL">
          <button class="ar-btn" id="ar-add-feed">Add</button>
        </div>`);
      listEl.appendChild(addRow);
      addRow.querySelector('#ar-add-feed').onclick = () => {
        const input = addRow.querySelector('#ar-feed-input');
        const url = input.value.trim();
        if (!url) return;
        addFeed(url).catch((e) => alert('Failed to load feed: ' + e.message));
        input.value = '';
      };

      const wrap = el('<div class="ar-list"></div>');
      state.feeds.forEach((feed) => {
        const card = el(`
          <div class="ar-card">
            <div class="ar-card-title"><span>${feed.title}</span><span class="ar-remove" data-id="${feed.id}">remove</span></div>
            <div class="ar-eps"></div>
          </div>`);
        card.querySelector('.ar-remove').onclick = () => removeFeed(feed.id);
        const epsWrap = card.querySelector('.ar-eps');
        feed.episodes.slice(0, 20).forEach((ep) => {
          const epEl = el(`<div class="ar-episode"><span>${ep.title}</span><button class="ar-btn">Play</button></div>`);
          epEl.querySelector('button').onclick = () => play(ep.title, ep.url);
          epsWrap.appendChild(epEl);
        });
        wrap.appendChild(card);
      });
      listEl.appendChild(wrap);
    } else {
      const addRow = el(`
        <div class="ar-add-row">
          <input id="ar-radio-name" placeholder="Station name" style="flex:0.6">
          <input id="ar-radio-url" placeholder="Stream URL">
          <button class="ar-btn" id="ar-add-radio">Add</button>
        </div>`);
      listEl.appendChild(addRow);
      addRow.querySelector('#ar-add-radio').onclick = () => {
        const nameInput = addRow.querySelector('#ar-radio-name');
        const urlInput = addRow.querySelector('#ar-radio-url');
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        if (!name || !url) return;
        addRadio(name, url);
        nameInput.value = '';
        urlInput.value = '';
      };

      const wrap = el('<div class="ar-list"></div>');
      state.radios.forEach((r) => {
        const card = el(`
          <div class="ar-card" style="display:flex; justify-content:space-between; align-items:center;">
            <span>${r.name}</span>
            <span style="display:flex; gap:10px; align-items:center;">
              <button class="ar-btn">Play</button>
              <span class="ar-remove" data-id="${r.id}">remove</span>
            </span>
          </div>`);
        card.querySelector('button').onclick = () => play(r.name, r.url);
        card.querySelector('.ar-remove').onclick = () => removeRadio(r.id);
        wrap.appendChild(card);
      });
      listEl.appendChild(wrap);
    }
  }

  function renderPlayer() {
    playerEl.innerHTML = '';
    if (!state.nowPlaying) { playerEl.style.display = 'none'; return; }
    playerEl.style.display = 'flex';
    const title = el(`<div class="ar-title">${state.nowPlaying.title}</div>`);
    const btn = document.createElement('button');
    btn.textContent = audio.paused ? '\u25B6' : '\u23F8';
    btn.onclick = togglePlay;
    playerEl.appendChild(title);
    playerEl.appendChild(btn);
  }

  function renderTabs() {
    const tabsEl = document.getElementById('ar-tabs');
    tabsEl.innerHTML = '';
    [['podcasts', 'Podcasts'], ['radios', 'Radio']].forEach(([key, label]) => {
      const tab = el(`<div class="ar-tab${state.tab === key ? ' active' : ''}">${label}</div>`);
      tab.onclick = () => { state.tab = key; renderTabs(); render(); };
      tabsEl.appendChild(tab);
    });
  }

  /* ---------- boot ---------- */
  async function init() {
    injectStyles();
    const root = document.createElement('div');
    root.id = 'aerial-app';
    root.innerHTML = `
      <div class="ar-tabs" id="ar-tabs"></div>
      <div id="ar-list"></div>
      <div id="ar-player"></div>
    `;
    document.body.innerHTML = '';
    document.body.appendChild(root);
    listEl = document.getElementById('ar-list');
    playerEl = document.getElementById('ar-player');

    state.feeds = await gmGet('aerial_feeds', []);
    state.radios = await gmGet('aerial_radios', []);

    renderTabs();
    render();
    renderPlayer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
