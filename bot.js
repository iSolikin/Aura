const express = require('express');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

// Когда пользователь нажимает /start
bot.start((ctx) => {
    ctx.reply('Привет! Нажми кнопку ниже, чтобы открыть приложение 👇', {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '📱 Открыть Mini App',
                        web_app: { url: process.env.WEBAPP_URL }
                    }
                ]
            ]
        }
    });
});

// Обработка данных от Web App
bot.on('web_app_data', (ctx) => {
    const data = JSON.parse(ctx.webAppData.data);
    console.log('Получены данные:', data);
    
    ctx.reply(`✅ Спасибо! Я получил твои данные:\n${JSON.stringify(data, null, 2)}`);
});

// API endpoint
app.post('/webhook', async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.send('ok');
    } catch (error) {
        console.error('Ошибка в вебхуке:', error);
        res.status(500).send('Error');
    }
});

// Отправка статики (HTML файл)
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Приложение доступно по адресу: ${process.env.WEBAPP_URL}`);
});

// Запуск бота (для локальной разработки)
bot.launch();
