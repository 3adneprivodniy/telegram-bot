# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Telegram Bot

Telegram-бот на Node.js с ИИ-обработкой сообщений: текстовые вопросы → Claude (Anthropic), запросы на картинки → DALL-E 3 (OpenAI), фото/скриншоты → Claude Vision.

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

1. **Фото** (`bot.on('photo')`) → скачивается как base64 → `anthropic.messages.create()` с vision
2. **Текст** (`bot.on('message')`) → проверяется через `isImageRequest()`:
   - Да → `openai.images.generate()` (DALL-E 3) → прогресс-сообщение удаляется, отправляется фото
   - Нет → `anthropic.messages.create()` с историей чата → ответ редактирует прогресс-сообщение
3. Пока идёт запрос — бот редактирует одно сообщение, показывая прогресс-шаги через `setInterval`

## Память чата

- `chatHistory: Map<chatId, messages[]>` — хранит историю в памяти (сбрасывается при перезапуске)
- `MAX_HISTORY = 10` — максимум сообщений на чат
- `INACTIVITY_TIMEOUT = 120_000` — автоматически очищает историю после 120 сек неактивности
- Фото **не добавляются** в историю чата (каждый раз отдельный запрос)

## Команды бота

| Команда | Действие |
|---|---|
| `/start` | Приветствие + список возможностей (особое для chat_id `7931160874`) |
| `/end` | Завершить разговор, очистить историю |
| `/clear` | Очистить историю чата |
| `/myid` | Показать свой chat_id |

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `TELEGRAM_TOKEN` | Токен бота от @BotFather |
| `ANTHROPIC_API_KEY` | Ключ Anthropic для Claude |
| `OPENAI_API_KEY` | Ключ OpenAI для DALL-E 3 |

## Модели

- Текст + Vision: `claude-sonnet-4-6`, `max_tokens: 1024`
- Картинки: `dall-e-3`, размер `1024x1024`

## Деплой

Бот задеплоен на Railway (автозапуск, работает без Mac). Переменные окружения настроены в Railway Variables.
