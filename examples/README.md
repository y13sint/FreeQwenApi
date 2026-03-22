# Примеры использования FreeQwenApi

В этой директории собраны примеры использования API-прокси для Qwen AI.

## Установка и запуск

Установка зависимостей производится в корневой директории проекта:

```bash
# В корневой директории проекта
npm install
```

Перед запуском примеров убедитесь, что сервер FreeQwenApi запущен и доступен по адресу `http://localhost:3264`.

```bash
# Запуск сервера
npm start

# В отдельном терминале запустите примеры
npm run example:simple
npm run example:stream
# и т.д.
```

## Примеры с использованием OpenAI SDK

### 1. Простой запрос (не потоковый)

```bash
npm run example:simple
```

Демонстрирует отправку простого запроса к Qwen AI с использованием OpenAI SDK.

### 2. Потоковый запрос

```bash
npm run example:stream
```

Показывает, как получать ответ в потоковом режиме, где токены приходят по мере их генерации.

### 3. Запрос с системным сообщением

```bash
npm run example:system
```

Пример использования системного сообщения для задания роли и инструкций модели.

### 4. Анализ изображения

```bash
npm run example:image
```

Демонстрация отправки изображения для анализа моделью (требуется заменить URL изображения в примере).

### 5. Диалог с несколькими сообщениями

```bash
npm run example:conversation
```

Пример поддержания диалога из нескольких сообщений с сохранением контекста.

### 6. Совместимость с OpenAI API

```bash
npm run example:compatibility
```

Демонстрация полной совместимости с форматом API OpenAI.

## Примеры прямого использования API

### 1. Запрос с использованием fetch

```bash
npm run example:direct
```

Пример отправки прямого запроса к API без использования SDK, с использованием нативного fetch.

### 2. Запрос с использованием axios

```bash
npm run example:axios
```

Пример использования библиотеки axios для отправки запросов к API.

## Тесты генерации контента

### Тест всех типов генерации

```bash
npm run test:features
```

Тестирует все три режима: текстовый чат (t2t), генерацию изображений (t2i) и генерацию видео (t2v).

### Сравнение режимов polling для видео

```bash
npm run test:video-polling
```

Сравнивает server-side polling (сервер сам ждёт) и client-side polling (клиент поллит вручную).

> Подробная документация по генерации изображений и видео: [IMAGE_VIDEO_GENERATION_GUIDE.md](../IMAGE_VIDEO_GENERATION_GUIDE.md)

## Модификация примеров

Вы можете модифицировать примеры для своих нужд:

1. Изменяйте запросы и параметры в файлах примеров
2. Попробуйте различные модели (список доступен через `/api/models`)
3. Экспериментируйте с разными форматами запросов

## Примеры на Python

Python-реализация прокси запускает сервер с теми же OpenAI-совместимыми эндпоинтами:
- `POST /api/chat/completions`
- `POST /api/v1/chat/completions`
- `POST /api/chat`

Запуск:
```bash
pip install -r requirements.txt
python main.py
```

После запуска можно использовать те же curl/OpenAI SDK примеры из этого каталога, только направив `base_url` на `http://localhost:3264/api`.

### Python OpenAI SDK примеры

Установите зависимости:
```bash
pip install openai
```

Запуск:
```bash
python examples/python-sdk/simple.py
python examples/python-sdk/streaming.py
python examples/python-sdk/system_message.py
python examples/python-sdk/image_analysis.py
python examples/python-sdk/conversation.py
python examples/python-sdk/openai_compatibility.py
```

### Python direct API примеры (httpx)

Установите зависимости:
```bash
pip install httpx
```

Запуск:
```bash
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

## Работа с изображениями

Для примеров с изображениями необходимо:

1. Загрузить изображение в официальном веб-интерфейсе Qwen
2. Получить URL изображения из сетевых запросов (см. инструкцию в README.md основного проекта)
3. Заменить `IMAGE_URL` в примере на полученный URL

## Дополнительная информация

Подробная документация API доступна в README.md основного проекта. 
