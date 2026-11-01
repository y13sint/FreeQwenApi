import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { saveSession, saveAuthToken } from './session.js';
import { startManualAuthentication } from './auth.js';
import { clearPagePool, getAuthToken } from '../api/chat.js';
import fs from 'fs';
import path from 'path';
import { logInfo, logError, logWarn, logDebug } from '../logger/index.js';
import {
    CHAT_PAGE_URL, NAVIGATION_TIMEOUT, RETRY_DELAY,
    VIEWPORT_WIDTH, VIEWPORT_HEIGHT, USER_AGENT,
    SESSION_DIR, ACCOUNTS_DIR
} from '../config.js';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
export let isAuthenticated = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function initBrowser(visibleMode = true, skipManualRestart = false) {
    if (browserInstance) return true;

    const cdpUrl = (process.env.QWEN_CDP_URL || '').trim();
    logInfo(cdpUrl
        ? `Инициализация браузера: подключение к Chrome по CDP (${cdpUrl})...`
        : 'Инициализация браузера с Puppeteer Stealth...');
    try {
        if (cdpUrl) {
            // Attach to YOUR already-running, logged-in Chrome (launch it with
            // --remote-debugging-port=PORT --user-data-dir=<dir>). Reuses a
            // human-trusted session, so qwen serves no captcha and the headless
            // CDP evaluate no longer hangs — no empty-browser login required.
            browserInstance = await puppeteer.connect({
                browserURL: cdpUrl,
                defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }
            });
        } else {
            browserInstance = await puppeteer.launch({
                headless: !visibleMode,
                slowMo: visibleMode ? 30 : 0,
                executablePath: process.env.CHROME_PATH || undefined,
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage', '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
                    '--start-maximized', '--disable-infobars',
                    '--disable-extensions', '--disable-gpu',
                    '--no-first-run', '--no-default-browser-check',
                    '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'
                ],
                defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
                ignoreHTTPSErrors: true
            });
        }

        // In CDP mode open a fresh tab (don't hijack the user's current tab).
        const page = cdpUrl
            ? await browserInstance.newPage()
            : ((await browserInstance.pages())[0] || await browserInstance.newPage());

        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [{ 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }, description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 1, name: 'Chrome PDF Plugin' }]
            });
            Object.defineProperty(navigator, 'connection', {
                get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false })
            });
            if (!navigator.getBattery) {
                navigator.getBattery = () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 });
            }

            const originalAddEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, listener, options) {
                if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup') {
                    const wrappedListener = function (event) { setTimeout(() => listener.call(this, event), Math.random() * 3); };
                    return originalAddEventListener.call(this, type, wrappedListener, options);
                }
                return originalAddEventListener.call(this, type, listener, options);
            };

            const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (type) {
                const context = this.getContext('2d');
                if (context) {
                    const imageData = context.getImageData(0, 0, this.width, this.height);
                    const data = imageData.data;
                    for (let i = 0; i < data.length; i += 4) {
                        const noise = Math.floor(Math.random() * 5) - 2;
                        data[i] = Math.max(0, Math.min(255, data[i] + noise));
                        data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
                        data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
                    }
                    context.putImageData(imageData, 0, 0);
                }
                return originalToDataURL.apply(this, arguments);
            };
        });

        browserContext = page;
        logInfo('Браузер инициализирован с максимальной защитой от обнаружения');

        // CDP-connected Chrome is already a real, logged-in session — skip the
        // interactive empty-browser login/captcha flow.
        if (visibleMode && !cdpUrl) {
            await startManualAuthenticationPuppeteer(page, skipManualRestart);
        }
        // loadSessionPuppeteer removed — was dead code (always returned false)

        return true;
    } catch (error) {
        logError('Ошибка при инициализации браузера', error);
        return false;
    }
}

async function saveSessionPuppeteer(page) {
    try {
        const cookies = await page.cookies();
        const sessionDir = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

        const accountId = `acc_${Date.now()}`;
        const accountDir = path.join(sessionDir, accountId);
        if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });

        fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookies, null, 2));
        logInfo(`Cookies сохранены для аккаунта ${accountId}`);
        return accountId;
    } catch (error) {
        logError('Ошибка при сохранении сессии', error);
        return null;
    }
}

