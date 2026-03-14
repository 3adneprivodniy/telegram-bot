const { spawn } = require('child_process');

function startBot() {
  console.log('🤖 Запускаю бота...');
  const bot = spawn('node', ['bot.js'], { stdio: 'inherit' });

  bot.on('close', (code) => {
    console.log(`⚠️ Бот упал (код ${code}). Перезапускаю через 3 секунды...`);
    setTimeout(startBot, 3000);
  });
}

startBot();
