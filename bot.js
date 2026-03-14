require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const downloadImageAsBase64 = (url) => new Promise((resolve, reject) => {
  const client = url.startsWith('https') ? https : http;
  client.get(url, (res) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    res.on('error', reject);
  }).on('error', reject);
});

// История чатов: chatId -> [{role, content}]
const chatHistory = new Map();
const chatTimers = new Map();
const MAX_HISTORY = 10; // максимум сообщений на чат
const INACTIVITY_TIMEOUT = 120_000; // 120 секунд

const getHistory = (chatId) => chatHistory.get(chatId) || [];

const addToHistory = (chatId, role, content) => {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  chatHistory.set(chatId, history);
};

const resetInactivityTimer = (chatId) => {
  if (chatTimers.has(chatId)) clearTimeout(chatTimers.get(chatId));
  const timer = setTimeout(() => {
    if (chatHistory.has(chatId)) {
      chatHistory.delete(chatId);
      bot.sendMessage(chatId, '⏱️ Диалог завершён автоматически из-за неактивности.');
    }
    chatTimers.delete(chatId);
  }, INACTIVITY_TIMEOUT);
  chatTimers.set(chatId, timer);
};

const isImageRequest = (text) => {
  const keywords = [
    'нарисуй', 'сгенерируй картинку', 'создай картинку', 'создай изображение',
    'нарисуй картинку', 'сгенерируй изображение', 'сделай картинку', 'сделай изображение',
    'покажи картинку', 'генерируй картинку', 'картинку с', 'изображение с',
    'draw', 'generate image', 'create image', 'make image', 'make a picture',
  ];
  return keywords.some(k => text.toLowerCase().includes(k));
};

const progressSteps = [
  '⏳ Получил твой вопрос...',
  '🔍 Анализирую запрос...',
  '🧠 ИИ думает над ответом...',
  '✍️ Формирую ответ...',
];

const imageProgressSteps = [
  '⏳ Получил запрос на картинку...',
  '🎨 Готовлю описание для генерации...',
  '🖼️ Генерирую изображение...',
];

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || 'Что изображено на этом фото? Опиши подробно.';
  resetInactivityTimer(chatId);

  const progressMsg = await bot.sendMessage(chatId, '⏳ Получил фото...');
  const msgId = progressMsg.message_id;

  const visionSteps = ['🔍 Анализирую изображение...', '🧠 Claude смотрит на фото...', '✍️ Формирую ответ...'];
  let stepIndex = 0;
  const progressInterval = setInterval(async () => {
    if (stepIndex < visionSteps.length) {
      try {
        await bot.editMessageText(visionSteps[stepIndex], { chat_id: chatId, message_id: msgId });
        stepIndex++;
      } catch (e) {}
    }
  }, 1500);

  try {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const fileLink = await bot.getFileLink(fileId);
    const base64 = await downloadImageAsBase64(String(fileLink));

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: caption },
        ],
      }],
    });

    clearInterval(progressInterval);
    await bot.editMessageText(`✅ Готово!\n\n${response.content[0].text}`, {
      chat_id: chatId,
      message_id: msgId,
    });
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Ошибка анализа фото:', error.message);
    await bot.editMessageText('❌ Ошибка при анализе фото. Попробуй ещё раз.', {
      chat_id: chatId,
      message_id: msgId,
    });
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userText = msg.text;

  if (!userText || userText.startsWith('/')) return;

  resetInactivityTimer(chatId);
  const imageMode = isImageRequest(userText);
  const steps = imageMode ? imageProgressSteps : progressSteps;

  const progressMsg = await bot.sendMessage(chatId, steps[0]);
  const msgId = progressMsg.message_id;

  let stepIndex = 1;
  const progressInterval = setInterval(async () => {
    if (stepIndex < steps.length) {
      try {
        await bot.editMessageText(steps[stepIndex], { chat_id: chatId, message_id: msgId });
        stepIndex++;
      } catch (e) {}
    }
  }, 1500);

  try {
    if (imageMode) {
      // Генерация картинки через DALL-E
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt: userText,
        n: 1,
        size: '1024x1024',
      });

      clearInterval(progressInterval);
      const imageUrl = response.data[0].url;

      await bot.deleteMessage(chatId, msgId);
      await bot.sendPhoto(chatId, imageUrl, { caption: '✅ Готово!' });

    } else {
      // Обычный текстовый ответ через Claude с историей
      addToHistory(chatId, 'user', userText);

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: getHistory(chatId),
      });

      clearInterval(progressInterval);
      const answer = response.content[0].text;
      addToHistory(chatId, 'assistant', answer);

      await bot.editMessageText(`✅ Готово!\n\n${answer}`, {
        chat_id: chatId,
        message_id: msgId,
      });
    }
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Ошибка:', error.message);
    await bot.editMessageText('❌ Ошибка при обработке запроса. Попробуй ещё раз.', {
      chat_id: chatId,
      message_id: msgId,
    });
  }
});

bot.onText(/\/myid/, (msg) => {
  bot.sendMessage(msg.chat.id, `🪪 Твой chat_id: ${msg.chat.id}`);
});

bot.onText(/\/clear/, (msg) => {
  chatHistory.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🗑️ История чата очищена.');
});

bot.onText(/\/end/, (msg) => {
  chatHistory.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '👋 Conversation ended. Send a message to start a new one.');
});

bot.onText(/\/start/, (msg) => {
  if (msg.chat.id === 7931160874) {
    bot.sendMessage(
      msg.chat.id,
      'привет Дашуля💕 от твоего любимого\n' +
      'теперь ты можешь сложные вопросы на которые твой любимый не может ответить задавать их мне\n\n' +
      'вот команды которые тебе пригодится в использывание меня\n' +
      '/start начать диалог\n' +
      '/end закончить диалог\n' +
      '/clear очистить историю чата\n\n' +
      'люблю тебя❤️ от @Nazarbbaev'
    );
    return;
  }

  bot.sendMessage(
    msg.chat.id,
    '👋 Привет! Я ИИ-бот.\n\n' +
    'Вот что я умею:\n\n' +
    '💬 Задай любой вопрос — отвечу текстом\n' +
    '🎨 Напиши "нарисуй [описание]" — сгенерирую картинку\n' +
    '🖼️ Отправь фото или скриншот — расскажу что на нём\n' +
    '🧠 Помню контекст разговора (последние 10 сообщений)\n\n' +
    '📋 Команды:\n' +
    '/start — показать это сообщение\n' +
    '/end — завершить разговор и очистить историю\n' +
    '/clear — очистить историю чата'
  );
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// Регистрация команд в меню Telegram
bot.setMyCommands([
  { command: 'start', description: 'Показать возможности бота' },
  { command: 'end', description: 'Завершить разговор и очистить историю' },
  { command: 'clear', description: 'Очистить историю чата' },
]);

console.log('🤖 Бот запущен...');
