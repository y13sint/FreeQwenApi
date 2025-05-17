import { chromium } from 'playwright';
import { saveSession, loadSession, hasSession, saveAuthToken } from './session.js';
import { checkAuthentication, startManualAuthentication } from './auth.js';
import { clearPagePool, getAuthToken } from '../api/chat.js';

let browserInstance = null;
let browserContext = null;

export let isAuthenticated = false;

export async function initBrowser(visibleMode = true) {
    if (!browserInstance) {
        console.log('Инициализация браузера...');
        try {
            browserInstance = await chromium.launch({
                headless: !visibleMode,  
                slowMo: visibleMode ? 50 : 0,  
            });

            browserContext = await browserInstance.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 800 },
                deviceScaleFactor: 1,
            });

            console.log('Браузер инициализирован успешно');

            if (visibleMode) {
                await startManualAuthentication(browserContext);
            } else {
                await loadSession(browserContext);
            }

            return true;
        } catch (error) {
            console.error('Ошибка при инициализации браузера:', error);
            return false;
        }
    }
    return true;
}

export async function restartBrowserInHeadlessMode() {
    console.log('Перезапуск браузера в фоновом режиме...');

    const token = getAuthToken();
    if (token) {
        console.log('Сохранение токена перед перезапуском браузера...');
        saveAuthToken(token);
        await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
        console.warn('Предупреждение: Токен не был извлечен перед перезапуском браузера');
    }

    await saveSession(browserContext);

    await new Promise(resolve => setTimeout(resolve, 1000));

    await shutdownBrowser();

    await new Promise(resolve => setTimeout(resolve, 1000));

    await initBrowser(false);

    console.log('Браузер перезапущен в фоновом режиме');
}


export async function shutdownBrowser() {
    try {
        try {
            await clearPagePool();
        } catch (e) {
            console.error('Ошибка при очистке пула страниц:', e);
        }

        if (browserContext) {
            try {
                await browserContext.close();
            } catch (e) {
                console.error('Ошибка при закрытии контекста браузера:', e);
            }
        }

        if (browserInstance) {
            try {
                await browserInstance.close();
            } catch (e) {
                console.error('Ошибка при закрытии браузера:', e);
            }
        }

        browserContext = null;
        browserInstance = null;

        console.log('Браузер закрыт');
    } catch (error) {
        console.error('Ошибка при завершении работы браузера:', error);
    }
}

export function getBrowserContext() {
    return browserContext;
}

// Установить статус авторизации
export function setAuthenticationStatus(status) {
    isAuthenticated = status;
}

// Получить статус авторизации
export function getAuthenticationStatus() {
    return isAuthenticated;
} 