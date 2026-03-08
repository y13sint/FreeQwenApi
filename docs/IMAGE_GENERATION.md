# Настройка генерации изображений

## Получение API ключа DashScope777

1. Зарегистрируйтесь на платформе Alibaba Cloud DashScope:
   - Международный: https://dashscope.console.aliyun.com/
   - Китай: https://dashscope.console.aliyun.com/

2. Создайте API ключ в разделе "API Keys"

3. Установите переменную окружения:

### Windows (cmd):
```cmd
setx DASHSCOPE_API_KEY "ваш_api_ключ"
```

### Windows (PowerShell):
```powershell
[System.Environment]::SetEnvironmentVariable('DASHSCOPE_API_KEY', 'ваш_api_ключ', 'User')
```

### Linux/Mac:
```bash
export DASHSCOPE_API_KEY="ваш_api_ключ"
```

### В Docker Compose:
Добавьте в `docker-compose.yml`:
```yaml
environment:
  - DASHSCOPE_API_KEY=ваш_api_ключ
```

## Доступные модели

| Модель | Описание |
|--------|----------|
| `qwen-image-max` | Флагманская модель для сложных сцен с текстом |
| `qwen-image-plus` | Универсальная модель (по умолчанию) |
| `qwen-image` | Базовая модель |
| `wan2.6-t2i` | Реалистичные сцены и фотография |
| `wan2.5-t2i-preview` | Быстрая генерация реалистичных изображений |
| `wan2.2-t2i-flash` | Самая быстрая модель с кастомным разрешением |

## Примеры использования

### Через cURL:
```bash
curl -X POST http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Красивый закат над горами в стиле аниме",
    "model": "qwen-image-plus",
    "n": 1,
    "size": "1024x1024"
  }'
```

### Через OpenAI SDK:
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.images.generate({
  model: 'qwen-image-plus',
  prompt: 'Космическая станция на орбите Марса',
  n: 1,
  size: '1024x1024'
});

console.log(response.data[0].url);
```

### Через Open WebUI:
1. Откройте настройки Open WebUI
2. Перейдите в раздел "Images"
3. Включите генерацию изображений
4. Укажите:
   - Base URL: `http://localhost:3264/api`
   - API Key: любой (если авторизация отключена)
   - Model: `qwen-image-plus`

## Проверка статуса API

```bash
curl http://localhost:3264/api/images/status
```

Ответ:
```json
{
  "available": true,
  "apiKeyConfigured": true,
  "message": "API генерации изображений доступен"
}
```

## Получение списка моделей

```bash
curl http://localhost:3264/api/images/models
```

## Поддерживаемые размеры

- `512x512`
- `768x768`
- `960x960`
- `1024x1024` (по умолчанию)
- `1024x1792` (портрет)
- `1792x1024` (ландшафт)

## Примечания

- Wan модели (`wan2.*`) используют только асинхронный режим с опросом статуса
- Qwen Image модели поддерживают как синхронный, так и асинхронный режим
- Максимальное количество генераций за один запрос: 4
- Время генерации: обычно 5-30 секунд в зависимости от модели и размера
