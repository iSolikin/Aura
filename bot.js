const express = require('express');
const path = require('path');
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ------------ Конфиг ------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('❌ BOT_TOKEN или SUPABASE_* не заданы в .env');
    process.exit(1);
}

// ------------ Supabase клиент ------------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------ Express ------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница (Web App)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health-check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ------------ Telegraf бот ------------
const bot = new Telegraf(BOT_TOKEN);

// Регистрация / старт
bot.start(async (ctx) => {
    const tgUser = ctx.from;

    try {
        // ищем юзера в БД
        const { data: existing, error: selectError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', tgUser.id)
            .maybeSingle();

        if (selectError) {
            console.error('Supabase select error:', selectError);
        }

        if (!existing) {
            const { error: insertError } = await supabase.from('users').insert({
                telegram_id: tgUser.id,
                username: tgUser.username || null
            });

            if (insertError) {
                console.error('Supabase insert user error:', insertError);
            }
        }

        await ctx.reply(
            'Привет! Это Aura — трекер сна и веса.\nНажми кнопку ниже, чтобы открыть мини-приложение 👇',
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

// Приём данных из WebApp через sendData
bot.on('web_app_data', async (ctx) => {
    try {
        const payload = JSON.parse(ctx.webAppData.data);
        console.log('Получены данные из WebApp:', payload);

        await ctx.reply(
            'Я получил твои данные из Aura:\n' +
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

// ------------ API для WebApp ------------

// Запись сна
app.post('/api/sleep', async (req, res) => {
    try {
        const { telegramId, date, hours, quality, notes } = req.body;

        if (!telegramId || !date || !hours) {
            return res.status(400).json({ error: 'telegramId, date и hours обязательны' });
        }

        // находим пользователя
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (userErr || !user) {
            return res.status(400).json({ error: 'user not found' });
        }

        const { data, error } = await supabase
            .from('sleep_logs')
            .upsert(
                {
                    user_id: user.id,
                    date,
                    hours_slept: hours,
                    quality_rating: quality || null,
                    notes: notes || null
                },
                { onConflict: 'user_id,date' }
            )
            .select();

        if (error) {
            console.error('supabase sleep upsert error:', error);
            return res.status(500).json({ error: 'db error' });
        }

        res.json({ ok: true, data });
    } catch (err) {
        console.error('/api/sleep error:', err);
        res.status(500).json({ error: 'server error' });
    }
});

// Запись веса
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

        if (userErr || !user) {
            return res.status(400).json({ error: 'user not found' });
        }

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

// Последние 7 дней для дашборда
app.get('/api/dashboard/:telegramId', async (req, res) => {
    try {
        const telegramId = req.params.telegramId;

        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (userErr || !user) {
            return res.status(400).json({ error: 'user not found' });
        }

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

        res.json({ ok: true, sleep, weight });
    } catch (err) {
        console.error('/api/dashboard error:', err);
        res.status(500).json({ error: 'server error' });
    }
});

// ------------ Запуск ------------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🌐 Express сервер запущен на порту ${PORT}`);
});

// запуск бота (для polling; на Vercel можно отключить и сделать webhooks)
bot.launch().then(() => {
    console.log('🤖 Telegram бот запущен');
});

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
