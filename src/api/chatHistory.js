import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_DIR = path.join(__dirname, '..', '..', 'session', 'history');

const MAX_HISTORY_LENGTH = 100;

export function initHistoryDirectory() {
    if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        console.log(`Создана директория для истории чатов: ${HISTORY_DIR}`);
    }
}

export function generateChatId() {
    return crypto.randomUUID();
}

export function createChat() {
    const chatId = generateChatId();
    saveHistory(chatId, []);
    return chatId;
}

function getHistoryFilePath(chatId) {
    return path.join(HISTORY_DIR, `${chatId}.json`);
}

export function saveHistory(chatId, messages) {
    try {
        initHistoryDirectory();
        const historyFilePath = getHistoryFilePath(chatId);
        fs.writeFileSync(historyFilePath, JSON.stringify(messages, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Ошибка при сохранении истории чата ${chatId}:`, error);
        return false;
    }
}

export function loadHistory(chatId) {
    try {
        const historyFilePath = getHistoryFilePath(chatId);
        if (fs.existsSync(historyFilePath)) {
            const history = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));
            return history;
        }
    } catch (error) {
        console.error(`Ошибка при загрузке истории чата ${chatId}:`, error);
    }
    return [];
}

export function chatExists(chatId) {
    const historyFilePath = getHistoryFilePath(chatId);
    return fs.existsSync(historyFilePath);
}

export function addUserMessage(chatId, content) {
    const timestamp = Math.floor(Date.now() / 1000);
    const messageId = crypto.randomUUID();

    const message = {
        id: messageId,
        role: "user",
        content: content,
        timestamp: timestamp,
        chat_type: "t2t"
    };

    return addMessageToHistory(chatId, message);
}

export function addAssistantMessage(chatId, content, info = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const messageId = crypto.randomUUID();

    const message = {
        id: messageId,
        role: "assistant",
        content: content,
        timestamp: timestamp,
        info: info,
        chat_type: "t2t"
    };

    return addMessageToHistory(chatId, message);
}

function addMessageToHistory(chatId, message) {
    try {
        let history = loadHistory(chatId);

        if (history.length >= MAX_HISTORY_LENGTH) {
            history = [history[0], ...history.slice(history.length - MAX_HISTORY_LENGTH + 2)];
        }

        history.push(message);
        saveHistory(chatId, history);

        return message.id;
    } catch (error) {
        console.error(`Ошибка при добавлении сообщения в историю чата ${chatId}:`, error);
        return null;
    }
}

export function getAllChats() {
    try {
        initHistoryDirectory();
        const files = fs.readdirSync(HISTORY_DIR);
        return files
            .filter(file => file.endsWith('.json'))
            .map(file => file.replace('.json', ''));
    } catch (error) {
        console.error('Ошибка при получении списка чатов:', error);
        return [];
    }
}

export function deleteChat(chatId) {
    try {
        const historyFilePath = getHistoryFilePath(chatId);
        if (fs.existsSync(historyFilePath)) {
            fs.unlinkSync(historyFilePath);
            return true;
        }
    } catch (error) {
        console.error(`Ошибка при удалении чата ${chatId}:`, error);
    }
    return false;
} 