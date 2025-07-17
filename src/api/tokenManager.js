import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let pointer = 0; 

// Директория для хранения сессий и данных аккаунтов
const SESSION_DIR = path.join(__dirname, '..', '..', 'session');
const ACCOUNTS_DIR = path.join(SESSION_DIR, 'accounts');
const TOKENS_FILE = path.join(SESSION_DIR, 'tokens.json');

function ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }
    if (!fs.existsSync(ACCOUNTS_DIR)) {
        fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    }
}

export function loadTokens() {
    ensureSessionDir();
    if (!fs.existsSync(TOKENS_FILE)) {
        return [];
    }
    try {
        const data = fs.readFileSync(TOKENS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        console.error('TokenManager: ошибка чтения tokens.json:', e);
        return [];
    }
}

export function saveTokens(tokens) {
    ensureSessionDir();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        console.error('TokenManager: ошибка сохранения tokens.json:', e);
    }
}

export async function getAvailableToken() {
    const tokens = loadTokens();
    const now = Date.now();
    const valid = tokens.filter(t => !t.resetAt || new Date(t.resetAt).getTime() <= now);
    if (!valid.length) return null;
    const token = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return token;
}

export function markRateLimited(id, hours = 24) {
    const tokens = loadTokens();
    const idx = tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
        const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        tokens[idx].resetAt = until;
        saveTokens(tokens);
    }
}

export function removeInvalidToken(id) {
    const tokens = loadTokens();
    const filtered = tokens.filter(t => t.id !== id);
    saveTokens(filtered);
} 