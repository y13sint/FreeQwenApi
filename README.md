Cистема для создания и эмуляции активных форумов IPB надо кому?

# FreeQwenApi

- **Бесплатный доступ**: Используйте модели Qwen без оплаты API-ключа
- **Полная совместимость**: Поддержка OpenAI-совместимого интерфейса для простой интеграции
- **Возможность загрузки файлов и получение ссылки прямо из прокси**
- **🆕 API v2**: Обновлено на новый Qwen API с улучшенной системой контекста
- **🔥 25+ моделей**: Поддержка всех современных моделей Qwen, включая Qwen 3.5
- **🎨 Генерация изображений**: Поддержка Qwen Image API через DALL-E-совместимый интерфейс
- **💾 Автосохранение сессий**: Умное управление контекстом для OpenWebUI

**Что можно делать:**

- Отправлять запросы к 18 моделям Qwen (включая qwen3-max, qwen3-coder-plus, qwq-32b и др.)
- Использовать OpenAI SDK без изменений -- просто поменяйте `baseURL`
- Вести диалоги с сохранением контекста на серверах Qwen (API v2)
- Загружать файлы и изображения для анализа
- Получать ответы в потоковом режиме (SSE streaming)
- Подключать несколько аккаунтов с автоматической ротацией

```bash
# Всё, что нужно -- обычный OpenAI-совместимый запрос
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-max-latest","messages":[{"role":"user","content":"Привет!"}]}'
```

---

## Содержание

