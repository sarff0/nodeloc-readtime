// ==UserScript==
// @name         NodeLoc 阅读时长后台助手（稳妥版）
// @namespace    local.nodeloc.readtime
// @version      1.0.1
// @description  用真实帖子和低频率计时请求，在后台缓慢累计 NodeLoc 阅读时长。单标签运行，遇 429 自动退避。
// @match        https://www.nodeloc.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// ==/UserScript==

(function () {
  'use strict';

  const CFG = {
    targetMinutes: 600,
    tickMinMs: 58000,
    tickMaxMs: 76000,
    sessionMinTicks: 3,
    sessionMaxTicks: 5,
    summaryEveryMs: 5 * 60 * 1000,
    leaderTtlMs: 30000,
    leaderHeartbeatMs: 10000,
    debug: true
  };

  const STORE = {
    enabled: 'nl-readtime-enabled',
    username: 'nl-readtime-username',
    totalRead: 'nl-readtime-total'
  };
  const LEADER_KEY = 'nodeloc-readtime-leader';
  const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const storage = {
    get(key, fallback) {
      try {
        const value = typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : localStorage.getItem(key);
        return value === undefined || value === null ? fallback : value;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else localStorage.setItem(key, String(value));
      } catch (_) {}
    }
  };

  const savedEnabled = storage.get(STORE.enabled, true);
  let active = savedEnabled !== false && savedEnabled !== 'false';
  let stopped = false;
  let username = storage.get(STORE.username, '');
  let csrf = '';
  let currentTopic = null;
  let topicTicksLeft = 0;
  let lastSummaryAt = 0;
  let lastKnownRead = 0;
  let lastError = '';
  let nextTickAt = 0;
  let tickTimer = null;
  let heartbeatTimer = null;
  let lastTickAt = 0;

  function log(...args) {
    if (CFG.debug) console.log('[NodeLoc 阅读时长]', ...args);
  }

  function isLoginRedirect(response) {
    try {
      return response.redirected && new URL(response.url).pathname.startsWith('/login');
    } catch (_) {
      return false;
    }
  }

  async function request(path, options = {}) {
    const headers = Object.assign(
      { 'X-Requested-With': 'XMLHttpRequest' },
      options.headers || {}
    );
    const response = await fetch(path, Object.assign({ credentials: 'same-origin' }, options, { headers }));
    if (isLoginRedirect(response)) throw new Error('LOGIN_REQUIRED');
    return response;
  }

  async function requestJson(path, options = {}) {
    const response = await request(path, options);
    if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`${path} 返回了非 JSON 内容`);
    }
  }

  async function getCsrf() {
    if (csrf) return csrf;
    const data = await requestJson('/session/csrf.json');
    if (!data.csrf) throw new Error('无法获取 CSRF');
    csrf = data.csrf;
    return csrf;
  }

  async function resolveUsername() {
    if (username) return username;

    // /my/summary 会重定向到 /u/<username>/summary；从最终 URL 里拿用户名最稳。
    try {
      const response = await fetch('/my/summary', { credentials: 'same-origin', redirect: 'follow' });
      const path = new URL(response.url).pathname;
      const match = path.match(/^\/u\/([^/]+)\//);
      if (match) {
        username = decodeURIComponent(match[1]);
        storage.set(STORE.username, username);
        return username;
      }
    } catch (_) {}

    // 兼容部分 Discourse 版本提供的账号 JSON。
    for (const path of ['/my/preferences/account.json', '/u/current/preferences/account.json']) {
      try {
        const response = await request(path);
        if (!response.ok) continue;
        const data = await response.json();
        const candidate = data && data.user && data.user.username;
        if (candidate) {
          username = candidate;
          storage.set(STORE.username, username);
          return username;
        }
      } catch (_) {}
    }

    // 最后从页面数据里兜底。
    try {
      const preloaded = document.getElementById('data-preloaded');
      if (preloaded && preloaded.textContent) {
        const data = JSON.parse(preloaded.textContent);
        for (const key of ['currentUser', 'current_user']) {
          if (!data[key]) continue;
          const user = typeof data[key] === 'string' ? JSON.parse(data[key]) : data[key];
          if (user && user.username) {
            username = user.username;
            storage.set(STORE.username, username);
            return username;
          }
        }
      }
    } catch (_) {}

    throw new Error('LOGIN_REQUIRED');
  }

  async function readSummary() {
    if (!username) await resolveUsername();
    if (!username) throw new Error('LOGIN_REQUIRED');
    const data = await requestJson(`/u/${encodeURIComponent(username)}/summary.json`);
    const seconds = Number(data && data.user_summary && data.user_summary.time_read);
    if (!Number.isFinite(seconds)) throw new Error('无法读取阅读时长');
    lastKnownRead = seconds;
    storage.set(STORE.totalRead, seconds);
    lastSummaryAt = Date.now();
    return seconds;
  }

  async function loadTopics() {
    const data = await requestJson('/latest.json?no_definitions=true&page=0');
    const rows = data && data.topic_list && data.topic_list.topics;
    if (!Array.isArray(rows)) throw new Error('话题列表异常');
    return rows.filter((topic) => {
      return topic && topic.id && topic.visible !== false && topic.closed !== true && Number(topic.posts_count) > 1;
    }).slice(0, 40);
  }

  async function chooseTopic() {
    const topics = await loadTopics();
    if (!topics.length) throw new Error('没有可用话题');
    const topic = topics[rand(0, topics.length - 1)];
    const postsCount = Math.max(2, Math.min(Number(topic.posts_count) || 2, 200));
    const firstPost = rand(1, Math.max(1, Math.min(postsCount - 1, 20)));
    const postQueue = [];
    for (let i = 0; i < rand(CFG.sessionMinTicks, CFG.sessionMaxTicks); i += 1) {
      postQueue.push(((firstPost - 1 + i) % postsCount) + 1);
    }

    // 真正打开一次话题页，正常累计“进入话题数”，也顺便确认话题可访问。
    try {
      await request(`/t/${topic.id}.json?track_visit=true&forceLoad=true`);
    } catch (error) {
      log('话题预热失败，跳过本次话题', topic.id, error.message);
    }

    currentTopic = {
      id: topic.id,
      title: topic.title || '',
      postsCount,
      postQueue,
      startedAt: Date.now()
    };
    topicTicksLeft = postQueue.length;
    log('切换话题', currentTopic.id, currentTopic.title.slice(0, 30), '本轮', topicTicksLeft, '次');
    return currentTopic;
  }

  async function sendTiming(seconds) {
    if (!currentTopic || topicTicksLeft <= 0) await chooseTopic();
    const topic = currentTopic;
    const postNumber = topic.postQueue.shift();
    topicTicksLeft -= 1;

    const msecs = Math.max(45000, Math.min(59500, Math.round(seconds * 1000) + rand(-3500, 1500)));
    const params = new URLSearchParams();
    params.set('topic_id', String(topic.id));
    params.set('topic_time', String(msecs));
    params.set(`timings[${postNumber}]`, String(msecs));

    const token = await getCsrf();
    const response = await request('/topics/timings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRF-Token': token,
        'X-Silence-Logger': 'true',
        'Discourse-Background': 'true'
      },
      body: params.toString()
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After')) || 60;
      throw Object.assign(new Error('RATE_LIMITED'), { retryAfter });
    }
    if (response.status === 403 || response.status === 404) {
      csrf = '';
      throw new Error(`WRITE_FAILED_${response.status}`);
    }
    if (!response.ok) throw new Error(`timings HTTP ${response.status}`);

    lastTickAt = Date.now();
    log('已提交', topic.id, '#' + postNumber, msecs + 'ms');
  }

  function renderPanel() {
    let panel = document.getElementById('nl-readtime-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'nl-readtime-panel';
      panel.innerHTML = '<div class="nlrt-title">NodeLoc 计时</div><div class="nlrt-main">初始化…</div><div class="nlrt-sub"></div>';
      document.body.appendChild(panel);
    }
    const main = panel.querySelector('.nlrt-main');
    const sub = panel.querySelector('.nlrt-sub');
    const minutes = Math.floor(lastKnownRead / 60);
    const remaining = Math.max(0, CFG.targetMinutes - minutes);
    main.textContent = `${minutes} / ${CFG.targetMinutes} 分钟 · 还差 ${remaining} 分钟`;
    if (lastError) sub.textContent = lastError;
    else if (!active) sub.textContent = '已暂停（Tampermonkey 菜单可继续）';
    else if (nextTickAt) sub.textContent = `下次 ${Math.max(1, Math.ceil((nextTickAt - Date.now()) / 1000))} 秒`;
    else sub.textContent = '准备中';
    panel.dataset.state = active ? 'running' : 'paused';
  }

  function setStatus(error) {
    lastError = error ? String(error.message || error).slice(0, 80) : '';
    renderPanel();
  }

  function readLock() {
    try {
      return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function writeLock() {
    const now = Date.now();
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, until: now + CFG.leaderTtlMs, updatedAt: now }));
  }

  function leaderAlive() {
    const lock = readLock();
    if (!lock || lock.id === TAB_ID) return false;
    const updatedAt = Number(lock.updatedAt) || 0;
    // Old versions wrote only "until"; treat them as stale so a reopened browser can take over.
    if (!updatedAt) return false;
    return Number(lock.until) > Date.now() && Date.now() - updatedAt < CFG.leaderTtlMs;
  }

  function claimLeader() {
    if (leaderAlive()) return false;
    writeLock();
    return true;
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!active || stopped) return;
      const lock = readLock();
      if (lock && lock.id === TAB_ID) writeLock();
    }, CFG.leaderHeartbeatMs);
  }

  async function tick(firstRun) {
    if (stopped || !active) return;
    if (!claimLeader()) {
      setStatus('另一个标签页正在运行，此页待机');
      return schedule(10000);
    }

    try {
      if (!csrf) await getCsrf();
      if (!username) await resolveUsername();

      const now = Date.now();
      if (firstRun || now - lastSummaryAt > CFG.summaryEveryMs || lastKnownRead === 0) {
        await readSummary();
        if (lastKnownRead >= CFG.targetMinutes * 60) {
          finish('目标已完成');
          return;
        }
      }

      const elapsedSec = lastTickAt ? Math.max(50, Math.min(70, (now - lastTickAt) / 1000)) : 60;
      await sendTiming(elapsedSec);
      lastError = '';
      renderPanel();
    } catch (error) {
      if (String(error.message) === 'LOGIN_REQUIRED') {
        setStatus('请先登录 NodeLoc');
        finish('未登录');
        return;
      }
      if (String(error.message) === 'RATE_LIMITED') {
        const waitMs = Math.max(60000, Number(error.retryAfter) * 1000 + rand(5000, 15000));
        setStatus(`触发限速，${Math.round(waitMs / 1000)} 秒后继续`);
        return schedule(waitMs);
      }
      setStatus(error);
      log('本轮失败', error);
    }
    schedule(rand(CFG.tickMinMs, CFG.tickMaxMs));
  }

  function schedule(delay) {
    if (stopped) return;
    clearTimeout(tickTimer);
    nextTickAt = Date.now() + delay;
    renderPanel();
    tickTimer = setTimeout(() => tick(false), delay);
  }

  function finish(reason) {
    stopped = true;
    clearTimeout(tickTimer);
    clearInterval(heartbeatTimer);
    try { localStorage.removeItem(LEADER_KEY); } catch (_) {}
    lastError = reason;
    renderPanel();
    log('结束', reason);
  }

  function setActive(value) {
    active = !!value;
    storage.set(STORE.enabled, active);
    if (active) {
      stopped = false;
      lastError = '';
      startHeartbeat();
      tick(true);
    } else {
      clearTimeout(tickTimer);
      clearInterval(heartbeatTimer);
      try { localStorage.removeItem(LEADER_KEY); } catch (_) {}
      renderPanel();
    }
  }

  function installStyle() {
    const style = document.createElement('style');
    style.textContent = `
      #nl-readtime-panel{position:fixed;right:16px;bottom:16px;z-index:999999;min-width:220px;padding:10px 12px;border-radius:10px;background:rgba(20,22,26,.92);color:#fff;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(6px)}
      #nl-readtime-panel .nlrt-title{font-weight:600;font-size:12px;color:#9fe3b2;margin-bottom:2px}
      #nl-readtime-panel .nlrt-main{font-weight:600}
      #nl-readtime-panel .nlrt-sub{color:#aab3c0;font-size:11px;margin-top:2px}
      #nl-readtime-panel[data-state="paused"] .nlrt-title{color:#f0c36d}
    `;
    document.head.appendChild(style);
  }

  function boot() {
    installStyle();
    renderPanel();
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('暂停/继续 NodeLoc 计时', () => setActive(!active));
      GM_registerMenuCommand('立即停止 NodeLoc 计时', () => finish('手动停止'));
    }
    if (!active) {
      renderPanel();
      return;
    }
    startHeartbeat();
    setTimeout(() => tick(true), rand(2000, 5000));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
