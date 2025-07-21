# API-прокси для Qwen AI

API-прокси для доступа к Qwen AI через эмуляцию браузера с поддержкой OpenAI-совместимого API. Позволяет использовать все возможности Qwen AI без официального API ключа, включая работу с текстом, изображениями и файлами. Поддерживает управление чатами, мульти-аккаунт систему с автоматической ротацией токенов, и полную совместимость с OpenAI SDK.

## 1. Быстрый старт

### 1.1 Установка

```bash
# Клонировать репозиторий
git clone https://github.com/y13sint/FreeQwenApi.git
cd FreeQwenApi

# Установить зависимости
npm install
```

### 1.2 Запуск

```bash
# Запустить прокси-сервер
npm start
```

Также доступен файл быстрого запуска для Windows:

```
start.bat
```

При первом запуске откроется интерактивное меню для добавления аккаунтов. Следуйте инструкциям в консоли для авторизации через браузер.


## 2. Возможности

- **OpenAI-совместимый API**
- **18 моделей Qwen**
- **Загрузка файлов**
- **Мульти-аккаунт**
- **Streaming** 


## 3. Авторизация

### 3.1 API-ключи

> ⚠️ **Важно:** Если файл `src/Authorization.txt` пустой, авторизация **отключена**.

Для защиты доступа к прокси можно настроить авторизацию через API ключи:

1. **Файл `src/Authorization.txt`**
   - Создаётся автоматически при первом запуске *если его нет*
   - Внутри уже есть подробный шаблон-инструкция
   - Один токен **на строку**. Пустые строки и строки, начинающиеся с `#`, игнорируются

2. **Отключить авторизацию** – оставьте файл пустым

3. **Использование ключа в запросах:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-api-key-1" \
  -d '{"message":"Привет!"}'
```

### 3.2 Мульти-аккаунт и ротация токенов

При старте `npm start` появляется интерактивное меню:

```
Список аккаунтов:
 N | ID                | Статус
 1 | acc_1752745840684 | ✅ OK
 2 | acc_1752745890062 | ❌ INVALID

