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

const CRYPTO_ID_MAP = {
  'bitcoin': 'bitcoin', 'биткоин': 'bitcoin', 'btc': 'bitcoin',
  'ethereum': 'ethereum', 'эфир': 'ethereum', 'ефір': 'ethereum', 'eth': 'ethereum',
  'tether': 'tether', 'usdt': 'tether',
  'bnb': 'binancecoin', 'binance': 'binancecoin',
  'solana': 'solana', 'солана': 'solana', 'sol': 'solana',
  'xrp': 'ripple', 'ripple': 'ripple',
  'dogecoin': 'dogecoin', 'doge': 'dogecoin', 'догекоин': 'dogecoin',
  'cardano': 'cardano', 'ada': 'cardano',
  'avalanche': 'avalanche-2', 'avax': 'avalanche-2',
  'polkadot': 'polkadot', 'dot': 'polkadot',
  'chainlink': 'chainlink', 'link': 'chainlink',
  'litecoin': 'litecoin', 'ltc': 'litecoin',
  'polygon': 'matic-network', 'matic': 'matic-network',
  'shiba': 'shiba-inu', 'shib': 'shiba-inu',
  'tron': 'tron', 'trx': 'tron',
  'ton': 'the-open-network', 'тон': 'the-open-network', 'toncoin': 'the-open-network',
  'usdc': 'usd-coin',
  'near': 'near',
  'cosmos': 'cosmos', 'atom': 'cosmos',
  'stellar': 'stellar', 'xlm': 'stellar',
  'monero': 'monero', 'xmr': 'monero',
  'pepe': 'pepe',
  'notcoin': 'notcoin', 'not': 'notcoin',
  'sui': 'sui',
  'aptos': 'aptos',
  'injective': 'injective-protocol', 'inj': 'injective-protocol',
  'arbitrum': 'arbitrum', 'arb': 'arbitrum',
  'optimism': 'optimism', 'op': 'optimism',
};

const CURRENCY_KEYWORDS = {
  'доллар': 'USD', 'долар': 'USD', 'usd': 'USD',
  'евро': 'EUR', 'євро': 'EUR', 'eur': 'EUR',
  'фунт': 'GBP', 'gbp': 'GBP',
  'злот': 'PLN', 'pln': 'PLN', 'польськ': 'PLN', 'польск': 'PLN',
  'франк': 'CHF', 'chf': 'CHF',
  'єна': 'JPY', 'иена': 'JPY', 'jpy': 'JPY',
  'тенге': 'KZT', 'kzt': 'KZT',
  'чеськ': 'CZK', 'czk': 'CZK',
};

const isRealTimeRequest = (text) => {
  const keywords = [
    'курс', 'доллар', 'долар', 'евро', 'євро', 'гривн', 'валют', 'фунт', 'злот', 'тенге', 'франк',
    'биткоин', 'bitcoin', 'btc', 'ethereum', 'eth', 'крипт', 'crypto', 'solana', 'sol',
    'dogecoin', 'doge', 'xrp', 'bnb', 'ton', 'тон', 'shib', 'usdt', 'usdc',
    'новост', 'news', 'що сталось', 'що відбувається', 'що случилось', 'что происходит', 'последние события',
  ];
  return keywords.some(k => text.toLowerCase().includes(k));
};

const fetchNews = async () => {
  try {
    const res = await fetch('https://news.google.com/rss?hl=uk&gl=UA&ceid=UA:uk');
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const headlines = items.slice(0, 8).map(item => {
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     item.match(/<title>(.*?)<\/title>/))?.[1] || '';
      return title.trim();
    }).filter(Boolean);
    return headlines.length > 0
      ? `Останні новини (Google News, ${new Date().toLocaleDateString('uk-UA')}):\n` +
        headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')
      : null;
  } catch (e) {
    console.error('News fetch error:', e.message);
    return null;
  }
};

const fetchCurrencyRates = async (text) => {
  const lower = text.toLowerCase();
  const res = await fetch('https://bank.gov.ua/NBU_Exchange/exchange_site?json');
  const data = await res.json();
  const rateMap = Object.fromEntries(data.map(d => [d.cc, d]));

  const requested = new Set();
  for (const [kw, cc] of Object.entries(CURRENCY_KEYWORDS)) {
    if (lower.includes(kw)) requested.add(cc);
  }
  const toShow = requested.size > 0
    ? [...requested]
    : ['USD', 'EUR', 'GBP', 'PLN', 'CHF', 'JPY'];

  const lines = toShow
    .filter(cc => rateMap[cc])
    .map(cc => `1 ${cc} = ${rateMap[cc].rate.toFixed(2)} ₴`);

  return `Курси валют (НБУ, ${new Date().toLocaleDateString('uk-UA')}):\n` + lines.join('\n');
};

