#!/usr/bin/env node
// Capture the Aliyun Baxia anti-bot headers that Qwen's web UI sends with
// /api/v2/chat/completions. The proxy replays them from the page context,
// because the WAF rejects the same request coming from plain Node.
//
// Usage:
//   1. Start Chrome with --remote-debugging-port=9222 and log in to chat.qwen.ai
//   2. QWEN_CDP_URL=http://127.0.0.1:9222 node scripts/capture-baxia.mjs
//   3. Send one message in the Qwen tab
//
// The captured headers are written to session/baxia.json (override with
// BAXIA_OUT=/path/to/baxia.json). They are bound to the browser profile and
// stay valid for the session; recapture after logout or a profile switch.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const CDP_URL = process.env.QWEN_CDP_URL || 'http://127.0.0.1:9222';
const OUT = process.env.BAXIA_OUT || path.join(process.cwd(), 'session', 'baxia.json');
const TIMEOUT_MS = Number(process.env.BAXIA_TIMEOUT_MS) || 10 * 60 * 1000;
const TARGET = /\/api\/v2\/chat\/completions/;

// Keep exactly what loadBaxiaHeaders() replays; never persist cookies or tokens.
const KEEP = /^(bx-|sec-ch-|accept-language$|timezone$|version$|source$|x-request-id$)/i;
const DROP = /^(cookie|authorization|content-length|host|connection)$/i;

function filterHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (DROP.test(key)) continue;
        if (KEEP.test(key)) out[key] = String(value);
    }
    return out;
}

function save(headers, url) {
    if (!headers['bx-ua'] && !headers['bx-umidtoken']) return false;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({
        capturedAt: new Date().toISOString(),
        url,
        headers
    }, null, 2));
    return true;
}

const browser = await puppeteer.connect({ browserURL: CDP_URL });
const pages = await browser.pages();
let page = pages.find(p => p.url().includes('chat.qwen.ai'));

if (!page) {
    page = pages.find(p => p.url() === 'about:blank') || await browser.newPage();
    console.log('Открываю chat.qwen.ai...');
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
}

const cdp = await page.target().createCDPSession();
await cdp.send('Network.enable');

const pending = new Map();

cdp.on('Network.requestWillBeSent', event => {
    if (!TARGET.test(event.request.url)) return;
    pending.set(event.requestId, {
        url: event.request.url,
        headers: event.request.headers
    });
    console.log('Поймал completions-запрос, жду заголовки...');
});

cdp.on('Network.requestWillBeSentExtraInfo', event => {
    const request = pending.get(event.requestId);
    if (!request) return;

    const headers = filterHeaders({ ...request.headers, ...event.headers });
    if (!save(headers, request.url)) {
        console.log('В запросе нет bx-ua/bx-umidtoken — похоже, WAF пропустил его без проверки.');
        return;
    }

    console.log(`Сохранено в ${OUT}`);
    console.log('Заголовки:', Object.keys(headers).sort().join(', '));
    process.exit(0);
});

console.log(`Слушаю сеть вкладки: ${page.url()}`);
console.log('Отправьте одно сообщение в окне Qwen и дождитесь запроса completions.');
console.log(`Таймаут: ${Math.round(TIMEOUT_MS / 1000)} с.`);

setTimeout(() => {
    console.error('Не дождался запроса /api/v2/chat/completions.');
    process.exit(1);
}, TIMEOUT_MS);