=== Меню ===
1 - Добавить новый аккаунт
2 - Перелогинить аккаунт с истекшим токеном
3 - Запустить прокси (по умолчанию)
4 - Удалить аккаунт
```

**Статусы аккаунтов:**

| Значок | Значение | Поведение |
|--------|----------|-----------|
| ✅ OK | токен активен | используется в ротации |
| ⏳ WAIT | токен временно заблокирован (RateLimited) | пропускается до истечения тайм-аута |
| ❌ INVALID | токен просрочен (401 Unauthorized) | недоступен, требуется перелогин |

**Пункты меню:**

1. **Добавить новый аккаунт** – откроется браузер, авторизуйтесь, токен будет сохранён
2. **Перелогинить аккаунт с истекшим токеном** – выберите нужный ID для повторного входа
3. **Запустить прокси** – доступно, если есть хотя бы один активный аккаунт
4. **Удалить аккаунт** – полностью удаляет токен и папку сессии

**Файлы системы:**

- `session/accounts/<id>/token.txt` – токен аккаунта
- `session/tokens.json` – реестр аккаунтов и состояний

**Автоматическая ротация:**

- Запросы распределяются по токенам циклически
- При ответе **429 RateLimited** токен получает ⏳ WAIT на указанное время
- При ответе **401 Unauthorized** токен помечается ❌ INVALID
- Если все токены недействительны – прокси завершает работу

## 4. API Reference

### 4.1 Основные эндпоинты

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| POST | `/api/chat` | Отправка сообщения (собственный формат) |
| POST | `/api/chat/completions` | OpenAI-совместимый эндпоинт |
| GET | `/api/models` | Список доступных моделей |
| GET | `/api/status` | Статус авторизации |
| POST | `/api/chats` | Создать новый чат |
| GET | `/api/chats` | Список всех чатов |
| GET | `/api/chats/:chatId` | История конкретного чата |
| DELETE | `/api/chats/:chatId` | Удалить чат |
| PUT | `/api/chats/:chatId/rename` | Переименовать чат |
| POST | `/api/chats/cleanup` | Автоудаление чатов по критериям |
| POST | `/api/files/upload` | Загрузка файла |
| POST | `/api/files/getstsToken` | Получение STS токена для загрузки |

### 4.2 Выбор эндпоинтов (`/api/chat` vs `/api/chat/completions`)

| Эндпоинт | Использование контекста | Формат запроса | Совместимость |
|----------|------------------------|----------------|---------------|
| **`/api/chat`** | Прокси хранит внутреннюю историю `chatId` и автоматически подаёт её модели при каждом запросе | Упрощённый `message` **или** массив `messages` | Нативный для прокси |
| **`/api/chat/completions`** | Прокси НЕ хранит контекст между запросами: каждый вызов следует спецификации OpenAI | Только массив `messages` (OpenAI format) | OpenAI SDK |

### 4.3 Форматы запросов

**Простое текстовое сообщение:**

```json
{
  "message": "Расскажи о Python"
}
```

**Сообщение с моделью и чатом:**

```json
{
  "message": "Продолжи рассказ",
  "model": "qwen-max-latest",
  "chatId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Формат совместимый с Qwen API (с массивом messages):**

```json
{
  "messages": [
    {"role": "user", "content": "Привет, как дела?"}
  ],
  "model": "qwen-max-latest",
  "chatId": "идентификатор_чата"
}
```

**Составное сообщение (текст + изображение):**

```json
{
  "message": [
    {"type": "text", "text": "Что на этом изображении?"},
    {"type": "image", "image": "https://example.com/image.jpg"}
  ],
  "model": "qwen-vl-max"
}
```

**OpenAI формат с историей:**

```json
{
  "messages": [
    {"role": "system", "content": "Ты полезный ассистент"},
    {"role": "user", "content": "Привет!"},
    {"role": "assistant", "content": "Здравствуйте!"},
    {"role": "user", "content": "Как дела?"}
  ],
  "model": "qwen-max",
  "stream": true
}
```

### 4.4 История диалогов

> **Важно:** Прокси использует внутреннюю систему хранения истории диалогов на сервере.

При использовании формата `messages` - из массива извлекается только последнее сообщение пользователя и добавляется в историю. При отправке запроса к API Qwen **всегда** используется полная история диалога, связанная с указанным `chatId`.

**Структура истории:**

```json
{
  "id": "uuid-чата",
  "name": "Название чата",
  "created": 1234567890000,
  "messages": [
    {
      "id": "uuid-сообщения",
      "role": "user",
      "content": "Текст или составное содержимое",
      "timestamp": 1234567890,
      "chat_type": "t2t"
    }
  ]
}
```

Максимальная длина истории: 100 сообщений.

### 4.5 Работа с изображениями

Для работы с изображениями используйте визуальные модели (qwen-vl-max, qwen-vl-plus).

#### Получение URL изображения

**Способ 1: Загрузка через API прокси**

```bash
curl -X POST http://localhost:3264/api/files/upload \
  -F "file=@/путь/к/изображению.jpg"
```

**Способ 2: Получение URL через веб-интерфейс Qwen**

1. Загрузите изображение в официальном веб-интерфейсе Qwen (<https://chat.qwen.ai/>)
2. Откройте инструменты разработчика (F12)
3. Перейдите на вкладку "Network"
4. Найдите запрос GetsToken
5. Скопируйте URL изображения из тела запроса

**Анализ изображения по URL:**

```javascript
const response = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: [
      { type: 'text', text: 'Опиши это изображение' },
      { type: 'image', image: 'https://example.com/image.jpg' }
    ],
    model: 'qwen-vl-max'
  })
});
```

### 4.6 Загрузка файлов

Прокси поддерживает загрузку файлов до 10MB.

**Процесс загрузки:**

```bash
# Шаг 1: Загрузка файла
UPLOAD_RESPONSE=$(curl -s -X POST http://localhost:3264/api/files/upload \
  -F "file=@/путь/к/файлу.jpg")

# Шаг 2: Извлечение URL
FILE_URL=$(echo $UPLOAD_RESPONSE | grep -o '"file":{"url":"[^"]*"' | sed 's/"file":{"url":"//;s/"//')

# Шаг 3: Использование в чате
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      { "type": "text", "text": "Проанализируй этот документ" },
      { "type": "file", "file": "'$FILE_URL'" }
    ]
  }'
```

**Поддерживаемые форматы:**

- Изображения: jpg, jpeg, png, gif, webp, bmp
- Документы: pdf, doc, docx, txt

### 4.7 Управление диалогами

**Создание чата:**

```bash
curl -X POST http://localhost:3264/api/chats \
  -H "Content-Type: application/json" \
  -d '{"name": "Мой новый чат"}'
```

**Автоудаление старых чатов:**

```javascript
// Удалить чаты старше 7 дней с менее чем 3 сообщениями
const response = await fetch('http://localhost:3264/api/chats/cleanup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    olderThan: 7 * 24 * 60 * 60 * 1000, // 7 дней в мс
    userMessageCountLessThan: 3,
    messageCountLessThan: 5,
    maxChats: 50 // Оставить только 50 самых новых чатов
  })
});
```

## 5. Работа с контекстом

Прокси автоматически управляет контекстом диалогов:

1. **Автоматическое создание чата** - если `chatId` не указан
2. **Сохранение истории** - все сообщения сохраняются в файлы
3. **Ограничение истории** - максимум 100 сообщений на чат
4. **Передача контекста** - вся история отправляется в API Qwen

**Последовательность работы с контекстом:**

```javascript
// 1. Первый запрос (без chatId)
const response1 = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Привет, как тебя зовут?'
  })
});

// 2. Ответ содержит chatId
const { chatId } = await response1.json();

// 3. Последующие запросы с chatId
const response2 = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Сколько будет 2+2?',
    chatId: chatId
  })
});
```

## 6. Совместимость с OpenAI API

### 6.1 Особенности

Прокси обеспечивает полную совместимость с OpenAI API через эндпоинт `/api/chat/completions`:

- **Формат запросов/ответов** - идентичен OpenAI
- **Работа с SDK** - поддержка официальной библиотеки OpenAI
- **Маппинг моделей** - автоматическое преобразование названий
- **Streaming** - потоковая передача ответов в формате SSE
- **Системные сообщения** - полная поддержка role: "system"

**Важно:** Каждый запрос к `/chat/completions` создаёт новый чат с именем "OpenAI API Chat".

**Использование с OpenAI SDK:**

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key' // Требуется SDK, но не используется
});

