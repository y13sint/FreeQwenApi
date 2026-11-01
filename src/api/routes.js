import express from 'express';
import { sendMessage, getAllModels, getApiKeys, createChatV2, pollQwenTaskStatus, extractMediaUrl, pagePool, extractAuthToken, deleteChatV2 } from './chat.js';
import { getAuthenticationStatus, getBrowserContext } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { logInfo, logError, logDebug, logWarn } from '../logger/index.js';
import { getMappedModel } from './modelMapping.js';
import { getStsToken, uploadFileToQwen } from './fileUpload.js';
import { loadHistory, saveHistory } from './chatHistory.js';
import { generateImage, getAvailableImageModels, checkImageApiAvailability } from './imageGeneration.js';
import { MAX_FILE_SIZE, UPLOADS_DIR, DEFAULT_MODEL, STREAMING_CHUNK_DELAY, ALLOW_UNSCOPED_SESSION_CHAT_RESTORE, AUTO_DELETE_CHATS, DELETE_FAILED_CHATS } from '../config.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { listTokens, markInvalid, markRateLimited, markValid, addTokenFromString, deleteAccount, decodeTokenInfo, updateAccountToken, setLabel } from './tokenManager.js';
import { FORGETMEAI_WATERMARK } from '../utils/branding.js';

// Функция для генерирования детерминированного chatId на основе истории
function generateChatIdFromHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    
    // Фильтруем служебные сообщения Open WebUI
    // Игнорируем сообщения, которые начинаются с "### Task:" или "History:"
    const realMessages = messages.filter(m => {
        if (m.role !== 'user') return true;
        const content = typeof m.content === 'string' ? m.content : '';
        return !content.startsWith('### Task:') && !content.startsWith('History:');
    });
    
    // Если остались только служебные сообщения, используем исходные
    const messagesToUse = realMessages.length > 0 ? realMessages : messages;
    
    // Используем хеш первого реального сообщения пользователя для создания стабильного ID
    const userMessages = messagesToUse
        .filter(m => m.role === 'user')
        .slice(0, 1) // Берём первое сообщение пользователя
        .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
        .join('||');
    
    if (!userMessages) return null;
    
    // Создаём хеш для детерминированного ID
    const hash = crypto
        .createHash('sha256')
        .update(userMessages)
        .digest('hex')
        .substring(0, 16);
    
    return `chat_${hash}`;
}

function normalizeIdValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;

    return trimmed;
}

function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeIdValue(candidate);
        if (normalized) return normalized;
    }
    return null;
}

function buildInternalChatIdFromHint(hint) {
    const normalizedHint = normalizeIdValue(hint);
    if (!normalizedHint) return null;

    const hash = crypto
        .createHash('sha256')
        .update(`client-conversation:${normalizedHint}`)
        .digest('hex')
        .substring(0, 16);

    return `chat_${hash}`;
}

function extractConversationHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        req.get?.('x-conversation-id'),
        req.get?.('x-openwebui-conversation-id'),
        req.get?.('x-chat-id'),
        req.get?.('x-openwebui-chat-id')
    ]);
}

function extractParentHint(req) {
    const body = req.body || {};
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};

    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        req.get?.('x-parent-id'),
        req.get?.('x-openwebui-parent-id')
    ]);
}

function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function shouldForceNewChat(req) {
    const body = req.body || {};

    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        req.get?.('x-new-chat'),
        req.get?.('x-reset-chat')
    ].some(isTruthyFlag);
}

function shouldPersistSessionContext(scope = null) {
    const normalizedScope = normalizeIdValue(scope);
    return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

// Глобальное хранилище для маппинга между сгенерированными ID и реальными Qwen chatId
const chatIdMap = new Map();

function mapChatId(generatedId, qwenChatId) {
    if (generatedId) {
        chatIdMap.set(generatedId, qwenChatId);
        logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
    }
}

function getChatIdFromMap(generatedId) {
    return generatedId ? chatIdMap.get(generatedId) : null;
}

async function resolveQwenChatId(effectiveChatId, mappedModel) {
    let qwenChatId = effectiveChatId;
    const mapped = getChatIdFromMap(effectiveChatId);

    if (mapped) {
        qwenChatId = mapped;
        logInfo(`🔁 Используется сопоставленный Qwen chatId: ${qwenChatId} (from ${effectiveChatId})`);
        return qwenChatId;
    }

    if (effectiveChatId && effectiveChatId.startsWith('chat_')) {
        try {
            const created = await createChatV2(mappedModel, 'Сессия OpenWebUI');
            if (created && created.chatId) {
                mapChatId(effectiveChatId, created.chatId);
                qwenChatId = created.chatId;
                logInfo(`🔨 Создан Qwen chat ${qwenChatId} и привязан к ${effectiveChatId}`);
            }
        } catch (error) {
            logDebug(`Не удалось создать Qwen chat для ${effectiveChatId}: ${error.message}`);
        }
    }

    return qwenChatId;
}
import { testToken } from './chat.js';

function isOpenWebUiMetaRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const lastUserMessage = messages.filter(m => m && m.role === 'user').pop();
    if (!lastUserMessage) return false;

    const content = lastUserMessage.content;
    if (Array.isArray(content)) return false; // multimodal / normal user message
    if (typeof content !== 'string') return false;

    const text = content.trimStart();

    // OpenWebUI background/meta prompts that should not reuse the main chatId/session.
    if (text.startsWith('### Task:')) return true;
    if (text.startsWith('History:')) return true;

    // Some variants embed history blocks and task instructions.
    if (text.includes('<chat_history>') && text.includes('### Task:')) return true;

    return false;
}

// ============================================
// СЕССИОННАЯ СИСТЕМА ДЛЯ ОТСЛЕЖИВАНИЯ ЧАТОВ
// ============================================
// Scoped-сессии (по conversation_id/chat_id) включены всегда.
// Unscoped fallback по IP + User-Agent работает только в legacy-режиме
// через ALLOW_UNSCOPED_SESSION_CHAT_RESTORE=true.
const sessionToChatMap = new Map(); // session-key -> {chatId, parentId, timestamp}

// Одноразовые чаты (без conversation_id) убираем из истории Qwen:
// неудачные/пустые — всегда (режим failed), успешные — только при AUTO_DELETE_CHATS=all.
function cleanupEphemeralChat(result, effectiveChatId, isMeta) {
    if (isMeta || effectiveChatId || !result?.chatId) return;

    const failed = Boolean(result.error) || !Array.isArray(result.choices) || result.choices.length === 0;
    if (!AUTO_DELETE_CHATS && !(DELETE_FAILED_CHATS && failed)) return;

    deleteChatV2(result.chatId).catch(() => {});
}

function getSessionKey(req) {
    // Создаём уникальный ключ сессии на основе IP и User-Agent
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return crypto.createHash('sha256').update(`${ip}||${userAgent}`).digest('hex');
}

