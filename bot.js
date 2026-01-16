const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ============ VALIDATION ============
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ BOT_TOKEN или SUPABASE_* не заданы в .env');
  process.exit(1);
}

// ============ INIT ============
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = express();
const bot = new Telegraf(BOT_TOKEN);

// ============ MIDDLEWARE ============
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ STATIC ROUTES ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============ HELPERS ============

/**
 * Получить пользователя по telegram_id
 * @throws {Error} с message 'user_not_found' или 'db_error'
 */
async function getUserByTelegramId(telegramId) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (error) {
    console.error('❌ Supabase user select error:', error);
    throw new Error('db_error');
  }

  if (!user) {
    throw new Error('user_not_found');
  }

  return user;
}

/**
 * Единый обработчик 500 ошибок
 */
function sendServerError(res, label, err) {
  console.error(`❌ ${label}:`, err);
  return res.status(500).json({ error: 'server_error' });
}

/**
 * Рассчитать качество сна на основе часов и времени начала сна
 */
function calculateSleepQuality(hours, sleepStart) {
  let quality = 5;

  // Основной рассчёт по часам
  if (hours >= 7 && hours <= 9) {
    quality = 8;
  } else if (hours >= 6 && hours < 7) {
    quality = 6;
  } else if (hours > 9 && hours <= 10) {
    quality = 7;
  } else if (hours <= 5) {
    quality = 3;
  }

  // Штраф за поздний сон (1:00-6:00)
  if (sleepStart) {
    const [h] = sleepStart.split(':').map(Number);
    if (h >= 1 && h < 6) {
      quality = Math.max(1, quality - 2);
    }
  }

  return Math.max(1, Math.min(10, quality));
}

/**
 * Рассчитать стрик (количество подряд дней с логами сна)
 */
