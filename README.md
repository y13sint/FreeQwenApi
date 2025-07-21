# Qwen API Proxy 

> Короткая инструкция. Полное руководство см. в [docs/README.md](docs/README.md)

## TL;DR

```bash
# 1. Клонировать репозиторий
git clone https://github.com/y13sint/FreeQwenApi.git

# 2. Установить зависимости
npm install

# 3. Запустить прокси
npm start
```

Дальше откроется интерактивное меню добавления аккаунтов.

## Быстрый тест

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
     -d '{"message":"Привет, как дела?"}'
```

## Основное

- OpenAI-совместимый эндпоинт `/api/chat/completions`
- Поддержка собственных `chatId` и хранения контекста через `/api/chat`
- Работа с изображениями и файлами
- Мульти-аккаунт, автоматическая ротация токенов
- (Опционально) Авторизация через файл `src/Authorization.txt`