function getScopedSessionKey(req, scope = null) {
    const baseKey = getSessionKey(req);
    const normalizedScope = normalizeIdValue(scope);
    return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

function getSavedChatId(req, scope = null) {
    const keysToTry = [getScopedSessionKey(req, scope)];

    for (const sessionKey of keysToTry) {
        const sessionData = sessionToChatMap.get(sessionKey);
        if (sessionData && (Date.now() - sessionData.timestamp) < 3600000) { // 1 hour
            return sessionData;
        }
    }

    return null;
}
function saveChatIdForSession(req, chatId, parentId, scope = null) {
    const sessionKey = getScopedSessionKey(req, scope);
    const normalizedScope = normalizeIdValue(scope);

    sessionToChatMap.set(sessionKey, {
        chatId,
        parentId,
        scope: normalizedScope,
        timestamp: Date.now()
    });

    const scopeSuffix = normalizedScope ? ` (scope=${normalizedScope})` : "";
    logDebug(`Saved chatId ${chatId} for session ${sessionKey.substring(0, 8)}${scopeSuffix}`);
}
// Очистка старых сессий каждые 10 минут
setInterval(() => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    let cleaned = 0;
    for (const [key, value] of sessionToChatMap.entries()) {
        if (value.timestamp < oneHourAgo) {
            sessionToChatMap.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        logDebug(`Очищено ${cleaned} старых сессий`);
    }
}, 600000); // 10 минут

const router = express.Router();

// ─── Multer для загрузки файлов ──────────────────────────────────────────────

const storage = multer.diskStorage({
    destination(req, file, cb) {
        const uploadDir = path.join(process.cwd(), UPLOADS_DIR);
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename(req, file, cb) {
        cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '-' + file.originalname);
    }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// ─── Auth middleware ─────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
    const apiKeys = getApiKeys();
    if (apiKeys.length === 0) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logError('Отсутствует или некорректный заголовок авторизации');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.substring(7).trim();
    if (!apiKeys.includes(token)) {
        logError('Предоставлен недействительный API ключ');
        return res.status(401).json({ error: 'Недействительный токен' });
    }
    next();
}

router.use(authMiddleware);
router.use((req, res, next) => {
    req.url = req.url.replace(/\/v[12](?=\/|$)/g, '').replace(/\/+/g, '/');
    next();
});

// ─── Helpers: message parsing ────────────────────────────────────────────────

function parseOpenAIMessages(messages) {
    const systemMsg = messages.find(msg => msg.role === 'system');
    const systemMessage = systemMsg ? systemMsg.content : null;
    const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
    
    if (!lastUserMessage) {
        return { messageContent: null, systemMessage };
    }
    
    let messageContent = lastUserMessage.content;
    
    // Преобразуем OpenAI format content array во внутренний формат
    if (Array.isArray(messageContent)) {
        messageContent = messageContent.map(item => {
            if (item.type === 'text') {
                return { type: 'text', text: item.text };
            } else if (item.type === 'image_url' && item.image_url) {
                // OpenAI format: image_url: { url: '...' }
                return { type: 'image', image: item.image_url.url };
            } else if (item.type === 'image') {
                // Уже во внутреннем формате
                return { type: 'image', image: item.image };
            }
            return item;
        });
    }
    
    return { messageContent, systemMessage };
}

function buildCombinedTools(tools, functions, toolChoice) {
    const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
    return { combinedTools, toolChoice };
}

function stringifyOpenAIContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return `[image: ${item.image_url?.url || ''}]`;
            if (item.type === 'image') return `[image: ${item.image || ''}]`;
            if (item.type === 'file') return `[file: ${item.file || item.name || ''}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join('\n');
    }
    return JSON.stringify(content);
}

function buildStatelessTranscript(messages) {
    const parts = [];
    for (const msg of messages || []) {
        if (!msg || msg.role === 'system') continue;
        if (msg.role === 'user') {
            parts.push(`User: ${stringifyOpenAIContent(msg.content)}`);
        } else if (msg.role === 'assistant') {
            const text = stringifyOpenAIContent(msg.content);
            if (text) parts.push(`Assistant: ${text}`);
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                parts.push(`Assistant tool calls: ${JSON.stringify(msg.tool_calls)}`);
            }
        } else if (msg.role === 'tool') {
            const name = msg.name || msg.tool_call_id || 'tool';
            parts.push(`Tool result (${name}): ${stringifyOpenAIContent(msg.content)}`);
        } else {
            parts.push(`${msg.role || 'message'}: ${stringifyOpenAIContent(msg.content)}`);
        }
    }
    return parts.join('\n\n');
}


function hasOpenAIToolState(messages) {
    return (messages || []).some(msg =>
        msg?.role === 'tool' ||
        msg?.role === 'function' ||
        (msg?.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) ||
        (msg?.role === 'assistant' && msg.function_call)
    );
}

function shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId) {
    const nonSystemMessages = (messages || []).filter(msg => msg && msg.role !== 'system');
    if (nonSystemMessages.length === 0) return false;

    // Hermes/OpenAI agents send the full state every request. After a tool call the
    // next request often ends with role=tool, not role=user. Qwen Chat has no native
    // OpenAI tool-result role, so preserving context means folding the whole OpenAI
    // transcript into a single user message for that turn.
    if (hasOpenAIToolState(messages)) return true;

    // If FreeQwenApi is used as a stateless OpenAI-compatible endpoint and no
    // conversation id/chat id was provided, keep the complete client-side history.
    if (!effectiveChatId && nonSystemMessages.length > 1) return true;

    // When tools are available, prefer the OpenAI transcript over Qwen's opaque web
    // chat memory on multi-message turns. This keeps Hermes skill/tool discipline in
    // the prompt visible to Qwen instead of depending on previous web-chat state.
    if (Array.isArray(combinedTools) && combinedTools.length > 0 && nonSystemMessages.length > 1) return true;

    return false;
}

function prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId) {
    const lastUserMessage = (messages || []).filter(msg => msg && msg.role === 'user').pop();
    if (shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId)) {
        return {
            messageContent: buildStatelessTranscript(messages),
            files: lastUserMessage?.files || [],
            folded: true,
            missingUser: false
        };
    }

    if (!lastUserMessage) {
        return { messageContent: null, files: [], folded: false, missingUser: true };
    }

    return {
        messageContent: lastUserMessage.content,
        files: lastUserMessage.files || [],
        folded: false,
        missingUser: false
    };
}

function truncateForPrompt(value, maxLen = 240) {
    const text = String(value || '');
    return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
}

function compactJsonSchema(schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 2) return schema;
    if (Array.isArray(schema)) return schema.slice(0, 20).map(item => compactJsonSchema(item, depth + 1));

    const out = {};
    for (const key of ['type', 'enum', 'required', 'default']) {
        if (schema[key] !== undefined) out[key] = schema[key];
    }
    if (schema.description) out.description = truncateForPrompt(schema.description, depth === 0 ? 180 : 90);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, prop] of Object.entries(schema.properties)) {
            out.properties[name] = compactJsonSchema(prop, depth + 1);
        }
    }
    if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
    if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
    if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
    return out;
}

function toolsToPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const priorityNames = new Set([
        'skill_view', 'skills_list', 'skill_manage',
        'read_file', 'search_files', 'write_file', 'patch', 'terminal', 'process',
        'web_search', 'web_extract', 'session_search', 'todo', 'clarify', 'delegate_task'
    ]);

    const schemas = tools.map(tool => {
        const fn = tool?.function || tool;
        if (!fn?.name) return null;
        return {
            name: fn.name,
            description: truncateForPrompt(fn.description || '', priorityNames.has(fn.name) ? 420 : 180),
            parameters: compactJsonSchema(fn.parameters || { type: 'object', properties: {} }),
            priority: priorityNames.has(fn.name) ? 0 : 1
        };
    }).filter(Boolean).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

    if (schemas.length === 0) return '';

    const toolNames = schemas.map(s => s.name).join(', ');
    const skillRules = schemas.some(s => s.name === 'skill_view') ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
` : '';

    return `

OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}
GENERAL TOOL RULES:
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not prefix names with namespaces.

TOOL CALL OUTPUT FORMAT — respond ONLY with minified JSON, no markdown, no prose:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(schemas.map(({priority, ...schema}) => schema), null, 2)}

If no tool is needed and no skill rule applies, answer normally.`;
}
function parseToolCallJson(content) {
    if (typeof content !== 'string') return null;
    let text = content.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fence) text = fence[1].trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 || last !== text.length - 1) {
        if (first >= 0 && last > first) text = text.slice(first, last + 1);
    }
    const parseAttempts = [text];
    // Qwen sometimes emits one missing brace in the common shape:
    // {"tool_calls":[{"name":"x","arguments":{...}}]} -> may become ..."arguments":{...}]}
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        parseAttempts.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
        parseAttempts.push(text + '}');
    }

    for (const candidate of parseAttempts) {
        try {
            const parsed = JSON.parse(candidate);
            let calls = null;
            if (Array.isArray(parsed.tool_calls)) {
                calls = parsed.tool_calls;
            } else if (parsed.function_call || parsed.tool_call) {
                calls = [parsed.function_call || parsed.tool_call];
            } else if (parsed.name || parsed.tool) {
                calls = [parsed];
            }
            if (!calls || calls.length === 0) continue;
            return calls.map((call, index) => {
                const name = call.name || call.tool || call.function?.name;
                const rawArgs = call.arguments ?? call.args ?? call.input ?? call.function?.arguments ?? {};
                const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {});
                if (!name) return null;
                return {
                    id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: { name, arguments: args },
                    index
                };
            }).filter(Boolean);
        } catch {
            // try next repair candidate
        }
    }
    return null;
}

