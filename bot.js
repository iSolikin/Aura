const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ BOT_TOKEN или SUPABASE_* не заданы в .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function calculateSleepQuality(hours, sleepStart) {
  let quality = 5;
  if (hours >= 7 && hours <= 9) quality = 8;
  else if (hours >= 6 && hours < 7) quality = 6;
  else if (hours > 9 && hours <= 10) quality = 7;
  else if (hours <= 5) quality = 3;

  if (sleepStart) {
    const [h] = sleepStart.split(':').map(Number);
    if (h >= 1 && h < 6) quality = Math.max(1, quality - 2);
  }
  return Math.max(1, Math.min(10, quality));
}

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
    if (diffDays === streak) streak++;
    else break;
  }
  return streak;
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const tgUser = ctx.from;
  try {
    const { data: existing, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', tgUser.id)
      .maybeSingle();

    if (selectError) console.error('Supabase select error:', selectError);

    if (!existing) {
      const { error: insertError } = await supabase.from('users').insert({
        telegram_id: tgUser.id,
        username: tgUser.username || null
      });
      if (insertError) console.error('Supabase insert user error:', insertError);
    }

    await ctx.reply(
      'Привет! Это Aura — твой трекер сна и веса.\nНажми кнопку ниже, чтобы открыть приложение 👇',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Открыть Aura',
                web_app: {
                  url: process.env.WEBAPP_URL || 'https://aura-ten-lac.vercel.app'
                }
              }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error('start handler error:', err);
    await ctx.reply('Произошла ошибка при старте. Попробуй позже.');
  }
});

bot.on('web_app_data', async (ctx) => {
  try {
    const payload = JSON.parse(ctx.webAppData.data);
    console.log('Получены данные из WebApp:', payload);
    await ctx.reply(
      'Я получил твои данные:\n' +
        '```json\n' +
        JSON.stringify(payload, null, 2) +
        '\n```',
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('web_app_data parse error:', err);
    await ctx.reply('Не удалось обработать данные из приложения.');
  }
});

// sleep
app.post('/api/sleep', async (req, res) => {
  try {
    const { telegramId, date, sleepStart, sleepEnd, notes } = req.body;
    if (!telegramId || !date || !sleepStart || !sleepEnd) {
      return res.status(400).json({ error: 'telegramId, date, sleepStart и sleepEnd обязательны' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userErr || !user) return res.status(400).json({ error: 'user not found' });

    const [startH, startM] = sleepStart.split(':').map(Number);
    const [endH, endM] = sleepEnd.split(':').map(Number);
    let startMinutes = startH * 60 + startM;
    let endMinutes = endH * 60 + endM;
    if (endMinutes <= startMinutes) endMinutes += 24 * 60;

    const hoursSlept = parseFloat(((endMinutes - startMinutes) / 60).toFixed(1));
    const quality = calculateSleepQuality(hoursSlept, sleepStart);

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
          notes: notes || null
        },
        { onConflict: 'user_id,date' }
      )
      .select();

    if (error) {
      console.error('supabase sleep upsert error:', error);
      return res.status(500).json({ error: 'db error' });
    }

    res.json({
      ok: true,
      data,
      calculated: { hours: hoursSlept, quality }
    });
  } catch (err) {
    console.error('/api/sleep error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// weight
app.post('/api/weight', async (req, res) => {
  try {
    const { telegramId, date, weight, notes } = req.body;
    if (!telegramId || !date || !weight) {
      return res.status(400).json({ error: 'telegramId, date и weight обязательны' });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userErr || !user) return res.status(400).json({ error: 'user not found' });

    const { data, error } = await supabase
      .from('weight_logs')
      .upsert(
        {
          user_id: user.id,
          date,
          weight_kg: weight,
          notes: notes || null
        },
        { onConflict: 'user_id,date' }
      )
      .select();

    if (error) {
      console.error('supabase weight upsert error:', error);
      return res.status(500).json({ error: 'db error' });
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error('/api/weight error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// settings
app.post('/api/settings', async (req, res) => {
  try {
    const { telegramId, targetWeightKg, targetSleepHours } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId обязателен' });

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userErr || !user) return res.status(400).json({ error: 'user not found' });

    const updateData = {};
    if (targetWeightKg !== undefined) updateData.target_weight_kg = targetWeightKg;
    if (targetSleepHours !== undefined) updateData.target_sleep_hours = targetSleepHours;

    const { data, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', user.id)
      .select();

    if (error) {
      console.error('supabase settings update error:', error);
      return res.status(500).json({ error: 'db error' });
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error('/api/settings error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// dashboard 7 days
app.get('/api/dashboard/:telegramId', async (req, res) => {
  try {
    const telegramId = req.params.telegramId;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userErr || !user) return res.status(400).json({ error: 'user not found' });

    const { data: sleep, error: sleepErr } = await supabase
      .from('sleep_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
      .limit(7);

    const { data: weight, error: weightErr } = await supabase
      .from('weight_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false })
      .limit(7);

    if (sleepErr || weightErr) {
      console.error('dashboard errors:', sleepErr, weightErr);
      return res.status(500).json({ error: 'db error' });
    }

    res.json({
      ok: true,
      sleep,
      weight,
      user: {
        target_weight_kg: user.target_weight_kg,
        target_sleep_hours: user.target_sleep_hours
      }
    });
  } catch (err) {
    console.error('/api/dashboard error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

// streak
app.get('/api/streak/:telegramId', async (req, res) => {
  try {
    const telegramId = req.params.telegramId;

    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (userErr || !user) return res.status(400).json({ error: 'user not found' });

    const { data: sleepLogs, error: sleepErr } = await supabase
      .from('sleep_logs')
      .select('*')
      .eq('user_id', user.id)
      .order('date', { ascending: false });

    if (sleepErr) return res.status(500).json({ error: 'db error' });

    const streak = calculateStreak(sleepLogs || []);

    res.json({ ok: true, streak });
  } catch (err) {
    console.error('/api/streak error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Express сервер запущен на порту ${PORT}`);
});

bot.launch().then(() => {
  console.log('🤖 Telegram бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