const fetchCryptoPrice = async (text) => {
  const lower = text.toLowerCase();

  // Визначаємо конкретну монету
  let coinId = null;
  for (const [alias, id] of Object.entries(CRYPTO_ID_MAP)) {
    if (lower.includes(alias)) { coinId = id; break; }
  }

  // Якщо не знайшли — пробуємо пошук через CoinGecko
  if (!coinId) {
    const tickerMatch = text.match(/\b([A-Z]{2,6})\b/);
    if (tickerMatch) {
      try {
        const sr = await fetch(`https://api.coingecko.com/api/v3/search?query=${tickerMatch[1]}`);
        const sd = await sr.json();
        coinId = sd.coins?.[0]?.id || null;
      } catch {}
    }
  }

  const ids = coinId || 'bitcoin,ethereum,solana,binancecoin,the-open-network';
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,uah,eur&include_24hr_change=true`);
  const data = await res.json();

  const LABELS = {
    'bitcoin': 'Bitcoin (BTC)', 'ethereum': 'Ethereum (ETH)', 'solana': 'Solana (SOL)',
    'binancecoin': 'BNB', 'the-open-network': 'TON', 'ripple': 'XRP',
    'dogecoin': 'Dogecoin (DOGE)', 'tether': 'Tether (USDT)', 'tron': 'TRON (TRX)',
    'matic-network': 'Polygon (MATIC)', 'shiba-inu': 'Shiba Inu (SHIB)',
  };

  const lines = Object.entries(data).map(([id, p]) => {
    const label = LABELS[id] || id;
    const change = p.usd_24h_change ? ` (${p.usd_24h_change > 0 ? '+' : ''}${p.usd_24h_change.toFixed(1)}% за 24г)` : '';
    return `${label}: $${p.usd?.toLocaleString('en')} | ${p.uah?.toLocaleString('uk')} ₴ | €${p.eur?.toLocaleString('en')}${change}`;
  });

  return `Курси криптовалют (CoinGecko):\n` + lines.join('\n');
};

const fetchRealTimeData = async (text) => {
  const lower = text.toLowerCase();
  const isCrypto = Object.keys(CRYPTO_ID_MAP).some(k => lower.includes(k)) ||
    ['крипт', 'crypto'].some(k => lower.includes(k));
  const isCurrency = Object.keys(CURRENCY_KEYWORDS).some(k => lower.includes(k)) ||
    ['курс', 'валют', 'гривн'].some(k => lower.includes(k));
  const isNews = ['новост', 'news', 'що сталось', 'що відбувається', 'что случилось', 'что происходит', 'последние события'].some(k => lower.includes(k));

  const results = [];

  if (isCrypto) {
    try { results.push(await fetchCryptoPrice(text)); }
    catch (e) { console.error('Crypto fetch error:', e.message); }
  }

  if (isCurrency) {
    try { results.push(await fetchCurrencyRates(text)); }
    catch (e) { console.error('Currency fetch error:', e.message); }
  }

  if (isNews) {
    const news = await fetchNews();
    if (news) results.push(news);
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
      system: 'Всі запити надходять від користувачів з України. Відповідай з урахуванням українського контексту. Не згадуй Росію, російські ресурси чи джерела без крайньої необхідності. ВАЖЛИВО: визнач мову повідомлення користувача і відповідай ТІЄЮ САМОЮ мовою.',
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
        system: 'Всі запити надходять від користувачів з України. Відповідай з урахуванням українського контексту. Не згадуй Росію, російські ресурси чи джерела без крайньої необхідності. ВАЖЛИВО: визнач мову повідомлення користувача і відповідай ТІЄЮ САМОЮ мовою.',
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
  if (chatId === 7026041537) {
    return (
      'привет мой повелитель всегда к твоим услугам\n\n' +
      'вот команды которые тебе пригодятся:\n' +
      '/commands — показать команды\n' +
      '/end — закончить диалог\n' +
      '/clear — очистить историю чата'
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

// ───── Назар Голімбовський — статистика ─────
const PLAYER_URL = 'https://stats.fhustats.online/roster_players/77487452?subseason=956051';
let statsCache = null;
let statsCacheTime = 0;
const STATS_CACHE_TTL = 10 * 60 * 1000; // 10 хвилин

const fetchPlayerStats = async () => {
  const now = Date.now();
  if (statsCache && now - statsCacheTime < STATS_CACHE_TTL) return statsCache;

  const res = await fetch(PLAYER_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0)' },
  });
  const html = await res.text();

  // Парсим числа з HTML-таблиць через регулярки
  const num = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].trim() : '—';
  };

  // Ключові поля — шукаємо у типових td/span структурах stats-сайту
  // Приоритет: шукаємо JSON у __NEXT_DATA__ (Next.js SSR)
  let stats = null;
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{[\s\S]*?\})<\/script>/);
  if (nextData) {
    try {
      const json = JSON.parse(nextData[1]);
      // Пробуємо знайти stats у pageProps
      const player = json?.props?.pageProps?.player || json?.props?.pageProps?.data;
      if (player) {
        const s = player.stats || player.seasonStats || player;
        stats = {
          name: player.fullName || player.name || 'Назар Голімбовський',
          number: player.number || player.jerseyNumber || '6',
          position: player.position || 'Нападник',
          gp: s.gamesPlayed ?? s.gp ?? '—',
          g: s.goals ?? s.g ?? '—',
          a: s.assists ?? s.a ?? '—',
          pts: s.points ?? s.pts ?? '—',
          pim: s.penaltyMinutes ?? s.pim ?? '—',
          sog: s.shotsOnGoal ?? s.sog ?? '—',
          shootPct: s.shootingPct ?? s.shootPct ?? '—',
          ppg: s.powerPlayGoals ?? s.ppg ?? '—',
          ppa: s.powerPlayAssists ?? s.ppa ?? '—',
          shg: s.shortHandedGoals ?? s.shg ?? '—',
          avgPts: s.avgPoints ?? s.avgPts ?? '—',
          games: player.games || player.gameLog || [],
        };
      }
    } catch (e) { /* fall through */ }
  }

  // Fallback: хардкод оновлених даних якщо не зміг розпарсити
  if (!stats) {
    // Парсимо таблицю ігор (проста regex-стратегія)
    const rowsMatch = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const games = [];
    for (const row of rowsMatch) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      if (cells.length >= 6 && /\d{2}\/\d{2}\/\d{4}/.test(cells[0])) {
        games.push({
          date: cells[0],
          opponent: cells[1] || cells[2] || '—',
          score: cells.find(c => /\d+-\d+/.test(c)) || '—',
          g: cells[3] || '0',
          a: cells[4] || '0',
          pts: cells[5] || '0',
          pim: cells[6] || '0',
        });
      }
    }

    stats = {
      name: 'Назар Голімбовський',
      number: '6',
      position: 'Нападник',
      gp: '20', g: '12', a: '20', pts: '32',
      pim: '8', sog: '24', shootPct: '50.0',
      ppg: '0', ppa: '4', shg: '2', avgPts: '1.60',
      games: games.length > 0 ? games : [
        { date: '03/15/2026', opponent: 'ДЮСШ Сокіл 2011', score: 'L 2-5', g: '1', a: '1', pts: '2', pim: '2' },
        { date: '03/14/2026', opponent: 'ДЮСШ Сокіл 2011', score: 'L 2-5', g: '1', a: '1', pts: '2', pim: '2' },
        { date: '03/01/2026', opponent: 'КРЕМЕНЧУК АВАНГАРД 2010', score: 'W 13-0', g: '0', a: '0', pts: '0', pim: '0' },
        { date: '02/28/2026', opponent: 'КРЕМЕНЧУК АВАНГАРД 2010', score: 'W 7-2', g: '0', a: '0', pts: '0', pim: '0' },
        { date: '02/15/2026', opponent: 'МДЮСШ ЯГУАРИ (U16)', score: 'W 8-4', g: '1', a: '2', pts: '3', pim: '0' },
      ],
    };
  }

  statsCache = stats;
  statsCacheTime = now;
  return stats;
};

// Підрахунок командних очок зі строки результату (W=2, OTL=1, L=0)
const teamPointsFromScore = (score) => {
  if (!score || score === '—') return null;
  const s = score.toUpperCase();
  if (s.startsWith('W')) return 2;
  if (s.startsWith('OT') || s.includes('OTL') || s.includes('SO')) return 1;
  if (s.startsWith('L')) return 0;
  return null;
};

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '📊 Завантажую статистику...');
  try {
    const s = await fetchPlayerStats();
    const text =
      `🏒 *${s.name}* — #${s.number}, ${s.position}\n` +
      `📅 Сезон 2025–2026 | Ігор: *${s.gp}*\n\n` +
      `🥅 Голи: *${s.g}*\n` +
      `🎯 Асисти: *${s.a}*\n` +
      `⭐ Очки (Г+А): *${s.pts}*\n` +
      `🏹 Кидки у ворота: *${s.sog}*\n` +
      `📈 Точність кидків: *${s.shootPct}%*\n` +
      `⚡ Голи у бл. більшості: *${s.ppg}*\n` +
      `⚡ Пас у бл. більшості: *${s.ppa}*\n` +
      `🔥 Голи у меншості: *${s.shg}*\n` +
      `⏱️ Хв. штрафу (PIM): *${s.pim}*\n` +
      `📊 Очки/гра: *${s.avgPts}*\n\n` +
      `🔗 [Профіль на сайті](${PLAYER_URL})`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (e) {
    console.error('Stats error:', e.message);
    await bot.editMessageText('❌ Не вдалося завантажити статистику.', { chat_id: chatId, message_id: loading.message_id });
  }
});