function applyToolPrompt(systemMessage, tools) {
    const prompt = toolsToPrompt(tools);
    return prompt ? `${systemMessage || ''}${prompt}`.trim() : systemMessage;
}

function buildOpenAIToolResponse(result, mappedModel, toolCalls) {
    return {
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || DEFAULT_MODEL,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: toolCalls.map(({ index, ...call }) => call)
            },
            finish_reason: 'tool_calls'
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId || result.response_id,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId || result.response_id
    };
}

function writeToolCallsSse(res, mappedModel, result, toolCalls) {
    const base = {
        id: result.id || 'chatcmpl-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel || DEFAULT_MODEL
    };
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    }) + '\n\n');
    for (const call of toolCalls) {
        res.write('data: ' + JSON.stringify({
            ...base,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: call.index,
                        id: call.id,
                        type: 'function',
                        function: call.function
                    }]
                },
                finish_reason: null
            }]
        }) + '\n\n');
    }
    res.write('data: ' + JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
}

// ─── Helpers: streaming ──────────────────────────────────────────────────────

async function handleStreamingResponse(res, mappedModel, messageContent, chatId, parentId, combinedTools, toolChoice, systemMessage) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const writeSse = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');

    writeSse({
        id: 'chatcmpl-stream', object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000), model: mappedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    });

    try {
        const result = await sendMessage(messageContent, mappedModel, chatId, parentId, null, combinedTools, toolChoice, systemMessage);

        if (result.error) {
            writeSse({
                id: 'chatcmpl-stream', object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000), model: mappedModel,
                choices: [{ index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: null }]
            });
        } else if (result.choices?.[0]?.message) {
            const content = String(result.choices[0].message.content || '');
            const codePoints = Array.from(content);
            const chunkSize = 16;
            for (let i = 0; i < codePoints.length; i += chunkSize) {
                writeSse({
                    id: 'chatcmpl-stream', object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model: mappedModel,
                    choices: [{ index: 0, delta: { content: codePoints.slice(i, i + chunkSize).join('') }, finish_reason: null }]
                });
                await new Promise(r => setTimeout(r, STREAMING_CHUNK_DELAY));
            }
        }

        writeSse({
            id: 'chatcmpl-stream', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: mappedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        });
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        logError('Ошибка при обработке потокового запроса', error);
        writeSse({
            id: 'chatcmpl-stream', object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000), model: mappedModel,
            choices: [{ index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }]
        });
        res.write('data: [DONE]\n\n');
        res.end();
    }
}