const completion = await openai.chat.completions.create({
  messages: [
    { role: 'system', content: 'Ты эксперт по JavaScript' },
    { role: 'user', content: 'Как создать класс?' }
  ],
  model: 'qwen-max'
});
```

### 6.2 Streaming

Поддержка потоковой передачи для эффекта "печатания":

```javascript
const stream = await openai.chat.completions.create({
  messages: [{ role: 'user', content: 'Расскажи историю' }],
  model: 'qwen-max',
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

**Ограничения совместимости:**

- Некоторые специфичные для OpenAI параметры (например, `logprobs`, `functions`) не поддерживаются
- Скорость потоковой передачи может отличаться от оригинального OpenAI API

## 7. FAQ / Особенности реализации

**Q: Какие модели доступны?**
A: 18 моделей Qwen через систему маппинга:

- Стандартные: qwen-max, qwen-plus, qwen-turbo (и их latest версии)
- Coder: qwen-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)
- Визуальные: qwen-vl-max, qwen-vl-plus (и их latest версии)
- Qwen 3: qwen3, qwen3-max, qwen3-plus

**Q: Как работает авторизация через браузер?**
A: При первом запуске открывается браузер для входа в Qwen. После авторизации токен сохраняется и используется для API запросов. Браузер переключается в headless режим.

**Q: Что делать при ошибке rate limit?**
A: Добавьте несколько аккаунтов. Система автоматически переключится на следующий доступный.

**Q: Где хранятся данные?**
A: В директории `session/`:

- `accounts/` - токены аккаунтов
- `history/` - история чатов
- `tokens.json` - информация о токенах

**Q: Можно ли использовать в production?**
A: Прокси предназначен для разработки и тестирования. Для production рекомендуется официальный API.

## 8. Примеры

<details><summary>8.1 Текстовые запросы</summary>

**Простой запрос:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Напиши хайку о программировании"}'
```

**С выбором модели:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Напиши функцию сортировки на Python",
    "model": "qwen-coder-plus"
  }'
```

**В формате официального API:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Что такое искусственный интеллект?"}
    ],
    "model": "qwen-max-latest"
  }'
```

**С сохранением контекста:**

```javascript
// Первый запрос
const res1 = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Меня зовут Алексей'
  })
});
const { chatId } = await res1.json();

