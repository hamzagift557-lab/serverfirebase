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
                let sender_psid = webhook_event.sender.id; // آيدي الشخص الذي أرسل الرسالة

                // إذا كانت رسالة نصية عادية (أي رسالة سترسلها ستشغل البوت)
                if (webhook_event.message && webhook_event.message.text) {
                    console.log(`📩 استلام رسالة من ${sender_psid}، جاري جلب الفيديوهات...`);
                    await fetchAndSendVideos(sender_psid);
                } 
                // إذا قام المستخدم بالضغط على زر "تحميل هذا الفيديو"
                else if (webhook_event.postback) {
                    let payload = webhook_event.postback.payload; // الرابط الذي خزنناه في الزر
                    console.log(`🔘 تم الضغط على زر لفيديو: ${payload}`);
                    
                    // الخطوة القادمة ستكون هنا (معالجة الرابط وتحميل الفيديو)
                    await sendTextMessage(sender_psid, `تم اختيار الفيديو! جارٍ تجهيز الرابط للخطوة القادمة: \n${payload}`);
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
        // نستخدم User-Agent وهمي لكي لا يحظرنا الموقع ظناً أننا روبوت
        const targetUrl = 'https://www.pornhub.com/';
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        let elements = [];

        // استخراج العناصر بناءً على كلاسات الموقع (قد تتغير وتحتاج لتحديث مستقبلاً)
        // يبحث هذا الكود عن قائمة الفيديوهات المعروضة
        $('.pcVideoListItem').each((index, element) => {
            if (elements.length < 10) { // نأخذ 10 عناصر كحد أقصى (حد فيسبوك)
                let title = $(element).find('.title a').text().trim();
                let link = 'https://www.pornhub.com' + $(element).find('.title a').attr('href');
                let imgUrl = $(element).find('img').attr('src') || $(element).find('img').attr('data-thumb_url');

                // نتأكد من وجود صورة وعنوان ورابط قبل إضافته للقائمة
                if (title && link && imgUrl && !imgUrl.includes('data:image')) {
                    elements.push({
                        title: title.substring(0, 75) + "..", // فيسبوك يقبل 80 حرف كحد أقصى
                        image_url: imgUrl,
                        subtitle: "اضغط لتحميل هذا الفيديو",
                        buttons: [
                            {
                                type: "postback",
                                title: "📥 اختيار للتحميل",
                                payload: link // نخزن رابط الفيديو هنا لكي نستخدمه عند الضغط
                            }
                        ]
                    });
                }
            }
        });

        if (elements.length > 0) {
            // إرسال قائمة العناصر لفيسبوك
            await sendCarouselMessage(sender_psid, elements);
        } else {
            await sendTextMessage(sender_psid, "لم أتمكن من العثور على فيديوهات، ربما تم حظر السكرابنج أو تغير تصميم الموقع.");
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

// 5. دالة إرسال القائمة (Carousel / Generic Template)
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

// 6. دالة التواصل مع API فيسبوك لإرسال الرد
async function callSendAPI(requestBody) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, requestBody);
        console.log("✅ تم إرسال الرد للمستخدم بنجاح!");
    } catch (error) {
        console.error("⚠️ فشل إرسال الرد إلى فيسبوك. الخطأ الحقيقي:");
        if (error.response) {
            console.error(error.response.data); // يطبع رد فيسبوك المفصل للخطأ
        } else {
            console.error(error);
        }
    }
}

// تشغيل السيرفر على المنفذ 8080 والعنوان 0.0.0.0 المخصص لـ Fly.io
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`في إعدادات فيسبوك، استخدم التوكن التالي للتحقق: ${VERIFY_TOKEN}`);
});
