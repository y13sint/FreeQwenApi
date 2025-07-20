# Qwen AI Proxy

Локальный HTTP-прокси, который эмулирует работу браузера на сайте Qwen AI и предоставляет привычный API (OpenAI-совместимый).
Полная документация ==> docs/README_FULL.md

---

## 1. Быстрый старт (2 минуты)

```bash
# ❶ Установка
npm install

# ❷ Запуск (Windows/Linux/macOS)
npm start     # или  start.bat на Windows
```


Прокси слушает `http://localhost:3264/api`.

---

## 2. Что умеет

| Возможность | Описание |
|-------------|----------|
| Chat API    | `POST /api/chat` — простой формат <br/>`POST /api/chat/completions` — OpenAI-совместимый |
| Файлы       | `POST /api/files/upload` — загружает изображения/документы и отдаёт URL |
| Мульти-аккаунты | Не ограничены лимитами одного токена: ротация, авто-бан, повторный логин |
| Чаты        | CRUD эндпоинты, автоматическое хранение истории (`session/history/`) |
| Streaming   | Полная поддержка SSE-потоков из OpenAI SDK |

---

## 3. Мини-пример (curl)

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Привет!",
    "model": "qwen-max-latest"
  }'
```

Ответ:

```json
{
  "chatId": "uuid",
  "choices": [{"message":{"content":"…"}}]
}
```

Следующий запрос — передай `chatId` для сохранения контекста.

---

## 4. Работа с файлами / изображениями

```bash
# Шаг 1: загрузить файл
FILE=$(curl -s -F "file=@image.jpg" http://localhost:3264/api/files/upload | jq -r .file.url)

# Шаг 2: спросить модель
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      {"type":"text","text":"Что на картинке?"},
      {"type":"image","image":"'$FILE'"}
    ],
    "model": "qwen2.5-vl-32b-instruct"
  }'
```

---

## 5. Использование с OpenAI SDK

```js
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: 'http://localhost:3264/api', apiKey: 'dummy' });

const stream = await openai.chat.completions.create({
  messages: [{ role:'user', content:'Привет!' }],
  model: 'qwen-max-latest',
  stream: true
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');
```

---

## 6. Полная справка API

### 6.1 Chat

> ⚠️ **Контекст**
>
> • `/api/chat` хранит историю сообщений на стороне прокси. Достаточно передавать **только новое сообщение** (и `chatId`), прокси сам добавит его в историю и отправит **полный контекст** в Qwen.
>
> • `/api/chat/completions` полностью совместим с OpenAI: **каждый запрос создаёт новый чат** в прокси, история **не сохраняется**. Если вам нужен контекст — отправляйте его сами в массиве `messages`.

```
POST /api/chat                # Простой формат (message)
POST /api/chat/completions    # OpenAI-совместимый (messages)
```

Поля: `message` *или* `messages`, `model`, `chatId`, `stream`.

### 6.2 Файлы

```
POST /api/files/upload        # multipart/form-data, поле file
```

Возвращает: `success`, `file.{url,name,size,type}`.

### 6.3 Чаты

```
POST   /api/chats             # создать
GET    /api/chats             # список
GET    /api/chats/:id         # история
PUT    /api/chats/:id/rename  # переименовать
DELETE /api/chats/:id         # удалить
POST   /api/chats/cleanup     # авто-удаление
```

### 6.4 Служебные

```
GET /api/models               # список моделей
GET /api/status               # статус авторизации (✅ / ❌)
```

---

## 7. Модели

Файл `src/AvaibleModels.txt` содержит **13** актуальных ID моделей. Для удобства настроен маппинг популярных alias → реальный ID (см. `src/api/modelMapping.js`).
Если модель не распознана — подставляется `qwen-max-latest`.

---

## 8. Мульти-аккаунты

1. Все токены лежат в `session/tokens.json`  
2. Каждый запрос берёт следующий валидный токен (round-robin).
3. 429 → токен ⏳ WAIT (в JSON записывается `resetAt`)  
   401 → токен ❌ INVALID (нужен повторный логин).
4. Нет валидных токенов → сервер выключается.

Команды меню позволяют добавить / перелогинить / удалить аккаунт.

---

## 9. Ограничения

1. Скорость ниже прямого API (из-за эмуляции браузера).  
2. Лимиты зависят от аккаунтов — нет «бесконечного» доступа.  
3. Возможны изменения сайта Qwen AI → потребуется обновление прокси.

---

© 2025, проект для исследовательских и образовательных целей. Используйте на свой страх и риск.
