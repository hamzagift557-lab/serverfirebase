const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const youtubedl = require('youtube-dl-exec'); 
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// استدعاء مكتبات الضغط المحلي الذكي
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// تهيئة مسارات تشغيل FFmpeg برمجياً داخل السيرفر
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();
app.use(bodyParser.json());

// كلمة السر للـ Webhook
const VERIFY_TOKEN = "hamza_webhook_123";

// التوكن الخاص بصفحتك
const PAGE_ACCESS_TOKEN = "EAAG5a8VWw5IBScY1farwQucBljWbYEZA5QuwVjiGUUWqVR64ZBXRkLq2QJBjNtmnBQAjFBTcDpQzfyUWuPgXExhf72Tk1GWgWoIxXeX71DFwOAUrfBBZBaqrdqmcOtJQqeuUCGmFRAx2vDQFMD0Unpsw4rjl6sZCChJ6FnaUYojfBe2JMhQjFVui0r9No2sB2CEZD";

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
        res.status(200).send('EVENT_RECEIVED');

        body.entry.forEach(async function(entry) {
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;

            try {
                if (webhook_event.message && webhook_event.message.text) {
                    let userText = webhook_event.message.text.trim();
                    console.log(`📩 استلام رسالة من ${sender_psid}: "${userText}"`);
                    
                    if (userText === 'مرحبا' || userText.toLowerCase() === 'hi') {
                        await fetchAndSendVideos(sender_psid, 1, "");
                    } else {
                        await fetchAndSendVideos(sender_psid, 1, userText);
                    }
                } 
                else if (webhook_event.postback) {
                    let payload = webhook_event.postback.payload;
                    console.log(`🔘 تم الضغط على زر: ${payload}`);
                    
                    // دعم الأزرار الجديدة التي تحتوي على نص البحث
                    if (payload.startsWith('LOAD_MORE|')) {
                        let parts = payload.split('|');
                        let nextPage = parseInt(parts[1]);
                        let searchQuery = parts[2] || "";
                        await fetchAndSendVideos(sender_psid, nextPage, searchQuery);
                    }
                    // دعم رجعي للأزرار القديمة لتجنب الأعطال
                    else if (payload.startsWith('LOAD_MORE_')) {
                        let nextPage = parseInt(payload.split('_')[2]);
                        await fetchAndSendVideos(sender_psid, nextPage, "");
                    } 
                    else if (payload.startsWith('DOWNLOAD_VIDEO|')) {
                        let directUrl = payload.split('|')[1];
                        await downloadAndCompressVideo(sender_psid, directUrl);
                    } 
                    else {
                        await fetchQualitiesAndSendOptions(sender_psid, payload);
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

// 3. دالة جلب الفيديوهات (مع دعم البحث)
async function fetchAndSendVideos(sender_psid, page = 1, searchQuery = "") {
    try {
        let targetUrl = '';
        if (searchQuery !== "") {
            let p = page - 1;
            targetUrl = `https://www.xvideos.com/?k=${encodeURIComponent(searchQuery)}${p > 0 ? '&p=' + p : ''}`;
            if (page === 1) {
                await sendTextMessage(sender_psid, `🔍 جاري البحث عن: ${searchQuery}...`);
            }
        } else {
            targetUrl = page === 1 ? 'https://www.xvideos.com/' : `https://www.xvideos.com/new/${page - 1}/`;
        }

        const scraperApiUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
        
        const response = await axios.get(scraperApiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
                        payload: `LOAD_MORE|${page + 1}|${searchQuery}`
                    }
                ]
            });

            await sendCarouselMessage(sender_psid, elements);
        } else {
            await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على فيديوهات مطابقة.");
        }

    } catch (error) {
        let realError = error.response?.data ? JSON.stringify(error.response.data) : (error.message || error);
        console.error("⚠️ حدث خطأ أثناء عملية السكرابنج الحقيقي:", realError);
        await sendTextMessage(sender_psid, `حدث خطأ أثناء جلب الفيديوهات:\n${realError}`);
    }
}

// 4. فحص الجودات
async function fetchQualitiesAndSendOptions(sender_psid, videoUrl) {
    try {
        await sendTextMessage(sender_psid, "⏳ جاري فحص الجودات والأحجام المتاحة لهذا الفيديو...");

        const scraperApiUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(videoUrl)}`;
        const htmlResponse = await axios.get(scraperApiUrl);
        const html = htmlResponse.data;

        let qualities = [];
        let matchLow = html.match(/setVideoUrlLow\('([^']+)'\)/);
        let matchHigh = html.match(/setVideoUrlHigh\('([^']+)'\)/);

        let urlLow = matchLow && matchLow[1] ? matchLow[1] : null;
        let urlHigh = matchHigh && matchHigh[1] ? matchHigh[1] : null;

        if (urlLow) qualities.push({ label: "منخفضة", url: urlLow });
        if (urlHigh && urlHigh !== urlLow) qualities.push({ label: "عالية", url: urlHigh });
        else if (urlHigh && !urlLow) qualities.push({ label: "عالية", url: urlHigh });

        if (qualities.length === 0) {
            await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على روابط التحميل في السورس كود.");
            return;
        }

        let buttons = [];
        for (let q of qualities) {
            try {
                const headRes = await axios.head(q.url, {
                    httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
                });
                let sizeBytes = headRes.headers['content-length'];
                let sizeMB = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) : "?";
                
                buttons.push({
                    type: "postback",
                    title: `📥 ${q.label} (${sizeMB}M)`,
                    payload: `DOWNLOAD_VIDEO|${q.url}`
                });
            } catch (e) {
                console.error(`⚠️ فشل جلب حجم الجودة الـ ${q.label}:`, e.message);
            }
        }

        if (buttons.length > 0) {
            await sendButtonMessage(sender_psid, "✅ تم العثور على الجودات (البوت سيقوم بضغط الفيديو محلياً إذا تجاوز 25M):", buttons);
        } else {
            await sendTextMessage(sender_psid, "❌ حدث خطأ أثناء قراءة أحجام الفيديو.");
        }

    } catch (error) {
        let realError = error.response?.data ? JSON.stringify(error.response.data) : (error.message || error);
        console.error("⚠️ حدث خطأ أثناء فحص الجودات:", realError);
        await sendTextMessage(sender_psid, `❌ حدث خطأ أثناء الاتصال بالموقع:\n${realError}`);
    }
}

// 5. محرك التحميل والضغط المحلي الذكي (FFmpeg)
async function downloadAndCompressVideo(sender_psid, directUrl) {
    let originalPath = '';
    let compressedPath = '';

    try {
        await sendTextMessage(sender_psid, "📥 جاري تحميل الفيديو الأصلي للسيرفر...");

        originalPath = path.join('/tmp', `orig_${Date.now()}.mp4`);
        await downloadFileLocally(directUrl, originalPath);

        const stats = fs.statSync(originalPath);
        const originalSizeMB = stats.size / (1024 * 1024);

        if (originalSizeMB <= 24.5) {
            await sendTextMessage(sender_psid, `🚀 الحجم الأصلي مناسب (${originalSizeMB.toFixed(1)} MB)! جاري رفعه إلى ماسنجر الآن...`);
            await uploadVideoToFacebook(sender_psid, originalPath);
            if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
            return;
        }

        await sendTextMessage(sender_psid, `⚠️ الحجم الأصلي (${originalSizeMB.toFixed(1)} MB) كبير. جاري ضغطه محلياً لتجاوز قيود فيسبوك...`);

        compressedPath = path.join('/tmp', `comp_${Date.now()}.mp4`);
        
        // تقليل الهدف إلى 22 ميجابايت لتجنب خطأ 500 من سيرفرات فيسبوك تماماً
        await compressVideoLocally(originalPath, compressedPath, 22.0);

        const compStats = fs.statSync(compressedPath);
        const compSizeMB = compStats.size / (1024 * 1024);

        if (compSizeMB <= 24.5) {
            await sendTextMessage(sender_psid, `🚀 نجح الضغط المحلي! الحجم أصبح (${compSizeMB.toFixed(1)} MB). جاري إرساله لماسنجر...`);
            await uploadVideoToFacebook(sender_psid, compressedPath);
        } else {
            await sendTextMessage(sender_psid, `⚠️ على الرغم من الضغط، بقي الحجم (${compSizeMB.toFixed(1)} MB) متجاوزاً 25MB.\n\n🔗 يمكنك التحميل عبر الرابط المباشر:\n${directUrl}`);
        }

        // تنظيف الملفات
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

    } catch (error) {
        // استخراج وطباعة الخطأ الحقيقي كما طلبت
        let realError = error.response?.data ? JSON.stringify(error.response.data) : (error.message || error);
        console.error("⚠️ حدث خطأ حقيقي أثناء معالجة أو إرسال الفيديو:", realError);
        
        if (originalPath && fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        await sendTextMessage(sender_psid, `❌ حدث خطأ تقني:\n${realError}`);
    }
}

// دالة الضغط الذكية مع مراقبة التقدم (FFmpeg)
function compressVideoLocally(inputPath, outputPath, targetSizeMB) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            let targetVideoBitrate = '300k'; 

            if (!err && metadata && metadata.format && metadata.format.duration) {
                const duration = metadata.format.duration; 
                let totalBitrate = Math.floor((targetSizeMB * 8192) / duration);
                let vBitrate = totalBitrate - 128;
                if (vBitrate < 100) vBitrate = 100; 
                targetVideoBitrate = vBitrate + 'k';
                console.log(`تم حساب الـ Bitrate: ${targetVideoBitrate} لمدة ${duration} ثانية للوصول لـ ${targetSizeMB}MB.`);
            } else {
                console.log("لم يتمكن من قراءة مدة الفيديو، سيتم استخدام الضغط الافتراضي.");
            }

            let lastLoggedPercent = -1;

            ffmpeg(inputPath)
                .outputOptions([
                    '-y',
                    '-c:v libx264',
                    `-b:v ${targetVideoBitrate}`,
                    '-preset ultrafast', 
                    '-threads 0', 
                    '-c:a aac',
                    '-b:a 128k',
                    '-movflags +faststart'
                ])
                .on('progress', (progress) => {
                    if (progress.percent) {
                        let currentPercent = Math.floor(progress.percent);
                        if (currentPercent > lastLoggedPercent && currentPercent % 5 === 0) {
                            console.log(`⏳ جاري الضغط... اكتمل: ${currentPercent}%`);
                            lastLoggedPercent = currentPercent;
                        }
                    }
                })
                .save(outputPath)
                .on('end', () => {
                    console.log("✅ اكتمل الضغط بنجاح!");
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error("❌ خطأ أثناء تنفيذ FFmpeg الحقيقي:", err);
                    reject(err);
                });
        });
    });
}

// دوال مساعدة
async function downloadFileLocally(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'stream',
        timeout: 300000, 
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) 
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

async function uploadVideoToFacebook(sender_psid, filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`الملف المطلوب إرساله لفيسبوك غير موجود: ${filePath}`);
    }

    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: sender_psid }));
    form.append('message', JSON.stringify({
        attachment: { type: 'video', payload: { is_reusable: false } }
    }));
    form.append('filedata', fs.createReadStream(filePath));

    // إضافة وقت انتظار طويل لتجنب Timeout من فيسبوك
    await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000 
    });
    console.log("✅ تم إرسال الفيديو للمستخدم بنجاح!");
}

async function sendTextMessage(sender_psid, text) {
    await callSendAPI({ recipient: { id: sender_psid }, message: { text: text } });
}

async function sendButtonMessage(sender_psid, text, buttons) {
    await callSendAPI({
        recipient: { id: sender_psid },
        message: { attachment: { type: "template", payload: { template_type: "button", text: text, buttons: buttons } } }
    });
}

async function sendCarouselMessage(sender_psid, elements) {
    await callSendAPI({
        recipient: { id: sender_psid },
        message: { attachment: { type: "template", payload: { template_type: "generic", elements: elements } } }
    });
}

async function callSendAPI(requestBody) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, requestBody);
    } catch (error) {
        let realError = error.response?.data ? JSON.stringify(error.response.data) : (error.message || error);
        console.error("⚠️ فشل إرسال الرد إلى فيسبوك الداخلي:", realError);
    }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`في إعدادات فيسبوك، استخدم التوكن التالي للتحقق: ${VERIFY_TOKEN}`);
});