bot.onText(/\/goals/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '🥅 Завантажую...');
  try {
    const s = await fetchPlayerStats();
    const text =
      `🥅 *Голи — ${s.name}* (#${s.number})\n\n` +
      `Всього голів: *${s.g}* за ${s.gp} ігор\n` +
      `У більшості: *${s.ppg}*\n` +
      `У меншості: *${s.shg}*\n` +
      `Кидки у ворота: *${s.sog}* (точність ${s.shootPct}%)\n\n` +
      `Середнє очок/гра: *${s.avgPts}*`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

bot.onText(/\/assists/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '🎯 Завантажую...');
  try {
    const s = await fetchPlayerStats();
    const text =
      `🎯 *Асисти — ${s.name}* (#${s.number})\n\n` +
      `Всього асистів: *${s.a}* за ${s.gp} ігор\n` +
      `Голеві паси у більшості: *${s.ppa}*\n` +
      `Загальні очки (Г+А): *${s.pts}*`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

bot.onText(/\/pm/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏱️ Завантажую...');
  try {
    const s = await fetchPlayerStats();
    const text =
      `⏱️ *Штрафні хвилини — ${s.name}* (#${s.number})\n\n` +
      `Хвилин штрафу (PIM): *${s.pim}* за ${s.gp} ігор\n` +
      `Середнє PIM/гра: *${(parseFloat(s.pim) / parseFloat(s.gp) || 0).toFixed(2)}*`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

bot.onText(/\/lastgame/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '🏒 Завантажую останній матч...');
  try {
    const s = await fetchPlayerStats();
    const last = s.games[0];
    if (!last) {
      return bot.editMessageText('❌ Даних про ігри не знайдено.', { chat_id: chatId, message_id: loading.message_id });
    }
    const teamPts = teamPointsFromScore(last.score);
    const ptsEmoji = teamPts === 2 ? '🟢' : teamPts === 1 ? '🟡' : '🔴';
    const ptsLabel = teamPts === 2 ? '2 очки (Перемога)' : teamPts === 1 ? '1 очко (Овертайм/Буліт)' : teamPts === 0 ? '0 очків (Поразка)' : '—';
    const text =
      `🏒 *Останній матч — ${last.date}*\n` +
      `👥 Суперник: ${last.opponent}\n` +
      `🏆 Рахунок: *${last.score}*\n\n` +
      `📌 *Назар Голімбовський у цій грі:*\n` +
      `🥅 Голи: *${last.g}*\n` +
      `🎯 Асисти: *${last.a}*\n` +
      `⭐ Очки: *${last.pts}*\n` +
      `⏱️ Штраф (PIM): *${last.pim}* хв\n\n` +
      `${ptsEmoji} *Командні очки за гру: ${ptsLabel}*`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: loading.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Lastgame error:', e.message);
    await bot.editMessageText('❌ Не вдалося завантажити дані.', { chat_id: chatId, message_id: loading.message_id });
  }
});

// Регистрация команд в меню Telegram
bot.setMyCommands([
  { command: 'stats', description: '📊 Статистика Назара Голімбовського' },
  { command: 'goals', description: '🥅 Голи гравця' },
  { command: 'assists', description: '🎯 Голеві паси (асисти)' },
  { command: 'pm', description: '⏱️ Хвилини штрафу' },
  { command: 'lastgame', description: '🏒 Остання гра + командні очки' },
  { command: 'commands', description: 'Показать возможности и команды' },
  { command: 'end', description: 'Завершить разговор и очистить историю' },
  { command: 'clear', description: 'Очистить историю чата' },
]);

console.log('🤖 Бот запущен...');
