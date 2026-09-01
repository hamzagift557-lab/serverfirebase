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
        // إرسال الرد فوراً لفيسبوك لتجنب إعادة إرسال الرسالة أثناء التحميل الطويل
        res.status(200).send('EVENT_RECEIVED');

        body.entry.forEach(async function(entry) {
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;

            try {
                if (webhook_event.message && webhook_event.message.text) {
                    console.log(`📩 استلام رسالة من ${sender_psid}، جاري جلب الفيديوهات...`);
                    await fetchAndSendVideos(sender_psid, 1);
                } 
                else if (webhook_event.postback) {
                    let payload = webhook_event.postback.payload;
                    console.log(`🔘 تم الضغط على زر: ${payload}`);
                    
                    if (payload.startsWith('LOAD_MORE_')) {
                        let nextPage = parseInt(payload.split('_')[2]);
                        await fetchAndSendVideos(sender_psid, nextPage);
                    } else {
                        // بدء عملية استخراج وتحميل الفيديو
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

// 3. دالة جلب الفيديوهات عبر ScraperAPI (مع إصلاح الصور والمدة والمزيد)
async function fetchAndSendVideos(sender_psid, page = 1) {
    try {
        const targetUrl = `https://www.pornhub.com/video/search?search=new&page=${page}`;
        const scraperApiUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&keep_headers=true`;
        
        const response = await axios.get(scraperApiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': 'age_verified=1; bs=1; platform=pc;' 
            }
        });

        const $ = cheerio.load(response.data);
        let elements = [];
        let videoElements = $('.pcVideoListItem').toArray();

        for (let i = 0; i < videoElements.length; i++) {
            if (elements.length >= 9) break; // نترك العنصر العاشر لزر المزيد

            let element = videoElements[i];
            let title = $(element).find('.title a').text().trim();
            let link = $(element).find('.title a').attr('href');
            
            // إصلاح الصور: البحث في الخصائص المتعددة للـ Lazy Loading
            let imgUrl = $(element).find('img').attr('data-image') || 
                         $(element).find('img').attr('data-mediumthumb') || 
                         $(element).find('img').attr('data-thumb_url') || 
                         $(element).find('img').attr('src');
            
            // جلب وقت الفيديو
            let duration = $(element).find('.duration').text().trim();

            if (title && link && link.includes('viewkey') && imgUrl && !imgUrl.startsWith('data:image')) {
                let fullLink = 'https://www.pornhub.com' + link;
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
            // إضافة زر المزيد
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
            await sendTextMessage(sender_psid, "لم أتمكن من العثور على فيديوهات، يبدو أن الموقع يعرض محتوى فارغ.");
        }

    } catch (error) {
        console.error("⚠️ حدث خطأ أثناء عملية السكرابنج أو التحليل:");
        console.error(error);
        await sendTextMessage(sender_psid, "حدث خطأ أثناء جلب الفيديوهات من الموقع.");
    }
}

// 4. دالة استخراج وتحميل وإرسال الفيديو
async function 


// 4. دالة استخراج وتحميل وإرسال الفيديو (محدثة لتخطي فحص الأمان SSL)
async function downloadAndSendVideo(sender_psid, videoUrl) {
    let filePath = '';
    try {
        await sendTextMessage(sender_psid, "⏳ جاري استخراج رابط الفيديو الأساسي، يرجى الانتظار...");

        const proxyUrl = `http://scraperapi:${SCRAPER_API_KEY}@proxy-server.scraperapi.com:8001`;
        
        // أضفنا --no-check-certificate لتخطي مشكلة الـ SSL في السيرفر
        const videoInfo = await youtubedl(videoUrl, {
            dumpJson: true,
            proxy: proxyUrl,
            format: 'worst[ext=mp4]',
            noCheckCertificate: true
        });

        const directUrl = videoInfo.url;
        await sendTextMessage(sender_psid, "📥 تم استخراج الرابط بنجاح! جاري تحميل الفيديو للسيرفر ثم إرساله لك...");

        filePath = path.join('/tmp', `video_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(filePath);
        
        const downloadResponse = await axios({
            url: directUrl,
            method: 'GET',
            responseType: 'stream',
            // تخطي التحقق من الـ SSL أيضاً لطلب التحميل المباشر
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });

        downloadResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        await sendTextMessage(sender_psid, "🚀 اكتمل التحميل في السيرفر، جاري رفعه إلى ماسنجر...");

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

        await sendTextMessage(sender_psid, "❌ حدث خطأ أثناء التحميل. يرجى المحاولة في فيديو آخر.");
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
