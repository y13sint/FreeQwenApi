
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_DIR = path.join(__dirname, '..', '..', 'session');
const TOKEN_FILE = path.join(SESSION_DIR, 'auth_token.txt');

export function initSessionDirectory() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        console.log(`Создана директория для сессий: ${SESSION_DIR}`);
    }
}

export async function saveSession(context) {
    try {
        initSessionDirectory();

        if (context && context.browser()) {
            const sessionPath = path.join(SESSION_DIR, 'state.json');
            await context.storageState({ path: sessionPath });
            console.log('Сессия сохранена');
            return true;
        }
    } catch (error) {
        console.error('Ошибка при сохранении сессии:', error);
    }
    return false;
}

export async function loadSession(context) {
    try {
        const sessionPath = path.join(SESSION_DIR, 'state.json');
        if (fs.existsSync(sessionPath)) {
            await context.storageState({ path: sessionPath });
            console.log('Сессия загружена');
            return true;
        }
    } catch (error) {
        console.error('Ошибка при загрузке сессии:', error);
    }
    return false;
}

export function clearSession() {
    try {
        const sessionPath = path.join(SESSION_DIR, 'state.json');
        if (fs.existsSync(sessionPath)) {
            fs.unlinkSync(sessionPath);
            console.log('Сессия очищена');
            return true;
        }
    } catch (error) {
        console.error('Ошибка при очистке сессии:', error);
    }
    return false;
}

export function hasSession() {
    const sessionPath = path.join(SESSION_DIR, 'state.json');
    return fs.existsSync(sessionPath);
}

export function saveAuthToken(token) {
    try {
        initSessionDirectory();

        if (token) {
            fs.writeFileSync(TOKEN_FILE, token, 'utf8');
            console.log('Токен авторизации сохранен');
            return true;
        }
    } catch (error) {
        console.error('Ошибка при сохранении токена авторизации:', error);
    }
    return false;
}

export function loadAuthToken() {
    try {
        if (fs.existsSync(TOKEN_FILE)) {
            const token = fs.readFileSync(TOKEN_FILE, 'utf8');
            console.log('Токен авторизации загружен');
            return token;
        }
    } catch (error) {
        console.error('Ошибка при загрузке токена авторизации:', error);
    }
    return null;
} 