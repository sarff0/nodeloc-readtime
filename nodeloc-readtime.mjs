#!/usr/bin/env node

/**
 * NodeLoc 阅读时长后台助手（CLI 版）
 *
 * 用法：
 *   node nodeloc-readtime.mjs --cookie-file cookies.json
 *   node nodeloc-readtime.mjs --cookie "name=value; name2=value2"
 *   set NODELOC_COOKIE=name=value; name2=value2 && node nodeloc-readtime.mjs
 *
 * cookies.json 可直接使用 Cookie-Editor 的 Export -> JSON 导出文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASE = (argValue('--base', process.env.NODELOC_BASE || 'https://www.nodeloc.com')).replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const TARGET_MINUTES = Number(argValue('--target', process.env.NODELOC_TARGET || '600'));
const INTERVAL_MIN_MS = Number(argValue('--interval-min', '58000'));
const INTERVAL_MAX_MS = Number(argValue('--interval-max', '76000'));
const COOKIE_FILE = argValue('--cookie-file', process.env.NODELOC_COOKIE_FILE || '');
const COOKIE_ARG = argValue('--cookie', process.env.NODELOC_COOKIE || '');
const LOG_FILE = path.resolve(argValue('--log', 'nodeloc-readtime.log'));
const STATE_FILE = path.resolve(argValue('--state', 'nodeloc-readtime-state.json'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch (_) {}
}

function describeError(error) {
  if (!error) return '未知错误';
  const cause = error.cause ? `（${error.cause.code || error.cause.message || error.cause}）` : '';
  return `${error.message || error}${cause}`;
}

function parseCookie(raw) {
  const value = String(raw || '').trim().replace(/^Cookie:\s*/i, '');
  if (!value) throw new Error('Cookie 为空');

  if (value.startsWith('[') || value.startsWith('{')) {
    const parsed = JSON.parse(value);
    const list = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(list)) throw new Error('Cookie JSON 格式不正确');
    const parts = list
      .filter((cookie) => cookie && cookie.name && cookie.value !== undefined)
      .map((cookie) => `${cookie.name}=${cookie.value}`);
    if (!parts.length) throw new Error('Cookie JSON 中没有有效项');
    return parts.join('; ');
  }

  if (value.includes('\t')) {
    const parts = [];
    for (const line of value.split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const fields = text.split('\t');
      if (fields.length >= 7) parts.push(`${fields[5]}=${fields[6]}`);
    }
    if (parts.length) return parts.join('; ');
  }

  return value.replace(/\r?\n/g, '; ');
}

function loadCookie() {
  if (COOKIE_ARG) return parseCookie(COOKIE_ARG);

  const candidates = COOKIE_FILE
    ? [COOKIE_FILE]
    : ['cookies.json', 'cookie.json', 'cookies.txt', 'cookie.txt'];

  for (const candidate of candidates) {
    const full = path.resolve(candidate);
    if (fs.existsSync(full)) {
      log(`读取 Cookie 文件：${full}`);
      return parseCookie(fs.readFileSync(full, 'utf8'));
    }
  }
  throw new Error('未找到 Cookie。请用 Cookie-Editor 导出 cookies.json，或用 --cookie 传入。');
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`NodeLoc 阅读时长后台助手

用法:
  node nodeloc-readtime.mjs --cookie-file cookies.json
  node nodeloc-readtime.mjs --cookie "name=value; name2=value2"

参数:
  --cookie-file <path>    Cookie-Editor 导出的 JSON 文件（默认自动找 cookies.json）
  --cookie <string>       Cookie 字符串
  --target <minutes>      目标分钟数，默认 600
  --interval-min <ms>     最短间隔，默认 58000
  --interval-max <ms>     最长间隔，默认 76000
  --log <path>            日志文件
  --state <path>          状态文件
`);
  process.exit(0);
}

const cookie = loadCookie();
let csrf = '';
let username = '';
let lastTickAt = 0;
let lastReadSeconds = 0;

function isLoginHtml(response, text) {
  const finalUrl = response.url || '';
  try {
    if (new URL(finalUrl).pathname.startsWith('/login')) return true;
  } catch (_) {}
  return /<title>[^<]*(登录|Log In)/i.test(text) || text.includes('not_logged_in');
}

async function request(apiPath, options = {}) {
  const response = await fetch(`${BASE}${apiPath}`, {
    ...options,
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'Cookie': cookie,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });
  return response;
}

async function readText(response) {
  return response.text();
}