function calculateStreak(logs) {
  if (!logs || logs.length === 0) return 0;

  const sortedLogs = [...logs].sort((a, b) => new Date(b.date) - new Date(a.date));
  let streak = 0;
  let currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);

  for (const log of sortedLogs) {
    const logDate = new Date(log.date);
    logDate.setHours(0, 0, 0, 0);

    const diffDays = Math.floor((currentDate - logDate) / (1000 * 60 * 60 * 24));

    if (diffDays === streak) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Конвертировать время (hh:mm) в минуты
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// ============ BOT COMMANDS ============

bot.start(async (ctx) => {
  const tgUser = ctx.from;

  try {
    // Проверяем, есть ли уже пользователь
    const { data: existing, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', tgUser.id)
      .maybeSingle();

    if (selectError) {
      console.error('❌ Supabase select error:', selectError);
    }

    // Если нет — создаём
    if (!existing) {
      const { error: insertError } = await supabase.from('users').insert({
        telegram_id: tgUser.id,
        username: tgUser.username || null,
      });

      if (insertError) {
        console.error('❌ Supabase insert user error:', insertError);
      }
    }

    // Отправляем приветствие с кнопкой
    await ctx.reply(
      'Привет! 👋 Это Aura — твой трекер сна и веса.\n\nЯ помогу тебе отслеживать качество сна, вес и прогресс к целям. Нажми кнопку ниже, чтобы открыть приложение 👇',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📊 Открыть Aura',
                web_app: {
                  url: process.env.WEBAPP_URL || 'https://aura-ten-lac.vercel.app',
                },
              },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error('❌ /start handler error:', err);
    await ctx.reply('Произошла ошибка при старте. Попробуй позже.');
  }
});

// ============ API: SLEEP ============

app.post('/api/sleep', async (req, res) => {
  try {
    const { telegramId, date, sleepStart, sleepEnd, notes } = req.body;

    // Валидация входящих данных
    if (!telegramId || !date || !sleepStart || !sleepEnd) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(telegramId);
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Рассчитываем часы сна
    const startMinutes = timeToMinutes(sleepStart);
    let endMinutes = timeToMinutes(sleepEnd);

    // Если конец раньше начала — это на следующий день
    if (endMinutes <= startMinutes) {
      endMinutes += 24 * 60;
    }

    const hoursSlept = parseFloat(((endMinutes - startMinutes) / 60).toFixed(1));
    const quality = calculateSleepQuality(hoursSlept, sleepStart);

    // Сохраняем в БД
    const { data, error } = await supabase
      .from('sleep_logs')
      .upsert(
        {
          user_id: user.id,
          date,
          sleep_start: sleepStart,
          sleep_end: sleepEnd,
          hours_slept: hoursSlept,
          quality_rating: quality,
          notes: notes || null,
        },
        { onConflict: 'user_id,date' }
      )
      .select();

    if (error) {
      console.error('❌ Supabase sleep upsert error:', error);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({
      ok: true,
      data,
      calculated: {
        hours: hoursSlept,
        quality,
      },
    });
  } catch (err) {
    return sendServerError(res, '/api/sleep', err);
  }
});

// ============ API: WEIGHT ============

app.post('/api/weight', async (req, res) => {
  try {
    const { telegramId, date, weight, notes } = req.body;

    // Валидация входящих данных
    if (!telegramId || !date || weight === undefined || weight === null) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(telegramId);
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Сохраняем в БД
    const { data, error } = await supabase
      .from('weight_logs')
      .upsert(
        {
          user_id: user.id,
          date,
          weight_kg: parseFloat(weight),
          notes: notes || null,
        },
        { onConflict: 'user_id,date' }
      )
      .select();

    if (error) {
      console.error('❌ Supabase weight upsert error:', error);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({ ok: true, data });
  } catch (err) {
    return sendServerError(res, '/api/weight', err);
  }
});

// ============ API: DELETE WEIGHT ============

app.post('/api/weight/delete', async (req, res) => {
  try {
    const { telegramId, date } = req.body;

    // Валидация входящих данных
    if (!telegramId || !date) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(telegramId);
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Удаляем запись
    const { error } = await supabase
      .from('weight_logs')
      .delete()
      .eq('user_id', user.id)
      .eq('date', date);

    if (error) {
      console.error('❌ Supabase weight delete error:', error);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, '/api/weight/delete', err);
  }
});

// ============ API: DELETE SLEEP ============

app.post('/api/sleep/delete', async (req, res) => {
  try {
    const { telegramId, date } = req.body;

    // Валидация входящих данных
    if (!telegramId || !date) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(telegramId);
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Удаляем запись
    const { error } = await supabase
      .from('sleep_logs')
      .delete()
      .eq('user_id', user.id)
      .eq('date', date);

    if (error) {
      console.error('❌ Supabase sleep delete error:', error);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({ ok: true });
  } catch (err) {
    return sendServerError(res, '/api/sleep/delete', err);
  }
});

// ============ API: SETTINGS ============

app.post('/api/settings', async (req, res) => {
  try {
    const { telegramId, targetWeightKg, targetSleepHours } = req.body;

    // Валидация входящих данных
    if (!telegramId) {
      return res.status(400).json({ error: 'missing_fields' });
    }

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(telegramId);
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Формируем объект для обновления
    const updateData = {};
    if (targetWeightKg !== undefined) {
      updateData.target_weight_kg = targetWeightKg;
    }
    if (targetSleepHours !== undefined) {
      updateData.target_sleep_hours = targetSleepHours;
    }

    // Обновляем пользователя
    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', user.id)
      .select();

    if (error) {
      console.error('❌ Supabase settings update error:', error);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({ ok: true, data });
  } catch (err) {
    return sendServerError(res, '/api/settings', err);
  }
});

// ============ API: DASHBOARD ============

app.get('/api/dashboard/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(parseInt(telegramId, 10));
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Получаем последние 7 логов сна
    const { data: sleep, error: sleepErr } = await supabase
      .from('sleep_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
      .limit(7);

    // Получаем последние 7 логов веса
    const { data: weight, error: weightErr } = await supabase
      .from('weight_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
      .limit(7);

    if (sleepErr || weightErr) {
      console.error('❌ Dashboard errors:', sleepErr, weightErr);
      return res.status(500).json({ error: 'db_error' });
    }

    res.json({
      ok: true,
      sleep: sleep || [],
      weight: weight || [],
      user: {
        target_weight_kg: user.target_weight_kg,
        target_sleep_hours: user.target_sleep_hours,
      },
    });
  } catch (err) {
    return sendServerError(res, '/api/dashboard', err);
  }
});

// ============ API: STREAK ============

app.get('/api/streak/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;

    // Получаем пользователя
    let user;
    try {
      user = await getUserByTelegramId(parseInt(telegramId, 10));
    } catch (e) {
      if (e.message === 'user_not_found') {
        return res.status(404).json({ error: 'user_not_found' });
      }
      return res.status(500).json({ error: 'db_error' });
    }

    // Получаем все логи сна
    const { data: sleepLogs, error: sleepErr } = await supabase
      .from('sleep_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });

    if (sleepErr) {
      console.error('❌ Streak query error:', sleepErr);
      return res.status(500).json({ error: 'db_error' });
    }

    // Рассчитываем стрик
    const streak = calculateStreak(sleepLogs || []);

    res.json({ ok: true, streak });
  } catch (err) {
    return sendServerError(res, '/api/streak', err);
  }
});

// ============ SERVER START ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Express сервер запущен на порту ${PORT}`);
});

bot.launch().then(() => {
  console.log('🤖 Telegram бот запущен');
});

// Graceful shutdown
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  console.log('⚠️  Бот остановлен (SIGINT)');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  console.log('⚠️  Бот остановлен (SIGTERM)');
});