function handleNonStreamingResponse(res, result, mappedModel) {
    if (result.error) {
        return res.status(500).json({ error: { message: result.error, type: 'server_error' } });
    }

    res.json({
        id: result.id || 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || mappedModel,
        choices: result.choices || [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        chatId: result.chatId,
        parentId: result.parentId
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
    try {
        const { message, messages, model, chatId, parentId, stream, chatType, size, waitForCompletion } = req.body;

        // Поддержка как message, так и messages для совместимости
        let messageContent = message;
        let systemMessage = null;
        let allMessages = messages; // Сохраняем всю историю
        const isMeta = isOpenWebUiMetaRequest(messages);

        if (messages && Array.isArray(messages)) {
            const parsed = parseOpenAIMessages(messages);
            systemMessage = parsed.systemMessage;
            if (parsed.messageContent) messageContent = parsed.messageContent;
        }

        if (!messageContent) {
            logError('Запрос без сообщения');
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        logInfo(`Получен запрос: ${typeof messageContent === 'string' ? messageContent.substring(0, 50) + (messageContent.length > 50 ? '...' : '') : 'Составное сообщение'}`);
        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }
        if (chatId && !isMeta) {
            logInfo(`Используется chatId: ${chatId}, parentId: ${parentId || 'null'}`);
        } else if (isMeta) {
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }
        if (allMessages && allMessages.length > 1) {
            logInfo(`История содержит ${allMessages.length} сообщений`);
        }

        let mappedModel = model || DEFAULT_MODEL;
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
        }
        logInfo(`Используется модель: ${mappedModel}`);

        // Поддержка стриминга для OpenWebUI
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            // Важно для OpenWebUI - не кэшировать
            res.setHeader('X-Accel-Buffering', 'no');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                // Setup streaming callback
                let streamingCallback = null;
                let hasStreamedChunks = false;
                if (stream) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    isMeta ? null : chatId,
                    isMeta ? null : parentId,
                    null,
                    null,
                    null,
                    systemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Чанки уже были отправлены через streamingCallback, не дублируем!

                // Финальный чанк
                writeSse({
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
        }

            const result = await sendMessage(messageContent, mappedModel, isMeta ? null : chatId, isMeta ? null : parentId, null, null, null, systemMessage, chatType || 't2t', size || null, waitForCompletion ?? true);

        if (result.choices && result.choices[0] && result.choices[0].message) {
            const responseLength = result.choices[0].message.content ? result.choices[0].message.content.length : 0;
            logInfo(`Ответ успешно сформирован для запроса, длина ответа: ${responseLength}`);
            
            // Сохраняем историю чата
            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const updatedMessages = allMessages || [
                        { role: 'user', content: messageContent },
                        { role: 'assistant', content: result.choices[0].message.content }
                    ];
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }
        } else if (result.error) {
            logInfo(`Получена ошибка в ответе: ${result.error}`);
        }

        res.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/health', async (req, res) => {
    try {
        const modelData = getAllModels();
        const tokens = listTokens();
        const now = Date.now();
        const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;

        res.json({
            ok: availableAccounts > 0,
            service: 'FreeQwenApi',
            watermark: FORGETMEAI_WATERMARK,
            baseUrl: '/api',
            models: modelData.models.length,
            accounts: {
                total: tokens.length,
                available: availableAccounts,
                invalid: tokens.filter(t => t.invalid).length,
                waiting: tokens.filter(t => t.resetAt && new Date(t.resetAt).getTime() > now).length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logError('Ошибка health check', error);
        res.status(500).json({ ok: false, error: 'Health-проверка не удалась' });
    }
});

router.get('/models', async (req, res) => {
    try {
        logInfo('Запрос на получение списка моделей');
        const modelsRaw = getAllModels();
        const openAiModels = {
            object: 'list',
            data: modelsRaw.models.map(m => ({
                id: m.id || m.name || m,
                object: 'model',
                created: 0,
                owned_by: 'qwen',
                permission: []
            }))
        };
        logInfo(`Возвращено ${openAiModels.data.length} моделей (OpenAI формат)`);
        res.json(openAiModels);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Прокси скачивания внешних медиа (картинки/видео/файлы Qwen CDN).
// Нужен, т.к. fetch-blob с фронта к CDN блокируется CORS. Строгий whitelist + SSRF-guard.
const DOWNLOAD_HOSTS = ['qwenlm.ai', 'aliyuncs.com', 'alicdn.com', 'aliyun.com'];
// Валидация URL для прокси: только https, без IP-литералов/localhost, hostname в whitelist
// доверенных CDN Qwen/Aliyun (домены не контролируются третьими лицами → DNS-rebinding неприменим).
function validateDownloadUrl(raw) {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost') return null;
    if (!DOWNLOAD_HOSTS.some(d => host === d || host.endsWith('.' + d))) return null;
    return u;
}
router.get('/download', async (req, res) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
        if (!req.query.url) { clearTimeout(timer); return res.status(400).json({ error: 'Параметр url обязателен' }); }
        let u = validateDownloadUrl(req.query.url);
        if (!u) { clearTimeout(timer); return res.status(403).json({ error: 'URL не разрешён (только https и домены Qwen/Aliyun CDN)' }); }

        // Редиректы не следуем автоматически — каждый hop валидируем заново (защита от SSRF через redirect).
        let upstream, hops = 0;
        for (;;) {
            upstream = await fetch(u.toString(), { redirect: 'manual', signal: ctrl.signal });
            if (upstream.status >= 300 && upstream.status < 400) {
                const loc = upstream.headers.get('location');
                let next = null;
                if (loc) { try { next = validateDownloadUrl(new URL(loc, u).toString()); } catch { next = null; } }
                if (!loc || ++hops > 3) { clearTimeout(timer); return res.status(502).json({ error: 'Недопустимая цепочка редиректов' }); }
                if (!next) { clearTimeout(timer); return res.status(403).json({ error: 'Редирект на недопустимый адрес' }); }
                u = next; continue;
            }
            break;
        }
        if (!upstream.ok || !upstream.body) { clearTimeout(timer); return res.status(502).json({ error: `Источник вернул ${upstream.status}` }); }

        const name = String(req.query.name || u.pathname.split('/').pop() || 'download')
            .replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'download';
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        const ct = upstream.headers.get('content-type'); if (ct) res.setHeader('Content-Type', ct);
        const len = upstream.headers.get('content-length'); if (len) res.setHeader('Content-Length', len);

        const reader = upstream.body.getReader();
        res.on('close', () => { reader.cancel().catch(() => {}); });
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r));
        }
        clearTimeout(timer);
        res.end();
    } catch (error) {
        clearTimeout(timer);
        logError('Ошибка проксирования скачивания', error);
        if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        else try { res.end(); } catch { /* noop */ }
    }
});

router.get('/status', async (req, res) => {
    try {
        logInfo('Запрос статуса авторизации');
        const tokens = listTokens();
        const accounts = await Promise.all(tokens.map(async t => {
            const accInfo = { id: t.id, status: 'UNKNOWN', resetAt: t.resetAt || null };

            if (t.resetAt) {
                const resetTime = new Date(t.resetAt).getTime();
                if (resetTime > Date.now()) { accInfo.status = 'WAIT'; return accInfo; }
            }

            const testResult = await testToken(t.token);
            if (testResult === 'OK') { accInfo.status = 'OK'; if (t.invalid || t.resetAt) markValid(t.id); }
            else if (testResult === 'RATELIMIT') { accInfo.status = 'WAIT'; markRateLimited(t.id, 24); }
            else if (testResult === 'UNAUTHORIZED') { accInfo.status = 'INVALID'; if (!t.invalid) markInvalid(t.id); }
            else { accInfo.status = 'ERROR'; }
            return accInfo;
        }));

        const browserContext = getBrowserContext();
        if (!browserContext) {
            logError('Браузер не инициализирован');
            return res.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        if (getAuthenticationStatus()) return res.json({ accounts });

        await checkAuthentication(browserContext);
        const isAuthenticated = getAuthenticationStatus();
        logInfo(`Статус авторизации: ${isAuthenticated ? 'активна' : 'требуется авторизация'}`);
        res.json({ authenticated: isAuthenticated, message: isAuthenticated ? 'Авторизация активна' : 'Требуется авторизация', accounts });
    } catch (error) {
        logError('Ошибка при проверке статуса авторизации', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ─── Управление аккаунтами (для дашборда) ──────────────────────────────────
// Управление аккаунтами чувствительно (токены), поэтому доступно только с
// localhost — защита от доступа из LAN (HOST=0.0.0.0 слушает на всех интерфейсах).
function localOnly(req, res, next) {
    const ip = req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    logWarn(`Отклонён не-локальный доступ к /accounts с ${ip}`);
    return res.status(403).json({ error: 'Управление аккаунтами доступно только с localhost' });
}

// CSRF-защита для мутирующих запросов: ACAO:* разрешает cross-origin вызовы,
// поэтому запрещаем запросы, чей Origin не совпадает с хостом сервера.
function sameOriginOnly(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
        // Browser extensions (the account-import popup) are user-installed and
        // declare an explicit host permission for this server. A web page cannot
        // forge a *-extension:// Origin, so these are trusted, not a CSRF vector.
        if (/^(chrome-extension|moz-extension|safari-web-extension):\/\//i.test(origin)) return next();
        try {
            if (new URL(origin).host !== req.get('host')) {
                return res.status(403).json({ error: 'Cross-origin запрос запрещён' });
            }
        } catch {
            return res.status(403).json({ error: 'Некорректный Origin' });
        }
    }
    return next();
}

router.get('/accounts', localOnly, sameOriginOnly, (req, res) => {
    try {
        const now = Date.now();
        const accounts = listTokens().map(t => {
            const info = decodeTokenInfo(t.token);
            let status = 'OK';
            if (t.invalid) status = 'INVALID';
            else if (t.resetAt && new Date(t.resetAt).getTime() > now) status = 'WAIT';
            else if (info.exp && info.exp < now) status = 'EXPIRED';
            return {
                id: t.id,
                label: t.label || '',
                status,
                exp: info.exp,
                resetAt: t.resetAt || null,
                preview: String(t.token).slice(0, 10) + '…' + String(t.token).slice(-4)
            };
        });
        res.json({ accounts });
    } catch (error) {
        logError('Ошибка при получении списка аккаунтов', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/accounts', localOnly, sameOriginOnly, (req, res) => {
    try {
        const token = req.body?.token;
        if (!token) return res.status(400).json({ error: 'Не передан token' });
        const result = addTokenFromString(token, req.body?.label);
        if (result.error) return res.status(400).json(result);
        logInfo(`Добавлен аккаунт через дашборд: ${result.id}`);
        res.json({ ok: true, id: result.id });
    } catch (error) {
        logError('Ошибка при добавлении аккаунта', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.delete('/accounts/:id', localOnly, sameOriginOnly, (req, res) => {
    try {
        const result = deleteAccount(req.params.id);
        if (result.error) return res.status(400).json(result);
        logInfo(`Удалён аккаунт через дашборд: ${req.params.id}`);
        res.json({ ok: true });
    } catch (error) {
        logError('Ошибка при удалении аккаунта', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Проверить валидность одного аккаунта (реальный запрос к Qwen).
// POST, т.к. меняет состояние (mark*); за sameOriginOnly — защита от CSRF.
router.post('/accounts/:id/check', localOnly, sameOriginOnly, async (req, res) => {
    try {
        const id = req.params.id;
        if (!/^acc_[a-zA-Z0-9]+$/.test(id)) return res.status(400).json({ error: 'Некорректный id аккаунта' });
        const t = listTokens().find(x => x.id === id);
        if (!t) return res.status(404).json({ error: 'Аккаунт не найден' });
        const info = decodeTokenInfo(t.token);
        const r = await testToken(t.token);
        let status = 'ERROR';
        if (r === 'OK') { status = 'OK'; if (t.invalid || t.resetAt) markValid(t.id); }
        else if (r === 'RATELIMIT') { status = 'WAIT'; markRateLimited(t.id, 24); }
        else if (r === 'UNAUTHORIZED') { status = 'INVALID'; if (!t.invalid) markInvalid(t.id); }
        const resetAt = status === 'WAIT' ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : (t.resetAt || null);
        res.json({ id, status, exp: info.exp, resetAt });
    } catch (error) {
        logError('Ошибка проверки аккаунта', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Обновить токен аккаунта (relogin вручную из дашборда).
router.post('/accounts/:id/update', localOnly, sameOriginOnly, (req, res) => {
    try {
        const result = updateAccountToken(req.params.id, req.body?.token);
        if (result.error) return res.status(400).json(result);
        logInfo(`Обновлён токен аккаунта через дашборд: ${req.params.id}`);
        res.json(result);
    } catch (error) {
        logError('Ошибка обновления токена аккаунта', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Установить/изменить человекочитаемый ярлык аккаунта (для различения в пуле).
router.post('/accounts/:id/label', localOnly, sameOriginOnly, (req, res) => {
    try {
        const result = setLabel(req.params.id, req.body?.label);
        if (result.error) return res.status(400).json(result);
        logInfo(`Изменён ярлык аккаунта через дашборд: ${req.params.id}`);
        res.json(result);
    } catch (error) {
        logError('Ошибка изменения ярлыка аккаунта', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chats', async (req, res) => {
    try {
        const { name, model } = req.body;
        const chatModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        const result = await createChatV2(chatModel, name || 'Новый чат');
        if (result.error) { logError(`Ошибка создания чата: ${result.error}`); return res.status(500).json({ error: result.error }); }
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

router.post('/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint ? `conversation:${conversationHint}` : null;
        const forceNewChat = shouldForceNewChat(req);
        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        // Используем переданный chatId ИЛИ восстанавливаем из сессии
        let effectiveChatId = explicitChatId;
        let effectiveParentId = explicitParentId;

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                const savedSession = forceNewChat ? null : getSavedChatId(req);
                if (savedSession?.chatId) {
                    effectiveChatId = savedSession.chatId;
                    if (!effectiveParentId && savedSession.parentId) {
                        effectiveParentId = savedSession.parentId;
                    }
                    logInfo(`Restored chatId from session: ${effectiveChatId}`);
                }

                if (!effectiveChatId) {
                    const generatedId = generateChatIdFromHistory(messages);
                    if (generatedId) {
                        effectiveChatId = generatedId;
                        logInfo(`Created new chatId for session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        let messageContent = preparedInput.messageContent;
        
        // Преобразуем OpenAI format content array во внутренний формат
        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    // OpenAI format: image_url: { url: '...' }
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    // Уже во внутреннем формате
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }
        
        const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);
        if (systemMessage) logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);

        const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas; эмулируем через JSON prompt ниже.
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);

        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        // Логируем полную историю сообщений
        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

                // Setup streaming callback if stream=true
                let streamingCallback = null;
                let hasStreamedChunks = false;
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }

                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files, // ← ПЕРЕДАЁМ FILES
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                // Одноразовый чат: неудачный удаляем сразу, успешный — по флагу.
                cleanupEphemeralChat(result, effectiveChatId, isMeta);

                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls);
                        return;
                    }
                }

                // Сохраняем chatId в сессию для следующих запросов
                if (!isMeta && result.chatId) {
                    // Если мы использовали сгенерированный effectiveChatId — сохраните маппинг
                    if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                        mapChatId(effectiveChatId, result.chatId);
                        logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                    }
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: null }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Чанки уже были отправлены через streamingCallback, не дублируем!

                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);
            const result = await sendMessage(messageContent, mappedModel, qwenChatId, effectiveParentId, null, qwenTools, tool_choice, toolAwareSystemMessage);

            // Одноразовый чат: неудачный удаляем сразу, успешный — по флагу.
            cleanupEphemeralChat(result, effectiveChatId, isMeta);

            // Сохраняем chatId в сессию для следующих запросов
            if (!isMeta && result.chatId) {
                if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                    mapChatId(effectiveChatId, result.chatId);
                    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                }
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
            if (toolCalls && toolCalls.length > 0) {
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || DEFAULT_MODEL,
                choices: result.choices || [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.choices?.[0]?.message?.content || ""
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                chatId: result.chatId,
                parentId: result.parentId
            };

            // Сохраняем историю чата
            if (result.chatId) {
                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: openaiResponse.choices[0].message.content
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

// OpenAI совместимый эндпоинт v1 (для Open WebUI и других клиентов)
router.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream, tools, functions, tool_choice, chatId } = req.body;
        const snakeCaseChatId = normalizeIdValue(req.body?.chat_id);
        const explicitChatId = normalizeIdValue(chatId) || snakeCaseChatId;
        const explicitParentId = extractParentHint(req);
        const conversationHint = extractConversationHint(req);
        const conversationScope = conversationHint ? `conversation:${conversationHint}` : null;
        const forceNewChat = shouldForceNewChat(req);

        logInfo(`Получен OpenAI v1 запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const isMeta = isOpenWebUiMetaRequest(messages);

        // Используем переданный chatId ИЛИ восстанавливаем из сессии
        let effectiveChatId = explicitChatId;
        let effectiveParentId = explicitParentId;

        if (forceNewChat && !explicitChatId && !isMeta) {
            effectiveChatId = `chat_${crypto.randomBytes(8).toString('hex')}`;
            effectiveParentId = null;
            logInfo(`Принудительно запрошен новый чат (newChat/resetChat): ${effectiveChatId}`);
        }

        if (!effectiveChatId && !isMeta) {
            if (conversationHint) {
                const scopedSession = forceNewChat ? null : getSavedChatId(req, conversationScope);
                if (scopedSession?.chatId) {
                    effectiveChatId = scopedSession.chatId;
                    if (!effectiveParentId && scopedSession.parentId) {
                        effectiveParentId = scopedSession.parentId;
                    }
                    logInfo(`Restored scoped chatId from session: ${effectiveChatId}`);
                } else {
                    effectiveChatId = buildInternalChatIdFromHint(conversationHint);
                    logInfo(`Using client conversation-id key: ${effectiveChatId}`);
                }
            } else if (ALLOW_UNSCOPED_SESSION_CHAT_RESTORE) {
                const savedSession = forceNewChat ? null : getSavedChatId(req);
                if (savedSession?.chatId) {
                    effectiveChatId = savedSession.chatId;
                    if (!effectiveParentId && savedSession.parentId) {
                        effectiveParentId = savedSession.parentId;
                    }
                    logInfo(`Restored chatId from session: ${effectiveChatId}`);
                }

                if (!effectiveChatId) {
                    const generatedId = generateChatIdFromHistory(messages);
                    if (generatedId) {
                        effectiveChatId = generatedId;
                        logInfo(`Created new chatId for session: ${effectiveChatId}`);
                    }
                }
            } else {
                logDebug('chatId/conversation_id не переданы, unscoped session fallback отключён');
            }
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;
        const { combinedTools } = buildCombinedTools(tools, functions, tool_choice);

        const preparedInput = prepareOpenAIMessageInput(messages, combinedTools, effectiveChatId);
        if (preparedInput.missingUser) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        let messageContent = preparedInput.messageContent;
        
        // Преобразуем OpenAI format content array во внутренний формат
        if (Array.isArray(messageContent)) {
            messageContent = messageContent.map(item => {
                if (item.type === 'text') {
                    return { type: 'text', text: item.text };
                } else if (item.type === 'image_url' && item.image_url) {
                    // OpenAI format: image_url: { url: '...' }
                    return { type: 'image', image: item.image_url.url };
                } else if (item.type === 'image') {
                    // Уже во внутреннем формате
                    return { type: 'image', image: item.image };
                }
                return item;
            });
        }
        
        const files = preparedInput.files || []; // ← ИЗВЛЕКАЕМ FILES
        if (preparedInput.folded) {
            logInfo('OpenAI/Hermes transcript folded into user message for context/tool-result preservation');
        }

        if (isMeta) {
            effectiveChatId = null;
            effectiveParentId = null;
            logDebug('OpenWebUI meta-запрос: используем отдельный чат (без привязки к сессии)');
        }

        let mappedModel = model ? getMappedModel(model) : DEFAULT_MODEL;
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);

        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }

        const qwenTools = null; // Qwen Chat web API не умеет OpenAI tool schemas; эмулируем через JSON prompt ниже.
        const toolAwareSystemMessage = applyToolPrompt(systemMessage, combinedTools);
        if (toolAwareSystemMessage) {
            logInfo(`System message: ${toolAwareSystemMessage.substring(0, 50)}${toolAwareSystemMessage.length > 50 ? '...' : ''}`);
        }

        // Логируем полную историю сообщений
        logInfo(`История содержит ${messages.length} сообщений: ${messages.map(m => m.role).join(', ')}`);
        if (effectiveChatId) {
            logInfo(`Используется chatId: ${effectiveChatId}, parentId: ${effectiveParentId || 'null'}`);
        }

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('Transfer-Encoding', 'chunked');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            try {
                const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

                // Setup streaming callback if stream=true
                let streamingCallback = null;
                let hasStreamedChunks = false;
                const captureToolCalls = Array.isArray(combinedTools) && combinedTools.length > 0;
                if (stream && !captureToolCalls) {
                    streamingCallback = (chunk) => {
                        hasStreamedChunks = true;
                        // OpenWebUI не нуждается в role в чанках - только контент
                        writeSse({
                            id: 'chatcmpl-' + Date.now(),
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });
                    };
                }
                
                const result = await sendMessage(
                    messageContent,
                    mappedModel,
                    qwenChatId,
                    effectiveParentId,
                    files, // ← ИЗВЛЕКАЕМ FILES
                    qwenTools,
                    tool_choice,
                    toolAwareSystemMessage,
                    't2t',
                    null,
                    true,
                    0,
                    streamingCallback
                );

                if (captureToolCalls) {
                    const toolCalls = parseToolCallJson(result?.choices?.[0]?.message?.content);
                    if (toolCalls && toolCalls.length > 0) {
                        writeToolCallsSse(res, mappedModel, result, toolCalls);
                        return;
                    }
                }

                // Сохраняем chatId в сессию для следующих запросов
                if (!isMeta && result.chatId) {
                    if (shouldPersistSessionContext(conversationScope)) {
                        saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                    }
                }

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || DEFAULT_MODEL,
                        choices: [
                            { index: 0, delta: { content: `Ошибка: ${result.error}` }, finish_reason: 'stop' }
                        ]
                    });
                } else if (!hasStreamedChunks && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) {
                    // Qwen вернул JSON/обычный ответ вместо SSE - отправляем контент одним чанком
                    const content = result.choices[0].message.content;
                    logDebug(`JSON response content length: ${content.length}`);
                    if (typeof streamingCallback === 'function') {
                        streamingCallback(content);
                    } else {
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || DEFAULT_MODEL,
                            choices: [
                                { index: 0, delta: { content }, finish_reason: null }
                            ]
                        });
                    }
                } else {
                    logDebug(`Result structure: ${JSON.stringify(Object.keys(result))}`);
                }
                // Чанки уже были отправлены через streamingCallback, не дублируем!

                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || DEFAULT_MODEL,
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } else {
            const qwenChatId = await resolveQwenChatId(effectiveChatId, mappedModel);

            const result = await sendMessage(messageContent, mappedModel, qwenChatId, effectiveParentId, files, qwenTools, tool_choice, toolAwareSystemMessage);

            // Сохраняем chatId в сессии для следующих запросов
            if (!isMeta && result.chatId) {
                // Если мы использовали сгенерированный effectiveChatId — сохраните маппинг
                if (effectiveChatId && effectiveChatId.startsWith('chat_') && result.chatId) {
                    mapChatId(effectiveChatId, result.chatId);
                    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${result.chatId}`);
                }
                if (shouldPersistSessionContext(conversationScope)) {
                    saveChatIdForSession(req, result.chatId, result.parentId, conversationScope);
                }
            }

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            // Извлекаем контент сообщения
            let messageText = '';
            if (result.choices && result.choices[0] && result.choices[0].message) {
                messageText = result.choices[0].message.content || '';
            } else if (result.response && result.response.text) {
                messageText = result.response.text;
            }

            const toolCalls = parseToolCallJson(messageText);
            if (toolCalls && toolCalls.length > 0) {
                return res.json(buildOpenAIToolResponse(result, mappedModel, toolCalls));
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || DEFAULT_MODEL,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: messageText
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                },
                // Передаём метаданные для сохранения контекста
                x_qwen_chat_id: result.chatId,
                x_qwen_parent_id: result.parentId || result.response_id
            };

            // Сохраняем историю чата для v1 эндпоинта
            if (result.chatId) {
                // Сохраняем chatId в сессии для последующих запросов от этого клиента
                if (!isMeta) {
                    try {
                        if (shouldPersistSessionContext(conversationScope)) {
                            saveChatIdForSession(req, result.chatId, result.parentId || result.response_id, conversationScope);
                        }
                    } catch (e) {
                        logDebug(`Не удалось сохранить chatId в сессии: ${e.message}`);
                    }
                }

                try {
                    const currentChat = loadHistory(result.chatId);
                    const responseMessage = {
                        role: 'assistant',
                        content: messageText
                    };
                    const updatedMessages = messages.concat([responseMessage]);
                    saveHistory(result.chatId, { ...currentChat, messages: updatedMessages });
                } catch (e) {
                    logDebug(`Не удалось сохранить историю: ${e.message}`);
                }
            }

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке v1 запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

router.post('/files/getstsToken', async (req, res) => {
    try {
        logInfo(`Запрос на получение STS токена: ${JSON.stringify(req.body)}`);
        const fileInfo = req.body;
        if (!fileInfo?.filename || !fileInfo?.filesize || !fileInfo?.filetype) {
            logError('Некорректные данные о файле');
            return res.status(400).json({ error: 'Некорректные данные о файле' });
        }
        res.json(await getStsToken(fileInfo));
    } catch (error) {
        logError('Ошибка при получении STS токена', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) { logError('Файл не был загружен'); return res.status(400).json({ error: 'Файл не был загружен' }); }
        logInfo(`Файл загружен на сервер: ${req.file.originalname} (${req.file.size} байт)`);

        const result = await uploadFileToQwen(req.file.path);

        try { fs.unlinkSync(req.file.path); } catch { /* file already removed or inaccessible */ }

        if (result.success) {
            logInfo(`Файл успешно загружен в OSS: ${result.fileName}`);
            res.json({ success: true, file: { name: result.fileName, url: result.url, size: req.file.size, type: req.file.mimetype } });
        } else {
            logError(`Ошибка при загрузке файла в OSS: ${result.error}`);
            res.status(500).json({ error: 'Ошибка при загрузке файла' });
        }
    } catch (error) {
        logError('Ошибка при загрузке файла', error);
        if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для сохранения истории чата (для работы с Open WebUI)
router.post('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;
        const { messages } = req.body;

        logInfo(`Запрос сохранения истории для чата: ${chatId}`);

        if (!messages || !Array.isArray(messages)) {
            logError('История сообщений не указана или некорректна');
            return res.status(400).json({ error: 'История сообщений должна быть массивом' });
        }

        // Здесь можно добавить логику сохранения истории
        // Для теперь просто подтверждаем сохранение
        res.json({
            success: true,
            chatId: chatId,
            messagesCount: messages.length
        });
    } catch (error) {
        logError('Ошибка при сохранении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения истории чата (для работы с Open WebUI)
router.get('/chats/:chatId/history', async (req, res) => {
    try {
        const { chatId } = req.params;

        logInfo(`Запрос истории для чата: ${chatId}`);

        // Здесь можно добавить логику получения истории из БД
        // Для теперь возвращаем пустую историю
        res.json({
            success: true,
            chatId: chatId,
            messages: []
        });
    } catch (error) {
        logError('Ошибка при получении истории чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// ============================================
// МЕДИА-ЭНДПОИНТЫ QWEN CHAT / DASHSCOPE
// ============================================

const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

function normalizeQwenAspectRatio(size, fallback = '16:9') {
    if (!size) return fallback;
    const value = String(size).trim();
    const ratioMap = {
        '1024x1024': '1:1',
        '512x512': '1:1',
        '768x768': '1:1',
        '960x960': '1:1',
        '1024x1792': '9:16',
        '1792x1024': '16:9',
        '1536x864': '16:9',
        '864x1536': '9:16'
    };
    if (ratioMap[value]) return ratioMap[value];
    if (/^\d+:\d+$/.test(value)) return value;
    return fallback;
}

function normalizeDashScopeSize(size) {
    const sizeMap = {
        '1024x1024': '1024*1024',
        '1024x1792': '1024*1792',
        '1792x1024': '1792*1024',
        '512x512': '512*512',
        '768x768': '768*768',
        '960x960': '960*960'
    };
    return sizeMap[size] || '1024*1024';
}

function buildOpenAiImageResponse({ imageUrl, prompt, model, raw, provider = 'qwen-chat' }) {
    return {
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider,
        model,
        data: [{ url: imageUrl, revised_prompt: prompt }],
        raw
    };
}

function buildVideoResponse({ result, prompt, model, waitForCompletion }) {
    const videoUrl = result.video_url || extractMediaUrl(result, 'video');
    return {
        id: result.id || result.task_id || `video-${Date.now()}`,
        object: videoUrl ? 'video.generation' : 'video.generation.task',
        created: Math.floor(Date.now() / 1000),
        watermark: FORGETMEAI_WATERMARK,
        provider: 'qwen-chat',
        model,
        prompt,
        status: videoUrl ? 'completed' : (result.status || 'processing'),
        task_id: result.task_id || result.id || null,
        video_url: videoUrl || null,
        data: videoUrl ? [{ url: videoUrl }] : [],
        waitForCompletion,
        raw: result
    };
}

/**
 * POST /api/images/generations
 * По умолчанию генерирует изображения через Qwen Chat (`chatType: t2i`).
 * Для старого DashScope-режима передайте `provider: "dashscope"`.
 */
router.post('/images/generations', async (req, res) => {
    try {
        const { prompt, model, n, size, response_format, provider } = req.body;

        logInfo('Получен запрос на генерацию изображения');
        logDebug(`Запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        if (provider === 'dashscope') {
            const apiKey = process.env.DASHSCOPE_API_KEY;
            if (!apiKey) {
                return res.status(503).json({
                    error: 'DashScope API генерации изображений не настроен',
                    message: 'Установите переменную окружения DASHSCOPE_API_KEY или используйте provider=qwen-chat'
                });
            }

            let imageModel = model || 'qwen-image-plus';
            if (imageModel === 'dall-e-3' || imageModel === 'dall-e-2') imageModel = 'qwen-image-plus';
            const result = await generateImage(prompt, imageModel, {
                n: n || 1,
                size: normalizeDashScopeSize(size),
                promptExtend: true,
                watermark: false
            });

            if (result.error) {
                logError(`Ошибка генерации DashScope: ${result.error}`);
                return res.status(500).json({ error: 'Ошибка генерации изображения', message: result.error });
            }

            return res.json(buildOpenAiImageResponse({
                imageUrl: result.imageUrl,
                prompt,
                model: imageModel,
                raw: result,
                provider: 'dashscope'
            }));
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2i',
            aspectRatio,
            true
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat image: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации изображения через Qwen Chat', message: result.error, details: result.details });
        }

        const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
        if (!imageUrl) {
            return res.status(502).json({
                error: 'Qwen Chat не вернул URL изображения',
                raw: result
            });
        }

        logInfo(`Изображение Qwen Chat сгенерировано: ${imageUrl}`);
        return res.json(buildOpenAiImageResponse({ imageUrl, prompt, model: chatModel, raw: result }));
    } catch (error) {
        logError('Ошибка при генерации изображения', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * POST /api/videos/generations - Генерация видео через Qwen Chat (`chatType: t2v`).
 */
router.post('/videos/generations', async (req, res) => {
    try {
        const { prompt, model, size, wait, waitForCompletion } = req.body;
        const shouldWait = waitForCompletion ?? wait ?? true;

        logInfo('Получен запрос на генерацию видео через Qwen Chat');
        logDebug(`Видео-запрос: ${prompt?.substring(0, 100)}${prompt?.length > 100 ? '...' : ''}`);

        if (!prompt) {
            return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        }

        const chatModel = getMappedModel(model || CHAT_MEDIA_MODEL);
        const aspectRatio = normalizeQwenAspectRatio(size, req.body.aspect_ratio || '16:9');
        const result = await sendMessage(
            prompt,
            chatModel,
            null,
            null,
            null,
            null,
            null,
            null,
            't2v',
            aspectRatio,
            shouldWait
        );

        if (result.error) {
            logError(`Ошибка генерации Qwen Chat video: ${result.error}`);
            return res.status(500).json({ error: 'Ошибка генерации видео через Qwen Chat', message: result.error, details: result.details, task_id: result.task_id });
        }

        const response = buildVideoResponse({ result, prompt, model: chatModel, waitForCompletion: shouldWait });
        logInfo(response.video_url ? `Видео Qwen Chat сгенерировано: ${response.video_url}` : `Видео-задача создана: ${response.task_id}`);
        return res.json(response);
    } catch (error) {
        logError('Ошибка при генерации видео', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/tasks/status/:taskId - статус долгой задачи Qwen Chat (видео и будущие async-функции).
 */
router.get('/tasks/status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        if (!taskId) return res.status(400).json({ error: 'taskId обязателен' });

        const result = await pollQwenTaskStatus(taskId, wait);
        if (result.error && !result.data) {
            return res.status(500).json(result);
        }
        return res.json({ watermark: FORGETMEAI_WATERMARK, ...result });
    } catch (error) {
        logError('Ошибка при проверке статуса задачи', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера', message: error.message });
    }
});

/**
 * GET /api/images/models - модели для генерации изображений.
 */
router.get('/images/models', async (req, res) => {
    try {
        const dashScopeModels = getAvailableImageModels();
        res.json({
            object: 'list',
            watermark: FORGETMEAI_WATERMARK,
            data: [
                {
                    id: CHAT_MEDIA_MODEL,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen-chat',
                    permission: [],
                    capability: 'qwen_chat_image_generation',
                    provider: 'qwen-chat'
                },
                ...dashScopeModels.map(model => ({
                    id: model,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen',
                    permission: [],
                    capability: 'image_generation',
                    provider: 'dashscope'
                }))
            ]
        });
    } catch (error) {
        logError('Ошибка при получении списка моделей изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * GET /api/videos/models - модели для генерации видео через Qwen Chat.
 */
router.get('/videos/models', async (req, res) => {
    res.json({
        object: 'list',
        watermark: FORGETMEAI_WATERMARK,
        data: [{
            id: CHAT_MEDIA_MODEL,
            object: 'model',
            created: Date.now(),
            owned_by: 'qwen-chat',
            permission: [],
            capability: 'qwen_chat_video_generation',
            provider: 'qwen-chat'
        }]
    });
});

/**
 * GET /api/images/status - Проверка статуса генерации изображений.
 */
router.get('/images/status', async (req, res) => {
    try {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        const dashScopeAvailable = await checkImageApiAvailability();
        const tokens = listTokens();
        const now = Date.now();
        const qwenChatAvailable = tokens.some(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);

        res.json({
            watermark: FORGETMEAI_WATERMARK,
            qwenChat: {
                available: qwenChatAvailable,
                model: CHAT_MEDIA_MODEL,
                message: qwenChatAvailable ? 'Qwen Chat генерация изображений доступна' : 'Нет активных аккаунтов Qwen Chat'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: !!apiKey,
                message: dashScopeAvailable
                    ? 'DashScope API генерации изображений доступен'
                    : apiKey
                        ? 'DashScope API недоступен или неверные учётные данные'
                        : 'DASHSCOPE_API_KEY не настроен'
            }
        });
    } catch (error) {
        logError('Ошибка при проверке статуса API изображений', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

/**
 * GET /api/videos/status - Проверка готовности видео-генерации Qwen Chat.
 */
router.get('/videos/status', async (req, res) => {
    const tokens = listTokens();
    const now = Date.now();
    const availableAccounts = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid).length;
    res.json({
        watermark: FORGETMEAI_WATERMARK,
        available: availableAccounts > 0,
        model: CHAT_MEDIA_MODEL,
        accounts: { total: tokens.length, available: availableAccounts },
        message: availableAccounts > 0 ? 'Qwen Chat генерация видео доступна' : 'Нет активных аккаунтов Qwen Chat'
    });
});

export default router;