async function getCsrf() {
  if (csrf) return csrf;
  const response = await request('/session/csrf.json', {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  const text = await readText(response);
  if (!response.ok) throw new Error(`获取 CSRF 失败：HTTP ${response.status}`);
  const data = JSON.parse(text);
  if (!data.csrf) throw new Error('服务器没有返回 CSRF');
  csrf = data.csrf;
  return csrf;
}

async function resolveUsername() {
  if (username) return username;

  const account = await request('/my/preferences/account.json', {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  const accountText = await readText(account);
  if (!isLoginHtml(account, accountText)) {
    try {
      const data = JSON.parse(accountText);
      if (data.user?.username) {
        username = data.user.username;
        return username;
      }
    } catch (_) {}
  }

  const my = await request('/my/summary');
  const myText = await readText(my);
  if (!isLoginHtml(my, myText)) {
    try {
      const match = new URL(my.url).pathname.match(/^\/u\/([^/]+)\//);
      if (match) {
        username = decodeURIComponent(match[1]);
        return username;
      }
    } catch (_) {}
  }

  throw new Error('Cookie 已失效或未登录 NodeLoc');
}

async function getSummary() {
  if (!username) await resolveUsername();
  const response = await request(`/u/${encodeURIComponent(username)}/summary.json`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  const text = await readText(response);
  if (!response.ok) throw new Error(`读取 summary 失败：HTTP ${response.status}`);
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error('summary 返回非 JSON，Cookie 可能已失效'); }
  const seconds = Number(data.user_summary?.time_read);
  if (!Number.isFinite(seconds)) throw new Error('summary 中没有 time_read');
  lastReadSeconds = seconds;
  return seconds;
}

async function getTopics() {
  const response = await request('/latest.json?no_definitions=true&page=0', {
    headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!response.ok) throw new Error(`读取话题失败：HTTP ${response.status}`);
  const data = await response.json();
  const topics = data.topic_list?.topics;
  if (!Array.isArray(topics)) throw new Error('话题列表格式异常');
  return topics.filter((topic) => topic && topic.id && topic.visible !== false && topic.closed !== true && Number(topic.posts_count) > 1).slice(0, 40);
}

async function warmTopic(topicId) {
  try {
    const response = await request(`/t/${topicId}.json?track_visit=true&forceLoad=true`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    await response.text();
  } catch (_) {}
}

async function sendTiming(topic, postNumber, seconds) {
  const msecs = Math.max(45000, Math.min(59500, Math.round(seconds * 1000) + rand(-3500, 1500)));
  const body = new URLSearchParams();
  body.set('topic_id', String(topic.id));
  body.set('topic_time', String(msecs));
  body.set(`timings[${postNumber}]`, String(msecs));

  const token = await getCsrf();
  const response = await request('/topics/timings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'X-CSRF-Token': token,
      'X-Silence-Logger': 'true',
      'Discourse-Background': 'true'
    },
    body: body.toString()
  });

  const text = await response.text();
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || 60;
    throw Object.assign(new Error('RATE_LIMITED'), { retryAfter });
  }
  if (!response.ok) {
    if (isLoginHtml(response, text)) throw new Error('Cookie 已失效或未登录 NodeLoc');
    throw new Error(`提交 timings 失败：HTTP ${response.status}`);
  }
  lastTickAt = Date.now();
  log(`已提交 topic=${topic.id} post=${postNumber} msecs=${msecs}`);
}

function saveState(extra = {}) {
  const state = {
    updatedAt: new Date().toISOString(),
    targetMinutes: TARGET_MINUTES,
    timeReadMinutes: Math.round((lastReadSeconds / 60) * 10) / 10,
    remainingMinutes: Math.max(0, Math.round((TARGET_MINUTES - lastReadSeconds / 60) * 10) / 10),
    ...extra
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) {}
}

async function main() {
  log(`启动：目标 ${TARGET_MINUTES} 分钟；日志 ${LOG_FILE}`);
  await getCsrf();
  await resolveUsername();
  const startSeconds = await getSummary();
  log(`当前用户 ${username}，阅读时长 ${(startSeconds / 60).toFixed(1)} 分钟`);

  if (startSeconds >= TARGET_MINUTES * 60) {
    log('目标已达成，无需运行');
    return;
  }

  let topics = await getTopics();
  let topicIndex = 0;
  let topic = null;
  let postQueue = [];
  let sessionTicks = 0;

  while (true) {
    let current = await getSummary();
    saveState();
    if (current >= TARGET_MINUTES * 60) {
      log('已达到目标，停止');
      break;
    }

    if (!topics.length) topics = await getTopics();
    if (!topic || sessionTicks <= 0) {
      topic = topics[topicIndex % topics.length];
      topicIndex += 1;
      const count = Math.max(2, Math.min(Number(topic.posts_count) || 2, 200));
      const first = rand(1, Math.max(1, Math.min(count - 1, 20)));
      sessionTicks = rand(3, 5);
      postQueue = Array.from({ length: sessionTicks }, (_, i) => ((first - 1 + i) % count) + 1);
      await warmTopic(topic.id);
      log(`切换话题 ${topic.id}「${String(topic.title || '').slice(0, 30)}」，本轮 ${sessionTicks} 次`);
    }

    const postNumber = postQueue.shift();
    const seconds = lastTickAt ? Math.max(50, Math.min(70, (Date.now() - lastTickAt) / 1000)) : 60;
    try {
      await sendTiming(topic, postNumber, seconds);
      sessionTicks -= 1;
    } catch (error) {
      if (String(error.message) === 'RATE_LIMITED') {
        const waitMs = Math.max(60000, Number(error.retryAfter) * 1000 + rand(5000, 15000));
        log(`触发限速，等待 ${Math.round(waitMs / 1000)} 秒`);
        await sleep(waitMs);
        continue;
      }
      log(`本轮失败：${describeError(error)}`);
      if (/Cookie 已失效|未登录/.test(describeError(error))) throw error;
      await sleep(rand(30000, 60000));
      continue;
    }

    const wait = rand(INTERVAL_MIN_MS, INTERVAL_MAX_MS);
    log(`下次 ${Math.round(wait / 1000)} 秒后`);
    await sleep(wait);
  }
}

process.on('SIGINT', () => {
  log('收到 Ctrl+C，保存状态退出');
  saveState({ stopped: true });
  process.exit(0);
});

main().catch((error) => {
  const message = describeError(error);
  log(`停止：${message}`);
  saveState({ error: message });
  process.exitCode = 1;
});
