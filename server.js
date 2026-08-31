
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(bodyParser.json());

// كلمة السر للـ Webhook
const VERIFY_TOKEN = "hamza_webhook_123";

// التوكن الخاص بصفحتك
const PAGE_ACCESS_TOKEN = "EAAG5a8VWw5IBSQsr4ZBce4wv6ZAL8q5xGe0eHaVMZB0mp1KpdPOw42SAFcpUSGrEBsoMnG8BNuTjRK0ZAuKRKizmSZCwPIBZCH8XV0TZBMF6ztKQm2vFLnyqM0QMw8v65uNsSX5ZCrB0F5Felk9HP32lBKxqMLtdTkfLUUjMWqMQqzjLLX4QsIdmJzsxtlVPOsxoa9VU";

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
app.post('/webhook', async (req, res) => {
    try {
        let body = req.body;

        if (body.object === 'page') {
            for (const entry of body.entry) {
                let webhook_event = entry.messaging[0];
                let sender_psid = webhook_event.sender.id;

                if (webhook_event.message && webhook_event.message.text) {
                    console.log(`📩 استلام رسالة من ${sender_psid}، جاري جلب الفيديوهات...`);
                    await fetchAndSendVideos(sender_psid);
                } 
                else if (webhook_event.postback) {
                    let payload = webhook_event.postback.payload;
                    console.log(`🔘 تم الضغط على زر: ${payload}`);
                    
                    if (payload.startsWith('LOAD_MORE_')) {
                        // يمكنك لاحقاً تعديل هذا الجزء لدعم الصفحات في رابط البحث
                        await sendTextMessage(sender_psid, "ميزة المزيد قيد التحديث مع الرابط الجديد.");
                    } else {
                        await sendTextMessage(sender_psid, `تم اختيار الفيديو! جارٍ تجهيز الرابط للخطوة القادمة: \n${payload}`);
                    }
                }
            }
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error("⚠️ حدث خطأ داخلي أثناء معالجة الـ Webhook:");
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

// 3. دالة جلب الفيديوهات (Scraping) وإرسالها
async function fetchAndSendVideos(sender_psid) {
    try {
        // الرابط الجديد الذي اقترحته للبحث عن الجديد
        const targetUrl = `https://www.pornhub.com/video/search?search=new`;
        
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.pornhub.com/',
                'Cookie': 'age_verified=1; bs=1; accessAgeDisclaimerPH=1; platform=pc;' 
            }
        });

        const $ = cheerio.load(response.data);
        let elements = [];
        let videoElements = $('.pcVideoListItem').toArray();

        for (let i = 0; i < videoElements.length; i++) {
            if (elements.length >= 10) break; // سحب 10 بطاقات

            let element = videoElements[i];
            let title = $(element).find('.title a').text().trim();
            let link = $(element).find('.title a').attr('href');
            let imgUrl = $(element).find('img').attr('src') || $(element).find('img').attr('data-thumb_url') || $(element).find('img').attr('data-mediumthumb');

            if (title && link && link.includes('viewkey') && imgUrl && !imgUrl.includes('data:image')) {
                let fullLink = 'https://www.pornhub.com' + link;
                elements.push({
                    title: title.substring(0, 75) + "..",
                    image_url: imgUrl,
                    subtitle: "اضغط لتحميل هذا الفيديو",
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
            await sendCarouselMessage(sender_psid, elements);
        } else {
            await sendTextMessage(sender_psid, "لم أتمكن من العثور على فيديوهات، الموقع يقوم بحظر IP السيرفر الخاص بنا ويعرض محتوى فارغ أو إعلانات.");
        }

    } catch (error) {
        console.error("⚠️ حدث خطأ أثناء عملية السكرابنج أو تحليل الموقع:");
        console.error(error);
        await sendTextMessage(sender_psid, "حدث خطأ أثناء جلب الفيديوهات من الموقع.");
    }
}

// 4. دالة إرسال رسالة نصية عادية
async function sendTextMessage(sender_psid, text) {
    const requestBody = {
        recipient: { id: sender_psid },
        message: { text: text }
    };
    await callSendAPI(requestBody);
}

// 5. دالة إرسال القائمة (Carousel)
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

// 6. دالة التواصل مع API فيسبوك
async function callSendAPI(requestBody) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, requestBody);
        console.log("✅ تم إرسال الرد للمستخدم بنجاح!");
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
