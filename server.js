const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const youtubedl = require('youtube-dl-exec');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// كلمة السر للـ Webhook
const VERIFY_TOKEN = "hamza_webhook_123";

// التوكن الخاص بصفحتك
const PAGE_ACCESS_TOKEN = "EAAG5a8VWw5IBSQsr4ZBce4wv6ZAL8q5xGe0eHaVMZB0mp1KpdPOw42SAFcpUSGrEBsoMnG8BNuTjRK0ZAuKRKizmSZCwPIBZCH8XV0TZBMF6ztKQm2vFLnyqM0QMw8v65uNsSX5ZCrB0F5Felk9HP32lBKxqMLtdTkfLUUjMWqMQqzjLLX4QsIdmJzsxtlVPOsxoa9VU";

// مفتاح ScraperAPI الخاص بك
const SCRAPER_API_KEY = "e52e3ecb8172c130934a150b2e7c5f22";

// 1. مسار التحقق (GET)
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.error("❌ فشل التحقق: التوكن غير متطابق");
            res.sendStatus(403);
        }
    }
});

// 2. مسار استقبال الرسائل (POST)
app.post('/webhook', (req, res) => {
    let body = req.body;

    if (body.object === 'page') {
        // إرسال الرد فوراً لفيسبوك لتجنب إعادة إرسال الرسالة
        res.status(200).send('EVENT_RECEIVED');

        body.entry.forEach(async function(entry) {
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;

            try {
                if (webhook_event.message && webhook_event.message.text) {
                    console.log(`📩 استلام رسالة من ${sender_psid}، جاري جلب فيديوهات XVideos...`);
                    await fetchAndSendVideos(sender_psid, 1);
                } 
                else if (webhook_event.postback) {
                    let payload = webhook_event.postback.payload;
                    console.log(`🔘 تم الضغط على زر: ${payload}`);
                    
                    if (payload.startsWith('LOAD_MORE_')) {
                        let nextPage = parseInt(payload.split('_')[2]);
                        await fetchAndSendVideos(sender_psid, nextPage);
                    } else {
                        await downloadAndSendVideo(sender_psid, payload);
                    }
                }
            } catch (error) {
                console.error("⚠️ حدث خطأ داخلي أثناء معالجة الحدث:");
                console.error(error);
            }
        });
    } else {
        res.sendStatus(404);
    }
});

// 3. دالة جلب الفيديوهات من XVideos
async function fetchAndSendVideos(sender_psid, page = 1) {
    try {
        // حل المشكلة: الصفحة الأولى هي الرابط الرئيسي، وما بعدها يأخذ أرقاماً
        let targetUrl = page === 1 ? 'https://www.xvideos.com/' : `https://www.xvideos.com/new/${page - 1}/`;
        
        // نستخدم ScraperAPI لجلب الـ HTML
        const scraperApiUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
        
        const response = await axios.get(scraperApiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
            }
        });

        const $ = cheerio.load(response.data);
        let elements = [];
        let videoElements = $('.thumb-block').toArray(); 

        for (let i = 0; i < videoElements.length; i++) {
            if (elements.length >= 9) break; 

            let element = videoElements[i];
            let title = $(element).find('.title a').attr('title') || $(element).find('.title a').text().trim();
            let link = $(element).find('.title a').attr('href');
            let imgUrl = $(element).find('.thumb img').attr('data-src') || $(element).find('.thumb img').attr('src');
            let duration = $(element).find('.duration').text().trim();

            if (title && link && imgUrl) {
                let fullLink = link.startsWith('http') ? link : 'https://www.xvideos.com' + link;
                let subtitleText = "اضغط لتحميل هذا الفيديو";
                if (duration) subtitleText = `المدة: ${duration} ⏱️ | ` + subtitleText;

                elements.push({
                    title: title.substring(0, 75) + "..",
                    image_url: imgUrl,
                    subtitle: subtitleText,
                    buttons: [
                        {
                            type: "postback",
                            title: "📥 اختيار للتحميل",
                            payload: fullLink
                        }
                    ]
                });
            }
        }

        if (elements.length > 0) {
            let placeholderImage = elements[0].image_url; 
            elements.push({
                title: "المزيد من الفيديوهات 🔄",
                image_url: placeholderImage,
                subtitle: `الانتقال إلى الصفحة ${page + 1}`,
                buttons: [
                    {
                        type: "postback",
                        title: "عرض المزيد ➡️",
                        payload: `LOAD_MORE_${page + 1}`
                    }
                ]
            });

            await sendCarouselMessage(sender_psid, elements);
        } else {
            await sendTextMessage(sender_psid, "لم أتمكن من العثور على فيديوهات في هذه الصفحة.");
        }

    } catch (error) {
        console.error("⚠️ حدث خطأ أثناء عملية السكرابنج أو التحليل:");
        console.error(error);
        await sendTextMessage(sender_psid, "حدث خطأ أثناء جلب الفيديوهات من الموقع.");
    }
}

// 4. دالة استخراج وتحميل وإرسال الفيديو
async function downloadAndSendVideo(sender_psid, videoUrl) {
    let filePath = '';
    try {
        await sendTextMessage(sender_psid, "⏳ جاري تحميل الفيديو في السيرفر، يرجى الانتظار...");

        filePath = path.join('/tmp', `video_${Date.now()}.mp4`);
        
        // yt-dlp يتصل مباشرة بسيرفرات XVideos بدون بروكسي
        await youtubedl(videoUrl, {
            format: 'worst[ext=mp4]/worst', // أقل جودة لتجنب تجاوز 25MB
            noCheckCertificate: true,
            output: filePath
        });

        await sendTextMessage(sender_psid, "🚀 اكتمل التحميل! جاري رفعه إلى ماسنجر الآن...");

        const form = new FormData();
        form.append('recipient', JSON.stringify({ id: sender_psid }));
        form.append('message', JSON.stringify({
            attachment: {
                type: 'video',
                payload: { is_reusable: false }
            }
        }));
        form.append('filedata', fs.createReadStream(filePath));

        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, form, {
            headers: form.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        console.log("✅ تم إرسال الفيديو للمستخدم بنجاح!");

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    } catch (error) {
        console.error("⚠️ حدث خطأ أثناء تحميل أو إرسال الفيديو:");
        console.error(error);
        if (error.response && error.response.data) {
            console.error("تفاصيل رد فيسبوك: ", JSON.stringify(error.response.data, null, 2));
        }
        
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

        await sendTextMessage(sender_psid, "❌ حدث خطأ أثناء التحميل. يرجى المحاولة مرة أخرى.");
    }
}

// 5. دالة إرسال رسالة نصية عادية
async function sendTextMessage(sender_psid, text) {
    const requestBody = {
        recipient: { id: sender_psid },
        message: { text: text }
    };
    await callSendAPI(requestBody);
}

// 6. دالة إرسال القائمة (Carousel)
async function sendCarouselMessage(sender_psid, elements) {
    const requestBody = {
        recipient: { id: sender_psid },
        message: {
            attachment: {
                type: "template",
                payload: {
                    template_type: "generic",
                    elements: elements
                }
            }
        }
    };
    await callSendAPI(requestBody);
}

// 7. دالة التواصل مع API فيسبوك
async function callSendAPI(requestBody) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, requestBody);
    } catch (error) {
        console.error("⚠️ فشل إرسال الرد إلى فيسبوك. الخطأ الحقيقي:");
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error);
        }
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`في إعدادات فيسبوك، استخدم التوكن التالي للتحقق: ${VERIFY_TOKEN}`);
});
