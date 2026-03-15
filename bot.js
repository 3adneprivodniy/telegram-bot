require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const https = require('https');
const http = require('http');
const fs = require('fs');

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

// Персистентное хранилище новых пользователей
const SEEN_USERS_FILE = './seenUsers.json';
const loadSeenUsers = () => {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_USERS_FILE, 'utf8'))); }
  catch { return new Set(); }
};
const saveSeenUsers = (set) => {
  fs.writeFileSync(SEEN_USERS_FILE, JSON.stringify([...set]));
};
const seenUsers = loadSeenUsers();

// Персистентное хранилище последних промптов картинок
const IMAGE_PROMPTS_FILE = './lastImagePrompts.json';
const loadImagePrompts = () => {
  try {
    const data = JSON.parse(fs.readFileSync(IMAGE_PROMPTS_FILE, 'utf8'));
    return new Map(Object.entries(data));
  } catch { return new Map(); }
};
const saveImagePrompts = (map) => {
  fs.writeFileSync(IMAGE_PROMPTS_FILE, JSON.stringify(Object.fromEntries(map)));
};

// История чатов: chatId -> [{role, content}]
const chatHistory = new Map();
const chatTimers = new Map();
const lastImagePrompt = loadImagePrompts(); // последний промпт сгенерированной картинки
const MAX_HISTORY = 25; // максимум сообщений на чат
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
      lastImagePrompt.delete(chatId);
      saveImagePrompts(lastImagePrompt);
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

const isImageEditRequest = (text) => {
  const keywords = [
    'добавь', 'добавить', 'дорисуй', 'дорисовать', 'измени картинку', 'измени изображение',
    'поменяй картинку', 'поменяй изображение', 'на картинке добавь', 'на изображении добавь',
    'к картинке добавь', 'в картинку добавь', 'измени на картинке', 'убери с картинки',
    'add to image', 'edit image', 'modify image', 'change the image',
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

const imageEditProgressSteps = [
  '⏳ Понял, хочешь изменить картинку...',
  '🎨 Объединяю описание...',
  '🖼️ Перегенерирую изображение...',
];

const isRealTimeRequest = (text) => {
  const keywords = [
    'курс', 'доллар', 'евро', 'рубл', 'валют', 'биткоин', 'bitcoin', 'btc',
    'ethereum', 'eth', 'крипт', 'crypto', 'цена биткоин', 'стоимость биткоин',
  ];
  return keywords.some(k => text.toLowerCase().includes(k));
};

const fetchRealTimeData = async (text) => {
  const lower = text.toLowerCase();
  const isCrypto = ['биткоин', 'bitcoin', 'btc', 'ethereum', 'eth', 'крипт', 'crypto'].some(k => lower.includes(k));
  const isCurrency = ['курс', 'доллар', 'евро', 'рубл', 'валют'].some(k => lower.includes(k));

  const results = [];

  if (isCrypto) {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether&vs_currencies=usd,rub,eur');
      const data = await res.json();
      const btc = data.bitcoin;
      const eth = data.ethereum;
      results.push(
        `Актуальные цены криптовалют (CoinGecko):\n` +
        `Bitcoin (BTC): $${btc.usd.toLocaleString()} | ${btc.rub.toLocaleString()} ₽ | €${btc.eur.toLocaleString()}\n` +
        `Ethereum (ETH): $${eth.usd.toLocaleString()} | ${eth.rub.toLocaleString()} ₽ | €${eth.eur.toLocaleString()}`
      );
    } catch (e) { console.error('Crypto fetch error:', e.message); }
  }

  if (isCurrency) {
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=RUB,EUR,GBP,CNY,KZT');
      const data = await res.json();
      const r = data.rates;
      results.push(
        `Актуальные курсы валют (Frankfurter):\n` +
        `1 USD = ${r.RUB?.toFixed(2)} ₽ | ${r.EUR?.toFixed(4)} € | ${r.GBP?.toFixed(4)} £ | ${r.CNY?.toFixed(4)} ¥ | ${r.KZT?.toFixed(2)} ₸`
      );
    } catch (e) { console.error('Currency fetch error:', e.message); }
  }

  return results.length > 0 ? results.join('\n\n') : null;
};

const logRequest = (msg, type, content) => {
  const user = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'unknown';
  const time = new Date().toISOString();
  console.log(`[${time}] ${user} (${msg.chat.id}) [${type}]: ${content}`);
};

bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const caption = msg.caption || 'Что изображено на этом фото? Опиши подробно.';
  logRequest(msg, 'photo', caption);
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

  logRequest(msg, 'text', userText);
  resetInactivityTimer(chatId);
  const imageMode = isImageRequest(userText);
  const wantsEdit = !imageMode && isImageEditRequest(userText);
  const editMode = wantsEdit && lastImagePrompt.has(chatId);

  // Пользователь хочет редактировать, но картинки ещё нет
  if (wantsEdit && !lastImagePrompt.has(chatId)) {
    return bot.sendMessage(chatId, '🖼️ Сначала попроси меня нарисовать картинку, а потом я смогу что-то добавить на неё.');
  }

  const steps = imageMode ? imageProgressSteps : editMode ? imageEditProgressSteps : progressSteps;

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
    if (imageMode || editMode) {
      let prompt = userText;
      if (editMode) {
        const prevPrompt = lastImagePrompt.get(chatId);
        prompt = `${prevPrompt}. Дополнительно: ${userText}`;
      }

      // Генерация картинки через DALL-E
      const response = await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: '1024x1024',
      });

      clearInterval(progressInterval);
      const imageUrl = response.data[0].url;
      lastImagePrompt.set(chatId, prompt);
      saveImagePrompts(lastImagePrompt);

      await bot.deleteMessage(chatId, msgId);
      await bot.sendPhoto(chatId, imageUrl, { caption: '✅ Готово!' });

    } else {
      // Обычный текстовый ответ через Claude с историей
      let messageForClaude = userText;
      if (isRealTimeRequest(userText)) {
        const realTimeData = await fetchRealTimeData(userText);
        if (realTimeData) {
          messageForClaude = `${userText}\n\n[Актуальные данные на сегодня:\n${realTimeData}]`;
        }
      }

      addToHistory(chatId, 'user', messageForClaude);

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
  lastImagePrompt.delete(msg.chat.id);
  saveImagePrompts(lastImagePrompt);
  bot.sendMessage(msg.chat.id, '🗑️ История чата очищена.');
});

bot.onText(/\/end/, (msg) => {
  chatHistory.delete(msg.chat.id);
  lastImagePrompt.delete(msg.chat.id);
  saveImagePrompts(lastImagePrompt);
  bot.sendMessage(msg.chat.id, '👋 Conversation ended. Send a message to start a new one.');
});

const commandsText = (chatId) => {
  if (chatId === 7931160874) {
    return (
      'привет Дашуля💕 от твоего любимого\n' +
      'теперь ты можешь сложные вопросы на которые твой любимый не может ответить задавать их мне\n\n' +
      'вот команды которые тебе пригодится в использывание меня\n' +
      '/commands — показать команды\n' +
      '/end — закончить диалог\n' +
      '/clear — очистить историю чата\n\n' +
      'люблю тебя❤️ от @Nazarbbaev'
    );
  }
  return (
    '👋 Привет! Я ИИ-бот.\n\n' +
    'Вот что я умею:\n\n' +
    '💬 Задай любой вопрос — отвечу текстом\n' +
    '🎨 Напиши "нарисуй [описание]" — сгенерирую картинку\n' +
    '🖼️ Отправь фото или скриншот — расскажу что на нём\n' +
    '🧠 Помню контекст разговора (последние 25 сообщений)\n\n' +
    '📋 Команды:\n' +
    '/commands — показать это сообщение\n' +
    '/end — завершить разговор и очистить историю\n' +
    '/clear — очистить историю чата'
  );
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const isNew = !seenUsers.has(chatId);
  if (isNew) {
    seenUsers.add(chatId);
    saveSeenUsers(seenUsers);
    bot.sendMessage(chatId, commandsText(chatId));
  } else {
    bot.sendMessage(chatId, '👋 Привет! Просто задай вопрос или напиши "нарисуй [описание]".\nДля списка команд используй /commands.');
  }
});

bot.onText(/\/commands/, (msg) => {
  bot.sendMessage(msg.chat.id, commandsText(msg.chat.id));
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

// Регистрация команд в меню Telegram
bot.setMyCommands([
  { command: 'commands', description: 'Показать возможности и команды' },
  { command: 'end', description: 'Завершить разговор и очистить историю' },
  { command: 'clear', description: 'Очистить историю чата' },
]);

console.log('🤖 Бот запущен...');