async function startManualAuthenticationPuppeteer(page, skipManualRestart) {
    try {
        logInfo('Открытие страницы для ручной авторизации...');
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT });
        await delay(5000);

        console.log('------------------------------------------------------');
        console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
        console.log('------------------------------------------------------');
        console.log('Пожалуйста, выполните следующие действия:');
        console.log('1. Войдите в систему в открытом браузере');
        console.log('2. ВАЖНО: Двигайте мышью естественно, не спешите');
        console.log('3. Если появится слайдер капчи - решите её медленно');
        console.log('4. Дождитесь полной загрузки главной страницы');
        console.log('5. После успешной авторизации нажмите ENTER в консоли');
        console.log('------------------------------------------------------');
        console.log('После успешной авторизации нажмите ENTER для продолжения...');

        await new Promise((resolve) => {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');
            const onData = (key) => {
                if (key === '\n' || key === '\r' || key.charCodeAt(0) === 13) {
                    process.stdin.pause();
                    process.stdin.removeListener('data', onData);
                    logInfo('Получено подтверждение, продолжаем...');
                    resolve();
                }
            };
            process.stdin.on('data', onData);
        });

        const cookies = await page.cookies();
        logInfo(`Сохранено ${cookies.length} cookies`);

        const token = await page.evaluate(() =>
            localStorage.getItem('token') || localStorage.getItem('auth_token') ||
            localStorage.getItem('access_token') || sessionStorage.getItem('token') ||
            sessionStorage.getItem('auth_token') || null
        );

        if (token) {
            logInfo('Токен найден и будет сохранен');
            saveAuthToken(token);
        } else {
            logWarn('Токен не найден в localStorage/sessionStorage');
            logInfo('Попытка извлечь токен из cookies...');
            const tokenCookie = cookies.find(c => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('auth'));
            if (tokenCookie) {
                logInfo(`Токен найден в cookie: ${tokenCookie.name}`);
                saveAuthToken(tokenCookie.value);
            }
        }

        const accountId = await saveSessionPuppeteer(page);
        if (accountId) logInfo(`Сессия сохранена с ID: ${accountId}`);

        setAuthenticationStatus(true);
        logInfo('Авторизация завершена успешно');

        if (!skipManualRestart) await restartBrowserInHeadlessMode();
    } catch (error) {
        logError('Ошибка при ручной авторизации', error);
        throw error;
    }
}

export async function restartBrowserInHeadlessMode() {
    logInfo('Перезапуск браузера в фоновом режиме...');
    const token = getAuthToken();
    if (token) { logDebug('Сохранение токена...'); saveAuthToken(token); await delay(1000); }
    await shutdownBrowser();
    await delay(RETRY_DELAY);
    const success = await initBrowser(false);
    logInfo(success ? 'Браузер перезапущен в фоновом режиме' : 'Ошибка при перезапуске браузера');
}

export async function shutdownBrowser() {
    try {
        try { await clearPagePool(); } catch (e) { logError('Ошибка при очистке пула страниц', e); }

        const cdpUrl = (process.env.QWEN_CDP_URL || '').trim();
        if (browserInstance && cdpUrl) {
            // В CDP-режиме browser.close() завершил бы сам Chrome пользователя —
            // только отключаемся.
            try { browserInstance.disconnect(); } catch (e) { logError('Ошибка при отключении от Chrome', e); }
        } else if (browserInstance) {
            try {
                const pages = await browserInstance.pages();
                for (const page of pages) await page.close().catch(() => {});
                await browserInstance.close();
            } catch (e) { logError('Ошибка при закрытии браузера', e); }
        }
        browserContext = null;
        browserInstance = null;
        logInfo('Браузер закрыт');
    } catch (error) {
        logError('Ошибка при завершении работы браузера', error);
    }
}

// Проверяет, живо ли CDP-соединение с Chrome, и при необходимости
// переподключается (например, после падения/перезапуска браузера).
export async function ensureBrowserConnection() {
    if (browserInstance && browserInstance.isConnected()) return true;

    logWarn('Соединение с Chrome потеряно, переподключаемся...');
    try { browserInstance?.disconnect?.(); } catch { /* already gone */ }
    browserInstance = null;
    browserContext = null;
    try { await clearPagePool(); } catch { /* pages are dead anyway */ }

    return await initBrowser(false, true);
}

export function getBrowserContext() { return browserContext; }
export function setAuthenticationStatus(status) { isAuthenticated = status; }
export function getAuthenticationStatus() { return isAuthenticated; }
