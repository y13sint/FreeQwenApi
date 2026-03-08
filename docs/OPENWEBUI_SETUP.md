# Настройка Open WebUI для работы с FreeQwenApi

## 1. Подключение к API

### Шаг 1: Администрирование
1. Откройте Open WebUI
2. Войдите как администратор
3. Перейдите в **Settings** → **Connections**

### Шаг 2: Добавление API эндпоинта
- **Base URL**: `http://host.docker.internal:3264/api` (для Docker)
  - Или: `http://localhost:3264/api` (для локального запуска)
- **API Key**: любой (если файл `Authorization.txt` пустой)

## 2. Настройка генерации изображений

### Шаг 1: Включение генерации
1. Перейдите в **Settings** → **Images**
2. Включите **Enable Image Generation**

### Шаг 2: Настройка параметров
- **Engine**: OpenAI Compatible
- **Base URL**: `http://host.docker.internal:3264/api`
- **API Key**: любой (если авторизация отключена)
- **Model**: `qwen-image-plus`

### Шаг 3: Проверка подключения
Нажмите **Test Connection** - должно показать успех.

## 3. Использование генерации изображений

### В чате:
1. Откройте любой чат
2. Нажмите на иконку 🎨 (Image Generation)
3. Введите запрос: *"Космическая станция на орбите Марса, реализм"*
4. Нажмите **Generate**

### Через команду:
```
/imagine космический корабль в стиле киберпанк
```

## 4. Доступные модели для чата

В Open WebUI будут доступны следующие модели:

### Qwen 3.5 (новые):
- `qwen3.5-plus` - Флагманская модель
- `qwen3.5-flash` - Быстрая легковесная
- `qwen3.5-397b-a17b` - Самая большая MoE
- `qwen3.5-122b-a10b` - Средняя MoE
- `qwen3.5-27b` - 27B параметров
- `qwen3.5-35b-a3b` - 35B MoE

### Qwen 3:
- `qwen3-max` - Флагманская
- `qwen3-plus` - Средняя
- `qwen3-235b-a22b` - 235B параметров
- `qwen3-30b-a3b` - 30B MoE

### Coder:
- `qwen3-coder-plus` - Для программирования
- `qwen2.5-coder-32b-instruct` - 32B для кода

### Визуальные:
- `qwen3-vl-plus` - Для анализа изображений
- `qvq-72b-preview-0310` - Визуальное понимание

## 5. Настройка для Docker

Если Open WebUI запущен в Docker, используйте:

```yaml
# docker-compose.yml для Open WebUI
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "3000:8080"
    environment:
      - OPENAI_API_BASE_URLS=http://host.docker.internal:3264/api
      - OPENAI_API_KEYS=dummy-key
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## 6. Проверка работы

### Тест чата:
```
1. Выберите модель: qwen3.5-flash
2. Сообщение: "Привет! Расскажи о себе"
3. Должен прийти ответ от Qwen
```

### Тест генерации изображений:
```
1. Перейдите в раздел Images
2. Prompt: "Красивый закат над горами"
3. Model: qwen-image-plus
4. Нажмите Generate
5. Должно сгенерироваться изображение
```

## 7. Возможные проблемы

### "Connection refused"
- Убедитесь, что FreeQwenApi запущен
- Проверьте порт (по умолчанию 3264)

### "API key required"
- Добавьте любой API ключ в настройках Open WebUI
- Или оставьте файл `Authorization.txt` пустым

### "Model not found"
- Обновите список моделей в Open WebUI
- Проверьте, что модель есть в `AvaibleModels.txt`

### Генерация изображений не работает
- Проверьте: `GET http://localhost:3264/api/images/status`
- Установите `DASHSCOPE_API_KEY` если не установлен

## 8. Команды Open WebUI

| Команда | Описание |
|---------|----------|
| `/imagine <prompt>` | Генерация изображения |
| `/model <name>` | Выбор модели |
| `/chat` | Новый чат |
| `/settings` | Настройки |
