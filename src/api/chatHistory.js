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

export function createChat(chatName) {
    const chatId = generateChatId();
    const chatInfo = {
        id: chatId,
        name: chatName || `Новый чат ${new Date().toLocaleString()}`,
        created: Date.now(),
        messages: []
    };
    saveHistory(chatId, chatInfo);
    return chatId;
}

function getHistoryFilePath(chatId) {
    return path.join(HISTORY_DIR, `${chatId}.json`);
}

export function saveHistory(chatId, data) {
    try {
        initHistoryDirectory();
        const historyFilePath = getHistoryFilePath(chatId);
        fs.writeFileSync(historyFilePath, JSON.stringify(data, null, 2), 'utf8');
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
            const data = JSON.parse(fs.readFileSync(historyFilePath, 'utf8'));

            // Поддержка обратной совместимости со старым форматом
            if (Array.isArray(data)) {
                return {
                    id: chatId,
                    name: `Чат от ${new Date().toLocaleString()}`,
                    created: Date.now(),
                    messages: data
                };
            }

            return data;
        }
    } catch (error) {
        console.error(`Ошибка при загрузке истории чата ${chatId}:`, error);
    }
    return {
        id: chatId,
        name: `Новый чат ${new Date().toLocaleString()}`,
        created: Date.now(),
        messages: []
    };
}

export function chatExists(chatId) {
    const historyFilePath = getHistoryFilePath(chatId);
    return fs.existsSync(historyFilePath);
}

export function renameChat(chatId, newName) {
    try {
        if (!chatExists(chatId)) {
            return false;
        }

        const chatData = loadHistory(chatId);
        chatData.name = newName;
        return saveHistory(chatId, chatData);
    } catch (error) {
        console.error(`Ошибка при переименовании чата ${chatId}:`, error);
        return false;
    }
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
        let chatData = loadHistory(chatId);

        if (chatData.messages.length >= MAX_HISTORY_LENGTH) {
            chatData.messages = [chatData.messages[0], ...chatData.messages.slice(chatData.messages.length - MAX_HISTORY_LENGTH + 2)];
        }

        chatData.messages.push(message);
        saveHistory(chatId, chatData);

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

        const chats = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const chatId = file.replace('.json', '');
                const chatData = loadHistory(chatId);
                return {
                    id: chatId,
                    name: chatData.name || `Чат ${chatId.substring(0, 6)}`,
                    created: chatData.created || 0,
                    messageCount: chatData.messages ? chatData.messages.length : 0,
                    userMessageCount: chatData.messages ?
                        chatData.messages.filter(m => m.role === 'user').length : 0
                };
            });

        return chats.sort((a, b) => b.created - a.created);
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

export function deleteChatsAutomatically(criteria = {}) {
    try {
        const { olderThan, userMessageCountLessThan, messageCountLessThan, maxChats } = criteria;
        const chats = getAllChats();

        let chatsToDelete = [...chats];

        // Фильтрация по возрасту (в миллисекундах)
        if (olderThan) {
            const cutoffTime = Date.now() - olderThan;
            chatsToDelete = chatsToDelete.filter(chat => chat.created < cutoffTime);
        }

        // Фильтрация по количеству сообщений пользователя
        if (userMessageCountLessThan !== undefined) {
            chatsToDelete = chatsToDelete.filter(chat =>
                chat.userMessageCount < userMessageCountLessThan);
        }

        // Фильтрация по общему количеству сообщений
        if (messageCountLessThan !== undefined) {
            chatsToDelete = chatsToDelete.filter(chat =>
                chat.messageCount < messageCountLessThan);
        }

        // Удаление старых чатов, если их общее количество превышает maxChats
        if (maxChats && chats.length > maxChats) {
            // Сортировка по дате создания (от старых к новым)
            const sortedChats = [...chats].sort((a, b) => a.created - b.created);
            // Получение самых старых чатов для удаления
            const oldestChats = sortedChats.slice(0, chats.length - maxChats);

            // Добавление ID чатов, которые еще не в списке удаления
            oldestChats.forEach(chat => {
                if (!chatsToDelete.some(c => c.id === chat.id)) {
                    chatsToDelete.push(chat);
                }
            });
        }

        // Удаление выбранных чатов
        const deletedChats = [];
        for (const chat of chatsToDelete) {
            if (deleteChat(chat.id)) {
                deletedChats.push(chat.id);
            }
        }

        return {
            success: true,
            deletedCount: deletedChats.length,
            deletedChats
        };
    } catch (error) {
        console.error('Ошибка при автоматическом удалении чатов:', error);
        return {
            success: false,
            error: error.message
        };
    }
} 