// Второй запрос с контекстом
const res2 = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: 'Как меня зовут?',
    chatId: chatId
  })
});
```

</details>

<details><summary>8.2 Запросы с изображениями</summary>

**Загрузка и анализ изображения:**

```bash
# Шаг 1: Загрузка изображения
UPLOAD_RESPONSE=$(curl -s -X POST http://localhost:3264/api/files/upload \
  -F "file=@/путь/к/изображению.jpg")

# Шаг 2: Извлечение URL изображения
IMAGE_URL=$(echo $UPLOAD_RESPONSE | grep -o '"imageUrl":"[^"]*"' | sed 's/"imageUrl":"//;s/"//')

# Шаг 3: Отправка запроса с изображением
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      { "type": "text", "text": "Опишите объекты на этом изображении" },
      { "type": "image", "image": "'$IMAGE_URL'" }
    ],
    "model": "qwen-vl-max"
  }'
```

**Сравнение изображений:**

```javascript
const response = await fetch('http://localhost:3264/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: [
      { type: 'text', text: 'Найди различия между изображениями' },
      { type: 'image', image: 'https://example.com/img1.jpg' },
      { type: 'image', image: 'https://example.com/img2.jpg' }
    ],
    model: 'qwen-vl-plus'
  })
});
```

</details>

<details><summary>8.3 Postman</summary>

**Пошаговое руководство через Postman:**

1. **Загрузка изображения**:
   - Создайте новый запрос POST к `http://localhost:3264/api/files/upload`
   - Выберите вкладку "Body"
   - Выберите тип "form-data"
   - Добавьте ключ "file" и выберите тип "File"
   - Загрузите изображение, нажав "Select Files"
   - Нажмите "Send"

   Ответ будет содержать URL изображения:

   ```json
   {
     "imageUrl": "https://cdn.qwenlm.ai/..."
   }
   ```

2. **Использование изображения в запросе**:
   - Создайте новый запрос POST к `http://localhost:3264/api/chat`
   - Выберите вкладку "Body" → "raw" → "JSON"
   - Вставьте JSON, заменив `URL_ИЗОБРАЖЕНИЯ` на полученный URL:

   ```json
   {
     "message": [
       {
         "type": "text",
         "text": "Опишите объекты на этом изображении"
       },
       {
         "type": "image",
         "image": "URL_ИЗОБРАЖЕНИЯ"
       }
     ],
     "model": "qwen-vl-max"
   }
   ```

3. **OpenAI-совместимый эндпоинт**:
   - URL: `http://localhost:3264/api/chat/completions`
   - Добавьте параметр `"stream": true` для потокового режима
   - Для корректного отображения потока включите "Preserve log" в консоли

</details>

<details><summary>8.4 OpenAI SDK</summary>

**Установка:**

```bash
npm install openai
```

**Базовое использование:**

```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'not-needed'
});

// Простой запрос
const completion = await openai.chat.completions.create({
  messages: [{ role: 'user', content: 'Расскажи анекдот' }],
  model: 'qwen-max'
});

console.log(completion.choices[0].message.content);
```

**С системным сообщением:**

```javascript
const completion = await openai.chat.completions.create({
  messages: [
    { role: 'system', content: 'Ты - эксперт по Python' },
    { role: 'user', content: 'Как работают декораторы?' }
  ],
  model: 'qwen-plus'
});
```

**Streaming ответ:**

```javascript
const stream = await openai.chat.completions.create({
  messages: [{ role: 'user', content: 'Напиши рассказ' }],
  model: 'qwen-max',
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

**Загрузка и анализ изображения:**

```javascript
import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

async function uploadAndAnalyzeImage(imagePath) {
  // Загрузка изображения
  const formData = new FormData();
  formData.append('file', fs.createReadStream(imagePath));
  
  const uploadResponse = await axios.post(
    'http://localhost:3264/api/files/upload', 
    formData,
    { headers: formData.getHeaders() }
  );
  
  const imageUrl = uploadResponse.data.imageUrl;
  
  // Анализ изображения
  const completion = await openai.chat.completions.create({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Опиши изображение' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    model: 'qwen-vl-max'
  });
  
  console.log(completion.choices[0].message.content);
}

// Использование
uploadAndAnalyzeImage('./image.jpg');
```

</details>

---

Полная документация и примеры доступны в директории `examples/`.