1. [Быстрый старт](#быстрый-старт)
2. [Docker](#docker)
3. [Управление аккаунтами](#управление-аккаунтами)
4. [Авторизация API-ключами](#авторизация-api-ключами)
5. [API Reference](#api-reference)
   - [POST /api/chat](#post-apichat)
   - [POST /api/chat/completions](#post-apichatcompletions)
   - [GET /api/models](#get-apimodels)
   - [GET /api/status](#get-apistatus)
   - [POST /api/chats](#post-apichats)
   - [POST /api/files/upload](#post-apifilesupload)
   - [POST /api/files/getstsToken](#post-apifilesgeststoken)
6. [Работа с контекстом (API v2)](#работа-с-контекстом-api-v2)
7. [Работа с изображениями](#работа-с-изображениями)
8. [OpenAI SDK](#openai-sdk)
9. [Python](#python)
10. [Доступные модели](#доступные-модели)
11. [Переменные окружения](#переменные-окружения)
12. [Структура проекта](#структура-проекта)

---

## Быстрый старт

```bash
# Node.js (Основной)
git clone https://github.com/y13sint/FreeQwenApi
cd FreeQwenApi
npm install
npm start

# Python (Альтернативный)
git clone https://github.com/y13sint/FreeQwenApi
cd FreeQwenApi
python -m venv venv
# Windows:
# venv\Scripts\activate
# Linux/macOS:
# source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
python main.py
```

При первом запуске появится интерактивное меню:

```
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██

Список аккаунтов:
  (пусто)

=== Меню ===
1 - Добавить новый аккаунт
2 - Перелогинить аккаунт с истекшим токеном
3 - Запустить прокси (по умолчанию)
4 - Удалить аккаунт
Ваш выбор (Enter = 3):
```

**Порядок действий:**

1. Выберите `1` -- откроется браузер Chromium
2. Войдите в свой аккаунт Qwen на открывшейся странице
3. После входа токен извлечётся автоматически, браузер закроется
4. Выберите `3` (или нажмите Enter) -- сервер запустится

Сервер будет доступен по адресу `http://localhost:3264/api`.

---

## Docker

Перед сборкой Docker-образа нужно добавить хотя бы один аккаунт, поскольку внутри контейнера нет GUI для интерактивного входа:

```bash
# 1. Добавляем аккаунт(ы) локально
npm run auth

# 2. Собираем и запускаем
docker compose up --build -d
```

Файл `docker-compose.yml`:

```yaml
services:
  qwen-proxy:
    build: .
    container_name: qwen-proxy
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
    restart: unless-stopped
```

Переменная `SKIP_ACCOUNT_MENU=true` (или `NON_INTERACTIVE=true`) пропускает интерактивное меню и сразу запускает сервер, используя ранее сохранённые токены из `session/`.

---

## Управление аккаунтами

### Интерактивное меню

При запуске `npm start` без флага `SKIP_ACCOUNT_MENU` отображается меню с 4 пунктами:

| Пункт | Действие |
|-------|----------|
| 1 | Добавить новый аккаунт -- откроется браузер для входа |
| 2 | Перелогинить аккаунт -- обновить токен для аккаунта с истёкшей сессией |
| 3 | Запустить прокси -- стандартный запуск (по умолчанию) |
| 4 | Удалить аккаунт -- удалить сохранённый аккаунт |

### Статусы аккаунтов

| Статус | Значение |
|--------|----------|
| OK | Аккаунт активен, токен валиден |
| WAIT | Rate limit -- ожидание сброса (автоматический таймер на 24ч) |
| INVALID | Токен истёк или отозван -- требуется перелогин |

### Ротация аккаунтов

Если подключено несколько аккаунтов, сервер автоматически:
- Выбирает следующий активный аккаунт (round-robin)
- При получении HTTP 429 (rate limit) помечает аккаунт как WAIT и переключается на следующий
- При получении HTTP 401 (unauthorized) помечает аккаунт как INVALID и переключается на следующий

### Отдельный CLI для авторизации

```bash
npm run auth
```

Запускает скрипт авторизации без запуска сервера -- удобно для Docker-окружения, когда нужно добавить аккаунты перед сборкой.

### Файлы аккаунтов

```
session/
├── tokens.json          # Реестр всех аккаунтов и их статусов
└── accounts/
    ├── acc_1234567890/
    │   └── token.txt    # Токен аккаунта
    └── acc_9876543210/
        └── token.txt
```

---

## Авторизация API-ключами

По умолчанию авторизация отключена -- API доступен всем. Для включения добавьте ключи в файл `src/Authorization.txt`:

```
# Один ключ на строку
d35ab3e1-a6f9-4d00-b1c2-example-key1
f2b1cd9c-1b2e-4a99-8c3d-example-key2
```

После этого каждый запрос к API должен содержать заголовок:

```
Authorization: Bearer d35ab3e1-a6f9-4d00-b1c2-example-key1
```

Пустые строки и строки, начинающиеся с `#`, игнорируются. Если файл пуст или содержит только комментарии -- авторизация отключена.

---

## API Reference

Все эндпоинты доступны по базовому пути `/api`. Версионирование (`/v1`, `/v2`) в URL опционально и автоматически удаляется -- `/api/v1/chat/completions` и `/api/chat/completions` эквивалентны.

### POST /api/chat

Нативный формат запроса. Поддерживает текст, составные сообщения с изображениями, system message.

#### Простой текстовый запрос

**Запрос:**

```bash
docker compose up --build -d
```

3. Приложение будет доступно на `http://localhost:3264/api`.

> ⚙️ Контейнер запускается с переменной `SKIP_ACCOUNT_MENU=true`, поэтому интерактивное меню не блокирует старт. Папки `session/`, `logs/` и `uploads/` примонтированы в контейнер как тома, что позволяет повторно использовать сохранённые токены и журналы.

---

## 2. Авторизация через API-ключи

> ⚠️ **Важно:** если файл `src/Authorization.txt` пустой, авторизация **отключена**.

1. **Файл `src/Authorization.txt`**
   - Создаётся автоматически при первом запуске *если его нет*.
   - Внутри уже есть подробный шаблон-инструкция.
   - Один токен **на строку**. Пустые строки и строки, начинающиеся с `#`, игнорируются.

2. **Отключить авторизацию** – оставьте файл пустым. Middleware пропустит все запросы.

3. **Проверка на стороне клиента**

   Отправляйте HTTP-заголовок:

   ```http
   Authorization: Bearer <your_token>
   ```

   Пример cURL:

   ```bash
   curl -X POST http://localhost:3264/api/chat \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer my-secret-token-123" \
        -d '{"message":"Привет"}'
   ```

---

## 3. Управление аккаунтами (Multi-Account)

При старте `npm start` появляется интерактивное меню:

```
Список аккаунтов:
 N | ID                | Статус
 1 | acc_1752745840684 | ✅ OK
 2 | acc_1752745890062 | ❌ INVALID

=== Меню ===
1 - Добавить новый аккаунт
2 - Перелогинить аккаунт с истекшим токеном
3 - Запустить прокси (Enter по умолчанию)
4 - Удалить аккаунт
```

Статусы:

| Значок | Значение | Поведение |
|--------|----------|-----------|
| ✅ OK  | токен активен | используется в ротации |
| ⏳ WAIT | токен временно заблокирован (RateLimited) | пропускается до истечения тайм-аута |
| ❌ INVALID | токен просрочен (401 Unauthorized) | недоступен, выберите пункт 2 для повторного входа |

Пункты меню:

1. **Добавить новый аккаунт** – откроется браузер, авторизуйтесь, токен будет сохранён.
2. **Перелогинить аккаунт с истекшим токеном** – выберите нужный ID, откроется браузер для повторного входа, статус сменится на ✅.
3. **Запустить прокси** – доступно, если есть хотя бы один статус ✅ или ⏳.
4. **Удалить аккаунт** – полностью удаляет токен и папку сессии.

Файлы:

- `session/accounts/<id>/token.txt` – токен аккаунта
- `session/tokens.json` – реестр аккаунтов и состояний
- `npm run auth` – отдельный скрипт для управления аккаунтами без запуска сервера (то же меню, плюс CLI-аргументы `--list`, `--add`, `--relogin`, `--remove`)

---

## ⚙️ Переменные окружения

| Переменная | Значение по умолчанию | Назначение |
|------------|------------------------|------------|
| `PORT` | `3264` | Порт HTTP-сервера |
| `HOST` | `0.0.0.0` | Адрес привязки сервера |
| `SKIP_ACCOUNT_MENU` | `false` | При значении `true` отключает интерактивное меню запуска (нужно для Docker/CI) |

> `SKIP_ACCOUNT_MENU` автоматически активирован в Docker Compose. Если при старте нет валидных токенов, сервер завершит работу с подсказкой запустить `npm run auth`.

---

Автоматическая ротация:

- запросы распределяются по токенам циклически.
- При ответе **429 RateLimited** токен получает ⏳ WAIT на указанное время.
- При ответе **401 Unauthorized** токен помечается ❌ INVALID.
- Если все токены недействительны – прокси завершает работу, запустите его и перелогиньтесь.

---

## 4. Возможности

Этот проект позволяет:

- Использовать модели Qwen AI через локальный API
- Сохранять контекст диалогов между запросами
- Управлять диалогами через API
- Выбирать различные модели Qwen для генерации ответов
- Отправлять изображения для анализа моделью
- Использовать OpenAI-совместимый API с поддержкой streaming режима
- Генерировать изображения через Qwen Image API

---

## 📊 Доступные модели

Прокси поддерживает **25+ моделей Qwen** через систему маппинга:

### Стандартные модели
- `qwen-max` / `qwen-max-latest` — наиболее мощная модель
- `qwen-plus` / `qwen-plus-latest` — сбалансированная модель
- `qwen-turbo` / `qwen-turbo-latest` — быстрая и лёгкая модель

### Модели Qwen 3.5 ✨
- `qwen3.5-plus` / `qwen3.5-plus-latest` — улучшенная версия Plus
- `qwen3.5-flash` / `qwen3.5-flash-latest` — быстрая модель Qwen 3.5
- `qwen3.5-397b-a17b` — сверхбольшая модель (397B параметров)
- `qwen3.5-122b-a10b` — большая модель (122B параметров)
- `qwen3.5-27b` — средняя модель (27B параметров)
- `qwen3.5-35b-a3b` — компактная модель (35B параметров)

### Модели Qwen 3
- `qwen3` — базовая модель Qwen 3
- `qwen3-max` — максимальная модель Qwen 3
- `qwen3-plus` — сбалансированная модель Qwen 3
- `qwen3-omni-flash` — быстрая мультимодальная модель

### Модели для кодинга
- `qwen3-coder-plus` — модель для программирования
- `qwen2.5-coder-32b-instruct` — кодирование (32B)
- `qwen2.5-coder-7b-instruct` — кодирование (7B)
- `qwen2.5-coder-3b-instruct` — кодирование (3B)
- `qwen2.5-coder-1.5b-instruct` — кодирование (1.5B)
- `qwen2.5-coder-0.5b-instruct` — кодирование (0.5B)

### Визуальные модели
- `qwen-vl-max` / `qwen-vl-max-latest` — максимальная визуальная модель
- `qwen-vl-plus` / `qwen-vl-plus-latest` — сбалансированная визуальная модель
- `qwen2.5-vl-32b-instruct` — визуальная модель (32B)
- `qwen2.5-vl-7b-instruct` — визуальная модель (7B)

### Другие модели
- `qvq-72b-preview-0310` — предпросмотр QVQ (72B)
- `qwen2.5-14b-instruct-1m` — контекст 1M токенов
- `qwen2.5-72b-instruct` — большая языковая модель (72B)

> **Система маппинга:** Прокси автоматически распознаёт алиасы моделей (например, `Qwen3.5-Plus`, `qwen3.5-flash-latest` → соответствующие канонические модели).

---

## 5. API Reference

### 5.1 Основные эндпоинты

| Эндпоинт | Метод | Описание |
|----------|-------|----------|
| `/api/chat` | POST | Отправка сообщения с поддержкой `chatId` и `parentId` |
| `/api/chat/completions` | POST | OpenAI-совместимый эндпоинт, возвращает `chatId`/`parentId` |
| `/api/models` | GET | Получение списка доступных моделей |
| `/api/status` | GET | Проверка статуса авторизации и аккаунтов |
| `/api/files/upload` | POST | Загрузка изображения для использования в запросах |
| `/api/chats` | POST | Создание нового чата на серверах Qwen |

**⚠️ Удалённые эндпоинты (v2):**
- `GET /api/chats` - список чатов
- `GET /api/chats/:chatId` - история чата
- `DELETE /api/chats/:chatId` - удаление чата
- `PUT /api/chats/:chatId/rename` - переименование
- `POST /api/chats/cleanup` - автоудаление

*Причина: чаты теперь управляются на серверах Qwen*

### 5.2 Выбор эндпоинтов

Эндпоинт | Использование контекста | Формат запроса | Совместимость |
----------|------------------------|----------------|---------------|
**`/api/chat`** | Контекст управляется через `chatId` + `parentId`. История хранится на серверах Qwen. | Упрощённый `message` + `chatId` + `parentId` | Нативный для прокси |
**`/api/chat/completions`** | Поддерживает `chatId` + `parentId` в запросе. Возвращает их в ответе для продолжения. | Массив `messages` (OpenAI format) + опционально `chatId`/`parentId` | OpenAI SDK |

### 5.3 Форматы запросов

#### 1. Упрощенный формат с параметром `message`

```json
{
  "message": "Текст сообщения",
  "model": "qwen-max-latest",
  "chatId": "идентификатор_чата",
  "parentId": "response_id_из_предыдущего_ответа"
}
```

#### 2. Формат, совместимый с OpenAI API

```json
{
  "messages": [
    {"role": "user", "content": "Привет, как дела?"}
  ],
  "model": "qwen-max-latest",
  "chatId": "идентификатор_чата",
  "parentId": "response_id_из_предыдущего_ответа"
}
```

### 5.4 Работа с контекстом (API v2)

**Новая система:**
- История хранится на серверах Qwen, не локально
- Контекст управляется через `chatId` + `parentId`
- `parentId` - это `response_id` из предыдущего ответа

**Пример диалога:**

```javascript
// 1. Первое сообщение
const res1 = await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ message: "Сколько будет 2+2?" })
});
const data1 = await res1.json();
// Ответ: { chatId: "abc-123", parentId: "xyz-789", ... }

// 2. Второе сообщение (с контекстом)
const res2 = await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ 
    message: "А результат плюс 3?",
    chatId: data1.chatId,      // Тот же чат
    parentId: data1.parentId    // Из предыдущего ответа!
  })
});
// Модель помнит контекст и ответит "7"
```

### 5.5 Системные инструкции (System Messages)

**Новое в v2:** Поддержка системных сообщений для настройки поведения модели!

Системные инструкции передаются через поле `role: "system"` в массиве `messages`. Это позволяет задать модели контекст, стиль общения, правила поведения и т.д.

**Пример:**

```javascript
// Запрос с системной инструкцией
const response = await fetch('/api/chat/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      {
        role: "system",
        content: "Ты - опытный программист на Python. Отвечай кратко и предоставляй примеры кода."
      },
      {
        role: "user",
        content: "Как отсортировать список в Python?"
      }
    ],
    model: "qwen-max-latest"
  })
});
```

**Как работает:**
- `system` message извлекается из массива и передаётся отдельным параметром в Qwen API v2
- Может использоваться в обоих эндпоинтах: `/api/chat` и `/api/chat/completions`
- System message применяется ко всему чату и влияет на все последующие ответы

**Примеры использования:**

```json
// 1. Ролевая инструкция
{
  "messages": [
    {"role": "system", "content": "Ты - эксперт по машинному обучению"},
    {"role": "user", "content": "Объясни, что такое градиентный спуск"}
  ]
}

// 2. Стиль ответов
{
  "messages": [
    {"role": "system", "content": "Отвечай как пират"},
    {"role": "user", "content": "Как дела?"}
  ]
}

// 3. Формат вывода
{
  "messages": [
    {"role": "system", "content": "Всегда отвечай в формате JSON"},
    {"role": "user", "content": "Дай информацию о Python"}
  ]
}
```

### 5.6 Работа с изображениями

Прокси поддерживает отправку сообщений с изображениями:

#### Формат `message` с изображением

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
  "model": "qwen-vl-max",
  "chatId": "идентификатор_чата",
  "parentId": "response_id"
}
```

### 5.7 Загрузка файлов

#### Загрузка изображения

```
POST http://localhost:3264/api/files/upload
```

**Формат запроса:** `multipart/form-data`

**Параметры:**

- `file` - файл изображения (поддерживаются форматы: jpg, jpeg, png, gif, webp)

**Пример использования с curl:**

```bash
curl -X POST http://localhost:3264/api/files/upload \
  -F "file=@/путь/к/изображению.jpg"
```

**Пример ответа:**

```json
{
  "imageUrl": "https://cdn.qwenlm.ai/user-id/file-id_filename.jpg?key=..."
}
```

#### Получение URL изображения

Для отправки изображений через API прокси необходимо сначала получить URL изображения. Это можно сделать двумя способами:

##### Способ 1: Загрузка через API прокси

Отправьте POST запрос на эндпоинт `/api/files/upload` для загрузки изображения, как описано выше.

##### Способ 2: Получение URL через веб-интерфейс Qwen

1. Загрузите изображение в официальном веб-интерфейсе Qwen (<https://chat.qwen.ai/>)
2. Откройте инструменты разработчика в браузере (F12 или Ctrl+Shift+I)
3. Перейдите на вкладку "Network" (Сеть)
4. Найдите запрос к API Qwen, содержащий ваше изображение (обычно это запрос GetsToken)
5. В теле запроса найдите URL изображения, который выглядит примерно так: `https://cdn.qwenlm.ai/user-id/file-id_filename.jpg?key=...`
6. Скопируйте этот URL для использования в вашем API-запросе

### 5.7 Управление диалогами

#### Создание нового диалога

```
POST http://localhost:3264/api/chats
```

**Тело запроса:**

```json
{
  "name": "Название диалога"
}
```

**Ответ:**

```json
{
  "id": "chatcmpl-1739012345678",
  "object": "chat.completion",
  "created": 1739012345,
  "model": "qwen-max-latest",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Квантовые вычисления — это тип вычислений, основанный на принципах квантовой механики..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 156,
    "total_tokens": 168
  },
  "chatId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "parentId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321"
}
```

#### Продолжение диалога (с контекстом)

Используйте `chatId` и `parentId` из предыдущего ответа:

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Приведи практические примеры",
    "model": "qwen-max-latest",
    "chatId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "parentId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321"
  }'
```

#### С system message через массив messages

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "system", "content": "Ты -- опытный Python-разработчик. Отвечай кратко, с примерами кода."},
      {"role": "user", "content": "Как отсортировать словарь по значениям?"}
    ],
    "model": "qwen-max-latest"
  }'
```

#### С изображением

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      {"type": "text", "text": "Что изображено на этой картинке?"},
      {"type": "image", "image": "https://example-oss-url.com/uploaded-image.png"}
    ],
    "model": "qwen3-vl-plus"
  }'
```

---

### POST /api/chat/completions

OpenAI-совместимый формат. Используйте этот эндпоинт, если работаете с OpenAI SDK или любым инструментом, поддерживающим OpenAI API.

#### Обычный запрос (без streaming)

**Запрос:**

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [
      {"role": "system", "content": "Отвечай кратко и по существу."},
      {"role": "user", "content": "Столица Японии?"}
    ]
  }'
```

**Ответ:**

```json
{
  "message": "Привет, как тебя зовут?"
}
```

2. **Ответ** (содержит `chatId`):

```json
{
  "chatId": "abcd-1234-5678",
  "choices": [...]
}
```

3. **Последующие запросы** (с указанием полученного `chatId`):

```json
{
  "message": "Сколько будет 2+2?",
  "chatId": "abcd-1234-5678"
}
```

---

## 🔌 Совместимость с OpenAI API

Прокси поддерживает эндпоинт, совместимый с OpenAI API для подключения клиентов, которые работают с OpenAI API:

```
POST /api/chat/completions
```

### Behavior

1. **Isolated by default:** if `chatId` is omitted and `conversation_id` is not provided, the proxy does not restore global session context (IP + User-Agent), so chats do not leak into each other.

2. **Conversation-aware routing:** if `conversation_id`/`chat_id` is provided, the proxy keeps context inside that scoped conversation.

3. **Legacy global restore is optional:** set `ALLOW_UNSCOPED_SESSION_CHAT_RESTORE=true` to return to old behavior (restore by IP + User-Agent when ids are omitted).

4. **Both id formats are supported:** `chatId`/`parentId` and `chat_id`/`parent_id`.

5. **Force a fresh chat:** send `newChat: true` or `new_chat: true`.

6. **System messages are supported:** `role: "system"` is passed through to the upstream model.

7. **Strict JSON parsing:** invalid JSON (for example, single quotes instead of double quotes) returns `400 Invalid JSON`.

8. **Method check:** `GET /api/chat/completions` returns `405`; use `POST`.

**System message request example:**

```json
{
  "messages": [
    {"role": "system", "content": "Ты эксперт по JavaScript. Отвечай только на вопросы о JavaScript."},
    {"role": "user", "content": "Как создать класс в JavaScript?"}
  ],
  "model": "qwen-max-latest"
}
```

### Поддержка streaming режима

Прокси поддерживает режим потоковой передачи ответов (streaming), что позволяет получать ответы по частям в режиме реального времени. Стриминг доступен в обоих эндпоинтах:

#### Эндпоинт `/api/chat/completions` (OpenAI-совместимый)

```json
{
  "messages": [
    {"role": "user", "content": "Напиши длинный рассказ о космосе"}
  ],
  "model": "qwen-max-latest",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Токио."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 18,
    "completion_tokens": 3,
    "total_tokens": 21
  },
  "chatId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "parentId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321"
}
```

#### Эндпоинт `/api/chat` (нативный)

```json
{
  "message": "Напиши длинный рассказ о космосе",
  "model": "qwen-max-latest",
  "stream": true
}
```

При использовании streaming режима, ответ будет возвращаться постепенно в формате Server-Sent Events (SSE), совместимом с OpenAI API.

### 🔥 Поддержка OpenWebUI

Прокси полностью поддерживает работу с **OpenWebUI** через streaming режим:

1. **Настройка подключения в OpenWebUI:**
   - Base URL: `http://localhost:3264/api`
   - API Key: любой (или оставьте пустым, если файл `Authorization.txt` пустой)

2. **Формат запроса для OpenWebUI:**

```json
{
  "messages": [
    {"role": "user", "content": "Привет!"}
  ],
  "model": "qwen-max-latest",
  "stream": true
}
```

3. **Изоляция чатов по умолчанию:** без `conversation_id`/`chatId` прокси не восстанавливает общий контекст по IP + User-Agent, чтобы исключить «память» между разными чатами.

4. **Scoped-контекст для OpenWebUI:** если OpenWebUI передаёт `conversation_id` (или `chat_id`), контекст продолжается внутри этого конкретного диалога.

5. **Legacy fallback при необходимости:** можно вернуть старое поведение через `ALLOW_UNSCOPED_SESSION_CHAT_RESTORE=true`.

6. **Поддержка всех эндпоинтов:**
   - `/api/chat/completions` — OpenAI-совместимый эндпоинт
   - `/api/v1/chat/completions` — альтернативный OpenAI-совместимый эндпоинт
   - `/api/chat` — нативный эндпоинт прокси

7. **Генерация изображений:** Через OpenWebUI можно использовать генерацию изображений через эндпоинт `/api/images/generations` (DALL-E-совместимый API).

---

### 🎨 Генерация изображений

Прокси поддерживает генерацию изображений через Qwen Image API:

**Эндпоинт:** `POST /api/images/generations`

```json
{
  "prompt": "Космический корабль на фоне туманности",
  "model": "qwen-image-plus",
  "n": 1,
  "size": "1024x1024"
}
```

**Ответ:**

```json
{
  "created": 1234567890,
  "data": [
    {
      "url": "https://example.com/generated-image.png",
      "revised_prompt": "Космический корабль на фоне туманности"
    }
  ]
}
```

**Параметры:**
- `prompt` (обязательный) — текстовое описание изображения
- `model` — модель генерации (`qwen-image-plus`, `qwen-image-turbo`)
- `n` — количество изображений (по умолчанию 1)
- `size` — размер (`1024x1024`, `1024x1792`, `1792x1024`, `512x512`, `768x768`, `960x960`)

> **Требуется API-ключ:** Для генерации изображений необходимо установить переменную окружения `DASHSCOPE_API_KEY`.

### Примеры использования с OpenAI SDK

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [
      {"role": "user", "content": "Напиши хайку о программировании"}
    ],
    "stream": true
  }'
```

**Ответ (SSE):**

```
data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1739012345,"model":"qwen-max-latest","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1739012345,"model":"qwen-max-latest","choices":[{"index":0,"delta":{"content":"Строки кода бегут"},"finish_reason":null}]}

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1739012345,"model":"qwen-max-latest","choices":[{"index":0,"delta":{"content":" —\nБаг затаился в ветвях"},"finish_reason":null}]}

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1739012345,"model":"qwen-max-latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

#### С продолжением диалога

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [
      {"role": "user", "content": "Теперь на тему космоса"}
    ],
    "chatId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "parentId": "f9e8d7c6-b5a4-3210-fedc-ba0987654321"
  }'
```

---

### GET /api/models

Возвращает список доступных моделей в формате OpenAI.

**Запрос:**

```bash
curl http://localhost:3264/api/models
```

**Ответ:**

```json
{
  "object": "list",
  "data": [
    {"id": "qwen3-max", "object": "model", "created": 0, "owned_by": "qwen", "permission": []},
    {"id": "qwen3-vl-plus", "object": "model", "created": 0, "owned_by": "qwen", "permission": []},
    {"id": "qwen3-coder-plus", "object": "model", "created": 0, "owned_by": "qwen", "permission": []},
    {"id": "qwq-32b", "object": "model", "created": 0, "owned_by": "qwen", "permission": []},
    {"id": "qwen-max-latest", "object": "model", "created": 0, "owned_by": "qwen", "permission": []}
  ]
}
```

> Полный список всех 18 моделей -- см. раздел [Доступные модели](#доступные-модели).

---

### GET /api/status

Проверяет статус авторизации и состояние всех аккаунтов. Для каждого аккаунта выполняется тестовый запрос к Qwen API.

**Запрос:**

```bash
curl http://localhost:3264/api/status
```

**Ответ:**

```json
{
  "authenticated": true,
  "message": "Авторизация активна",
  "accounts": [
    {"id": "acc_1739012345678", "status": "OK", "resetAt": null},
    {"id": "acc_1739098765432", "status": "WAIT", "resetAt": "2026-02-17T12:00:00.000Z"},
    {"id": "acc_1739055555555", "status": "INVALID", "resetAt": null}
  ]
}
```

| Поле | Описание |
|------|----------|
| `authenticated` | `true`, если хотя бы один аккаунт активен |
| `accounts[].status` | `OK` -- активен, `WAIT` -- rate limit, `INVALID` -- токен недействителен |
| `accounts[].resetAt` | Время, после которого аккаунт станет доступен (для WAIT) |

---

### POST /api/chats

Создаёт новый чат на серверах Qwen. Возвращает `chatId`, который можно использовать для ведения диалога с сохранением истории.

**Запрос:**

```bash
curl -X POST http://localhost:3264/api/chats \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Обсуждение архитектуры",
    "model": "qwen-max-latest"
  }'
```

**Ответ:**

```json
{
  "chatId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "success": true
}
```

---

### POST /api/files/upload

Загружает файл через сервер в Qwen OSS. Поддерживаемые типы: изображения (jpg, png, gif, webp, bmp), документы (pdf, doc, docx, txt) и прочие файлы. Максимальный размер -- 10 МБ (настраивается через `MAX_FILE_SIZE`).

**Запрос:**

```bash
curl -X POST http://localhost:3264/api/files/upload \
  -F "file=@/path/to/image.png"
```

**Ответ:**

```json
{
  "success": true,
  "file": {
    "name": "image.png",
    "url": "https://oss-bucket.aliyuncs.com/path/to/uploaded-image.png",
    "size": 245760,
    "type": "image/png"
  }
}
```

Полученный `url` можно использовать в запросе к `/api/chat` с составным сообщением (см. [Работа с изображениями](#работа-с-изображениями)).

---

### POST /api/files/getstsToken

Возвращает STS-токен для прямой загрузки файла в Qwen OSS из клиентского кода. Для большинства случаев удобнее использовать `/api/files/upload`.

**Запрос:**

```bash
curl -X POST http://localhost:3264/api/files/getstsToken \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "document.pdf",
    "filesize": 102400,
    "filetype": "document"
  }'
```

**Ответ:**

```json
{
  "access_key_id": "STS.xxxxx",
  "access_key_secret": "xxxxx",
  "security_token": "CAISxxxxx...",
  "region": "oss-cn-beijing",
  "bucketname": "qwen-upload-bucket",
  "file_path": "uploads/2026/02/16/document.pdf",
  "file_url": "https://qwen-upload-bucket.oss-cn-beijing.aliyuncs.com/uploads/...",
  "file_id": "file-abc123"
}
```

| Поле | Описание |
|------|----------|
| `filetype` | Тип файла: `image` (jpg, png, gif, webp, bmp), `document` (pdf, doc, docx, txt) или `file` |

---

## Работа с контекстом (API v2)

API использует серверную историю чатов Qwen. Каждый ответ содержит `chatId` и `parentId`, которые нужно передать в следующий запрос для продолжения диалога.

### Как это работает

```
1-й запрос (без chatId) ──> Ответ с chatId="abc", parentId="def"
                                    │
2-й запрос (chatId="abc", parentId="def") ──> Ответ с parentId="ghi"
                                                      │
3-й запрос (chatId="abc", parentId="ghi") ──> Ответ с parentId="jkl"
```

### Полный пример диалога

**Шаг 1 -- первое сообщение:**

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Что такое Docker?"}]
  }'
```

```json
{
  "id": "chatcmpl-1739012345678",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "Docker — это платформа для контейнеризации приложений..."}, "finish_reason": "stop"}],
  "chatId": "abc-123",
  "parentId": "def-456"
}
```

**Шаг 2 -- продолжение (модель помнит контекст):**

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Чем он отличается от виртуальных машин?"}],
    "chatId": "abc-123",
    "parentId": "def-456"
  }'
```

```json
{
  "id": "chatcmpl-1739012345679",
  "choices": [{"index": 0, "message": {"role": "assistant", "content": "Основные отличия Docker от виртуальных машин:\n1. Docker использует ядро хост-системы, а ВМ — полное гостевое ядро..."}, "finish_reason": "stop"}],
  "chatId": "abc-123",
  "parentId": "ghi-789"
}
```

**Шаг 3 -- ещё одно сообщение в том же диалоге:**

```bash
curl -X POST http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Покажи пример Dockerfile для Node.js"}],
    "chatId": "abc-123",
    "parentId": "ghi-789"
  }'
```

> Обратите внимание: `parentId` каждый раз берётся из **предыдущего** ответа, а `chatId` остаётся одним и тем же на протяжении всего диалога.

### Предварительное создание чата

Можно создать чат заранее через `POST /api/chats` и использовать полученный `chatId` с первого сообщения. Это удобно, если вы хотите задать имя чату.

---

## Работа с изображениями

Для анализа изображений используйте модели с поддержкой vision: `qwen3-vl-plus`, `qwen2.5-vl-32b-instruct`, `qvq-72b-preview-0310`, `qwen2.5-omni-7b`.

### Полный flow: загрузка + анализ

**Шаг 1 -- загрузить изображение:**

```bash
curl -X POST http://localhost:3264/api/files/upload \
  -F "file=@photo.jpg"
```

```json
{
  "success": true,
  "file": {
    "name": "photo.jpg",
    "url": "https://oss-bucket.aliyuncs.com/uploads/photo.jpg",
    "size": 184320,
    "type": "image/jpeg"
  }
}
```

**Шаг 2 -- отправить запрос с изображением:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      {"type": "text", "text": "Опиши, что изображено на фото. Какие объекты ты видишь?"},
      {"type": "image", "image": "https://oss-bucket.aliyuncs.com/uploads/photo.jpg"}
    ],
    "model": "qwen3-vl-plus"
  }'
```

### Формат составного сообщения

Поле `message` принимает массив объектов:

```json
[
  {"type": "text", "text": "Ваш вопрос к изображению"},
  {"type": "image", "image": "https://url-to-uploaded-image.com/image.png"}
]
```

---

## OpenAI SDK

Прокси полностью совместим с официальным OpenAI SDK для JavaScript/TypeScript. Достаточно указать `baseURL` и любой непустой `apiKey`.

### Простой запрос

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'any-string',  // обязательно для SDK, но не проверяется (если Authorization.txt пуст)
});

const response = await client.chat.completions.create({
    model: 'qwen-max-latest',
    messages: [
        { role: 'user', content: 'Напиши 5 интересных фактов о космосе' }
    ],
});

console.log(response.choices[0].message.content);
```

### Потоковый режим

```javascript
const stream = await client.chat.completions.create({
    model: 'qwen-max-latest',
    messages: [
        { role: 'user', content: 'Напиши короткую историю о роботе' }
    ],
    stream: true,
});

for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(text);
}
```

### С system message

```javascript
const response = await client.chat.completions.create({
    model: 'qwen-max-latest',
    messages: [
        { role: 'system', content: 'Ты -- опытный DevOps-инженер. Отвечай с примерами команд.' },
        { role: 'user', content: 'Как настроить CI/CD для Node.js проекта?' }
    ],
});
```

---

## Python (Альтернативная реализация)

Проект также включает полную реализацию на Python, которая работает независимо от Node.js.

### Установка и запуск
```bash
python -m venv venv
# Windows:
# venv\Scripts\activate
# Linux/macOS:
# source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
python main.py
```

### Возможности Python-версии
*   **main.py**: Полноценный прокси-сервер на FastAPI и менеджер аккаунтов.
*   **Интерактивное меню**: Тот же интерфейс, что и в Node.js версии.
*   **Playwright**: Автоматизация браузера для входа и получения токенов.
*   **OpenAI Compatibility**: Полная поддержка OpenAI SDK (`baseURL: http://localhost:3264/api`).

### Python примеры (как в Node.js)

В проект добавлены отдельные Python-примеры, аналогичные Node.js примерам:

- OpenAI SDK: `examples/python-sdk/`
- Прямые HTTP запросы: `examples/python-direct/`

Установка зависимостей для примеров:

```bash
python -m venv venv
# Windows:
# venv\Scripts\activate
# Linux/macOS:
# source venv/bin/activate
pip install -r requirements.txt
```

OpenAI SDK примеры:

```bash
python examples/python-sdk/simple.py
python examples/python-sdk/streaming.py
python examples/python-sdk/system_message.py
python examples/python-sdk/image_analysis.py
python examples/python-sdk/conversation.py
python examples/python-sdk/openai_compatibility.py
```

Direct API примеры:

```bash
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

> Перед запуском примеров убедитесь, что сервер уже запущен на `http://localhost:3264`.

---

## Доступные модели

### Основные модели

| Модель | Описание |
|--------|----------|
| `qwen3-max` | Флагманская модель Qwen 3 |
| `qwen3-vl-plus` | Vision-Language: работа с текстом и изображениями |
| `qwen3-coder-plus` | Специализация на коде |
| `qwen3-omni-flash` | Мультимодальная (текст, изображения, аудио) |
| `qwen-plus-2025-09-11` | Qwen Plus (актуальная версия) |
| `qwen3-235b-a22b` | Qwen 3 -- 235B параметров (MoE, 22B активных) |
| `qwen3-30b-a3b` | Qwen 3 -- 30B параметров (MoE, 3B активных) |
| `qwen3-coder-30b-a3b-instruct` | Кодерская модель -- 30B (MoE) |
| `qwen-max-latest` | Qwen 2.5 Max |
| `qwen-plus-2025-01-25` | Qwen 2.5 Plus |
| `qwq-32b` | QwQ -- модель для рассуждений (reasoning) |
| `qwen-turbo-2025-02-11` | Быстрая модель для простых задач |
| `qwen2.5-omni-7b` | Мультимодальная 7B |
| `qvq-72b-preview-0310` | QVQ -- vision + reasoning |
| `qwen2.5-vl-32b-instruct` | Vision-Language 32B |
| `qwen2.5-14b-instruct-1m` | 14B с контекстом 1M токенов |
| `qwen2.5-coder-32b-instruct` | Кодерская модель 32B |
| `qwen2.5-72b-instruct` | Qwen 2.5 -- 72B |

### Система алиасов

Запрашивать модели можно по любому из поддерживаемых имён -- сервер автоматически подставит каноническое:

| Вы запрашиваете | Используется |
|-----------------|-------------|
| `qwen-max` | `qwen3-max` |
| `qwen-vl-plus` | `qwen3-vl-plus` |
| `qwen3-coder` | `qwen3-coder-plus` |
| `qwq` | `qwq-32b` |
| `qwen-turbo` | `qwen-turbo-2025-02-11` |
| `qwen2.5-max` | `qwen-max-latest` |
| `qwen2.5-plus` | `qwen-plus-2025-01-25` |
| `qvq` | `qvq-72b-preview-0310` |
| `qwen3` | `qwen3-235b-a22b` |
| `qwen-plus` | `qwen-plus-2025-09-11` |

> Если запрошенная модель не найдена ни в списке, ни среди алиасов -- используется модель по умолчанию (`qwen-max-latest`, настраивается через `DEFAULT_MODEL`).

---

## Переменные окружения

Все настройки читаются из переменных окружения с фоллбэками на значения по умолчанию. Полный список задаётся в `src/config.js`.

### Сервер

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PORT` | `3264` | Порт HTTP-сервера |
| `HOST` | `0.0.0.0` | Адрес привязки |
| `DEFAULT_MODEL` | `qwen-max-latest` | Модель, используемая если не указана в запросе |
| `ALLOW_UNSCOPED_SESSION_CHAT_RESTORE` | `false` | Разрешить legacy-восстановление контекста по IP + User-Agent, даже без `conversation_id`/`chatId` |

### Режимы запуска

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `SKIP_ACCOUNT_MENU` | `false` | Пропустить интерактивное меню аккаунтов |
| `NON_INTERACTIVE` | `false` | Аналог `SKIP_ACCOUNT_MENU` |
| `CHROME_PATH` | *(авто)* | Путь к исполняемому файлу Chromium/Chrome |

### Таймауты

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PAGE_TIMEOUT` | `120000` (2 мин) | Таймаут загрузки страниц |
| `AUTH_TIMEOUT` | `120000` (2 мин) | Таймаут ожидания авторизации |
| `NAVIGATION_TIMEOUT` | `60000` (1 мин) | Таймаут навигации браузера |
| `RETRY_DELAY` | `2000` (2 сек) | Задержка между повторными попытками |
| `STREAMING_CHUNK_DELAY` | `20` (20 мс) | Задержка между SSE-чанками при streaming |

### Лимиты

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `PAGE_POOL_SIZE` | `3` | Размер пула страниц браузера |
| `MAX_FILE_SIZE` | `10485760` (10 МБ) | Максимальный размер загружаемого файла |
| `MAX_HISTORY_LENGTH` | `100` | Максимальное число записей в локальной истории |
| `MAX_RETRY_COUNT` | `3` | Максимальное число повторных попыток при ошибках |

### Логирование

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `LOG_LEVEL` | `info` | Уровень логирования (error, warn, info, debug) |
| `LOG_MAX_SIZE` | `5242880` (5 МБ) | Максимальный размер файла лога |
| `LOG_MAX_FILES` | `5` | Количество ротируемых файлов логов |

### Браузер

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `VIEWPORT_WIDTH` | `1920` | Ширина viewport браузера |
| `VIEWPORT_HEIGHT` | `1080` | Высота viewport браузера |
| `USER_AGENT` | Chrome 131 | User-Agent строка |

### Пути

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `SESSION_DIR` | `session` | Директория для хранения сессий и токенов |
| `UPLOADS_DIR` | `uploads` | Директория для временных файлов загрузки |
| `LOGS_DIR` | `logs` | Директория для файлов логов |

### API URLs (для продвинутых)

| Переменная | По умолчанию | Описание |
|-----------|-------------|----------|
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | Базовый URL Qwen |
| `CHAT_API_URL` | `{base}/api/v2/chat/completions` | URL API чата |
| `CREATE_CHAT_URL` | `{base}/api/v2/chats/new` | URL создания чата |
| `STS_TOKEN_API_URL` | `{base}/api/v1/files/getstsToken` | URL получения STS-токена |
| `AUTH_SIGNIN_URL` | `{base}/auth?action=signin` | URL страницы авторизации |

---

## Структура проекта

```
├── main.py                     # Python FastAPI реализация прокси + интерактивное меню
├── requirements.txt            # Python зависимости
├── index.js                    # Точка входа: Express-сервер, меню аккаунтов
├── package.json
├── Dockerfile
├── docker-compose.yml
│
├── src/
│   ├── config.js               # Центральный модуль конфигурации (env-переменные)
│   ├── AvailableModels.txt     # Список доступных моделей
│   ├── Authorization.txt       # API-ключи для авторизации запросов
│   │
│   ├── api/
│   │   ├── routes.js           # Определение REST-эндпоинтов
│   │   ├── chat.js             # Отправка сообщений к Qwen API, извлечение токенов
│   │   ├── chatHistory.js      # Локальная история чатов
│   │   ├── fileUpload.js       # Загрузка файлов в Qwen OSS
│   │   ├── modelMapping.js     # Маппинг алиасов моделей
│   │   └── tokenManager.js     # Управление токенами, ротация аккаунтов
│   │
│   ├── browser/
│   │   ├── browser.js          # Инициализация Puppeteer, управление контекстом
│   │   ├── auth.js             # Проверка авторизации в браузере
│   │   └── session.js          # Сохранение/загрузка сессий
│   │
│   ├── logger/
│   │   └── index.js            # Winston-логгер с ротацией файлов
│   │
│   └── utils/
│       ├── accountSetup.js     # Интерактивное управление аккаунтами
│       └── prompt.js           # Утилита для интерактивного ввода
│
├── scripts/
│   └── auth.js                 # CLI-скрипт авторизации (npm run auth)
│
├── examples/                   # Примеры использования API
│   ├── openai-sdk/             # Примеры с OpenAI SDK
│   ├── direct-api/             # Примеры с fetch/axios
│   ├── file-upload/            # Пример загрузки файлов
│   ├── python-sdk/             # Python примеры с OpenAI SDK
│   └── python-direct/          # Python примеры с httpx
│
├── session/                    # Данные сессий и аккаунтов (создаётся автоматически)
├── logs/                       # Файлы логов (создаётся автоматически)
└── uploads/                    # Временные файлы загрузки (создаётся автоматически)
```
