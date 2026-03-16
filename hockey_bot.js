require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.HOCKEY_BOT_TOKEN, {
  polling: { autoStart: true, params: { timeout: 10 } },
});

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

  // Шукаємо JSON у __NEXT_DATA__ (Next.js SSR)
  let stats = null;
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const json = JSON.parse(nextData[1]);
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

  // Fallback: парсимо HTML таблицю ігор
  if (!stats) {
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

    // Останні відомі дані як резервний варіант
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

// Командні очки: W=2, OT/SO=1, L=0
const teamPointsFromScore = (score) => {
  if (!score || score === '—') return null;
  const s = score.toUpperCase();
  if (s.startsWith('W')) return 2;
  if (s.startsWith('OT') || s.includes('OTL') || s.includes('SO')) return 1;
  if (s.startsWith('L')) return 0;
  return null;
};

// /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🏒 *Хокейний бот — Назар Голімбовський #6*\n\n' +
    'Команди:\n' +
    '/stats — повна статистика\n' +
    '/goals — голи\n' +
    '/assists — асисти (голеві паси)\n' +
    '/pm — хвилини штрафу\n' +
    '/lastgame — остання гра + командні очки',
    { parse_mode: 'Markdown' }
  );
});

// /stats — повна статистика
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
      `⚡ Голи у більшості: *${s.ppg}*\n` +
      `⚡ Паси у більшості: *${s.ppa}*\n` +
      `🔥 Голи у меншості: *${s.shg}*\n` +
      `⏱️ Хв. штрафу (PIM): *${s.pim}*\n` +
      `📊 Очки/гра: *${s.avgPts}*\n\n` +
      `🔗 [Профіль на сайті](${PLAYER_URL})`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('Stats error:', e.message);
    await bot.editMessageText('❌ Не вдалося завантажити статистику.', {
      chat_id: chatId,
      message_id: loading.message_id,
    });
  }
});

// /goals — голи
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
      `Кидки у ворота: *${s.sog}* (точність ${s.shootPct}%)`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

// /assists — асисти
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
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

// /pm — штрафні хвилини
bot.onText(/\/pm/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '⏱️ Завантажую...');
  try {
    const s = await fetchPlayerStats();
    const avg = (parseFloat(s.pim) / parseFloat(s.gp) || 0).toFixed(2);
    const text =
      `⏱️ *Штрафні хвилини — ${s.name}* (#${s.number})\n\n` +
      `Хвилин штрафу (PIM): *${s.pim}* за ${s.gp} ігор\n` +
      `Середнє PIM/гра: *${avg}*`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await bot.editMessageText('❌ Помилка.', { chat_id: chatId, message_id: loading.message_id });
  }
});

// /lastgame — остання гра
bot.onText(/\/lastgame/, async (msg) => {
  const chatId = msg.chat.id;
  const loading = await bot.sendMessage(chatId, '🏒 Завантажую останній матч...');
  try {
    const s = await fetchPlayerStats();
    const last = s.games[0];
    if (!last) {
      return bot.editMessageText('❌ Даних про ігри не знайдено.', {
        chat_id: chatId,
        message_id: loading.message_id,
      });
    }
    const teamPts = teamPointsFromScore(last.score);
    const ptsEmoji = teamPts === 2 ? '🟢' : teamPts === 1 ? '🟡' : '🔴';
    const ptsLabel =
      teamPts === 2 ? '2 очки (Перемога)' :
      teamPts === 1 ? '1 очко (Овертайм/Буліт)' :
      teamPts === 0 ? '0 очків (Поразка)' : '—';
    const text =
      `🏒 *Остання гра — ${last.date}*\n` +
      `👥 Суперник: ${last.opponent}\n` +
      `🏆 Рахунок: *${last.score}*\n\n` +
      `📌 *Назар Голімбовський:*\n` +
      `🥅 Голи: *${last.g}*\n` +
      `🎯 Асисти: *${last.a}*\n` +
      `⭐ Очки: *${last.pts}*\n` +
      `⏱️ Штраф (PIM): *${last.pim}* хв\n\n` +
      `${ptsEmoji} *Командні очки за гру: ${ptsLabel}*`;
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loading.message_id,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error('Lastgame error:', e.message);
    await bot.editMessageText('❌ Не вдалося завантажити дані.', {
      chat_id: chatId,
      message_id: loading.message_id,
    });
  }
});

bot.setMyCommands([
  { command: 'stats', description: '📊 Повна статистика Назара' },
  { command: 'goals', description: '🥅 Голи' },
  { command: 'assists', description: '🎯 Голеві паси (асисти)' },
  { command: 'pm', description: '⏱️ Хвилини штрафу' },
  { command: 'lastgame', description: '🏒 Остання гра + командні очки' },
]);

bot.on('polling_error', (err) => console.error('Polling error:', err.message));

console.log('🏒 Хокейний бот запущено...');
