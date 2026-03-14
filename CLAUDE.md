# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Telegram Bot D

Telegram-бот на Node.js с ИИ-обработкой сообщений: текстовые вопросы → Claude (Anthropic), запросы на картинки → DALL-E 3 (OpenAI).

## Команды

```bash
# Установить зависимости
npm install

# Запустить бота
node bot.js

# Остановить бота
pkill -f "node bot.js"
```

## Архитектура

Весь бот — один файл `bot.js`. Логика:

1. Входящее сообщение проверяется через `isImageRequest()` — список ключевых слов на русском/английском
2. Пока идёт запрос к API — бот редактирует одно и то же сообщение, показывая прогресс-шаги через `setInterval`
3. **Текст** → `anthropic.messages.create()` → ответ редактирует прогресс-сообщение
4. **Картинка** → `openai.images.generate()` → прогресс-сообщение удаляется, отправляется фото

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `TELEGRAM_TOKEN` | Токен бота от @BotFather |
| `ANTHROPIC_API_KEY` | Ключ Anthropic для Claude |
| `OPENAI_API_KEY` | Ключ OpenAI для DALL-E 3 |

## Модели

- Текст: `claude-sonnet-4-6`
- Картинки: `dall-e-3`, размер `1024x1024`
