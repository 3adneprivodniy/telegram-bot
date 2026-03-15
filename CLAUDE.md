# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Telegram Bot

Node.js Telegram-бот с ИИ-обработкой сообщений: текст → Claude (Anthropic), картинки → DALL-E 3 (OpenAI), фото/скриншоты → Claude Vision, реал-тайм данные → внешние API.

## Команды

```bash
# Установить зависимости
npm install

# Запустить бота локально (только если Railway не запущен — иначе будут дублирующиеся ответы)
node bot.js

# Остановить локальный бот
pkill -f "node bot.js"

# Деплой — пуш в main, Railway деплоит автоматически
git push origin main
```

## Архитектура

Весь бот — один файл `bot.js`. Порядок обработки входящего текстового сообщения:

1. `isImageRequest()` → DALL-E 3 генерация, сохраняет промпт в `lastImagePrompt`
2. `isImageEditRequest()` + `lastImagePrompt.has(chatId)` → объединяет старый промпт с новым, перегенерирует через DALL-E 3
3. `isRealTimeRequest()` → `fetchRealTimeData()` подтягивает курсы/крипту/новости, добавляет в контекст Claude
4. Иначе → `anthropic.messages.create()` с историей чата

Фото (`bot.on('photo')`) — отдельный обработчик, всегда через Claude Vision, в историю не добавляется.

Прогресс-сообщение: одно сообщение отправляется сразу, затем редактируется через `setInterval`. Для картинок — удаляется перед отправкой фото.

## Персистентное хранилище

Два JSON-файла (в `.gitignore`, не коммитятся):
- `lastImagePrompts.json` — последний промпт картинки per chatId (нужен для редактирования картинок)
- `seenUsers.json` — множество chatId, которые уже видели `/start` (для first-time приветствия)

## Память чата

- `chatHistory: Map<chatId, messages[]>` — в памяти, сбрасывается при перезапуске
- `MAX_HISTORY = 25` — максимум сообщений на чат
- `INACTIVITY_TIMEOUT = 120_000` — автоочистка после 120 сек неактивности

## Реал-тайм данные

| Тип | API | Ключ |
|---|---|---|
| Курсы валют (USD/EUR/RUB/GBP/CNY/KZT) | frankfurter.app | не нужен |
| Крипта (BTC, ETH) | CoinGecko | не нужен |
| Новости | Google News RSS | не нужен |

Данные инжектируются в сообщение пользователя как `[Актуальные данные на сегодня: ...]` перед отправкой в Claude.

## Команды бота

| Команда | Действие |
|---|---|
| `/start` | Первый раз: полное приветствие. Повторно: короткий ответ |
| `/commands` | Список возможностей и команд |
| `/end` | Завершить разговор, очистить историю |
| `/clear` | Очистить историю чата |
| `/myid` | Показать свой chat_id |

chat_id `7931160874` — особый пользователь с персональным приветствием в `/start` и `/commands`.

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

Бот задеплоен на Railway (автозапуск). **Никогда не запускай локально одновременно с Railway** — два экземпляра с одним токеном вызывают дублирование ответов. SSH для GitHub настроен через `~/.ssh/config` с ключом `~/.ssh/github`.
