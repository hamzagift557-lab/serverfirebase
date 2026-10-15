const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode'); // استخدام المكتبة الجديدة للصورة

// استدعاء مكتبات الضغط المحلي الذكي
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// تهيئة مسارات تشغيل FFmpeg برمجياً داخل السيرفر
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

// إعداد خادم Express
const app = express();
let currentQR = ''; // لتخزين صورة الكود
let isConnected = false; // لمعرفة حالة الاتصال

// الصفحة الرئيسية
app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Running on Low RAM!'));

// 🌟 صفحة ويب خاصة وجميلة لعرض كود QR بوضوح
app.get('/qr', (req, res) => {
    if (isConnected) {
        res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ البوت متصل بواتساب بنجاح! لا حاجة لمسح الكود.</h2>');
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; background-color:#f0f2f5; font-family: Arial, sans-serif;">
                    <div style="text-align:center; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        <h2 style="color: #075e54;">📱 ربط بوت واتساب</h2>
                        <p>افتح واتساب في هاتفك > الأجهزة المرتبطة > مسح الكود</p>
                        <img src="${currentQR}" style="width:300px; height:300px; border: 2px solid #ddd; border-radius: 10px; padding: 10px;"/>
                        <p style="color: red; font-size: 14px;">(قم بتحديث هذه الصفحة إذا تأخرت في مسح الكود وانتهت صلاحيته)</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h2 style="text-align: center; margin-top: 50px;">⏳ جاري توليد الكود... قم بتحديث هذه الصفحة بعد 5 ثوانٍ.</h2>');
    }
});

// مفتاح ScraperAPI الخاص بك
const SCRAPER_API_KEY = "e52e3ecb8172c130934a150b2e7c5f22";

let sock;

// إعداد وتشغيل عميل واتساب الخفيف (Baileys) بدون متصفح
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // تم الإلغاء من السجل لمنع التشويه
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
        });

        // حفظ جلسة تسجيل الدخول تلقائياً
        sock.ev.on('creds.update', saveCreds);

        // 1. إدارة الاتصال وتوليد كود QR
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 تم توليد الكود! افتح هذا الرابط في متصفحك لمسحه:');
                console.log(`➡️ https://${process.env.FLY_APP_NAME}.fly.dev/qr`);
                
                // تحويل الكود إلى صورة وحفظه في المتغير
                currentQR = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                isConnected = false;
                currentQR = '';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.error('⚠️ تم قطع اتصال واتساب (الرد الأصلي):', lastDisconnect?.error?.message || lastDisconnect?.error);
                if (shouldReconnect) {
                    console.log('🔄 جاري إعادة الاتصال بواتساب...');
                    connectToWhatsApp();
                } else {
                    console.log('❌ تم تسجيل الخروج من الهاتف. يجب مسح الكود من جديد.');
                    // لحذف بيانات الاعتماد القديمة إذا قام المستخدم بتسجيل الخروج من هاتفه
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQR = '';
                console.log('✅ تم ربط واتساب بنجاح! البوت الآن جاهز لاستقبال الرسائل.');
            }
        });

        // 2. مسار استقبال الرسائل من واتساب
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender_psid = msg.key.remoteJid;
            const userText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ""
            ).trim();

            if (!userText) return;

            console.log(`📩 استلام رسالة من ${sender_psid}: "${userText}"`);

            try {
                // إذا أرسل المستخدم أمر تحميل الصفحة التالية
                if (userText.startsWith('LOAD_MORE|')) {
                    let parts = userText.split('|');
                    let nextPage = parseInt(parts[1]);
                    let searchQuery = parts[2] ? parts[2] : "";
                    await fetchAndSendVideos(sender_psid, nextPage, searchQuery);
                }
                // إذا أرسل المستخدم رابط فيديو مباشر للتحميل (ينتهي بـ mp4 أو يحتوي على secure)
                else if (userText.startsWith('http') && (userText.includes('mp4_sd.mp4') || userText.includes('secure='))) {
                    await downloadAndCompressVideo(sender_psid, userText);
                }
                // إذا أرسل المستخدم رابط صفحة الفيديو من الموقع لمعرفة الجودات
                else if (userText.startsWith('http') && userText.includes('xvideos.com')) {
                    await fetchQualitiesAndSendOptions(sender_psid, userText);
                }
                // إذا أرسل ترحيب
                else if (userText === 'مرحبا' || userText.toLowerCase() === 'hi') {
                    await fetchAndSendVideos(sender_psid, 1, "");
                } 
                // أي كلمة أخرى تعتبر بحث
                else {
                    await fetchAndSendVideos(sender_psid, 1, userText);
                }
            } catch (error) {
                console.error("⚠️ حدث خطأ داخلي أثناء معالجة الحدث:", error?.stack || error?.message || error);
            }
        });

    } catch (err) {
        console.error("❌ خطأ حقيقي أثناء تهيئة اتصال واتساب:", err?.stack || err?.message || err);
    }
}

// بدء تشغيل واتساب
connectToWhatsApp();

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ خطأ غير معالج (Unhandled Rejection - الرد الأصلي):', reason?.stack || reason?.message || reason);
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
            let attrTitle = $(element).find('.title a').attr('title');
            let textTitle = $(element).find('.title a').text().trim();
            let title = attrTitle ? attrTitle : textTitle;

            let link = $(element).find('.title a').attr('href');
            let duration = $(element).find('.duration').text().trim();

            if (title && link) {
                let fullLink = link.startsWith('http') ? link : 'https://www.xvideos.com' + link;
                elements.push({
                    title: title.substring(0, 75) + "..",
                    subtitle: duration ? `المدة: ${duration} ⏱️` : "",
                    link: fullLink
                });
            }
        }

        if (elements.length > 0) {
            await sendCarouselMessage(sender_psid, elements, page, searchQuery);
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
                    title: `📥 ${q.label} (${sizeMB}M)`,
                    payload: q.url
                });
            } catch (e) {
                console.error(`⚠️ فشل جلب حجم الجودة الـ ${q.label}:`, e.message);
            }
        }

        if (buttons.length > 0) {
            await sendButtonMessage(sender_psid, "✅ تم العثور على الجودات. (انسخ رابط الجودة وأرسله لي للتحميل):", buttons);
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

        if (originalSizeMB <= 60.0) {
            await sendTextMessage(sender_psid, `🚀 الحجم مناسب لواتساب (${originalSizeMB.toFixed(1)} MB)! جاري رفعه الآن...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath);
            if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
            return;
        }

        await sendTextMessage(sender_psid, `⚠️ الحجم الأصلي (${originalSizeMB.toFixed(1)} MB) كبير جداً. جاري ضغطه محلياً...`);

        compressedPath = path.join('/tmp', `comp_${Date.now()}.mp4`);
        
        await compressVideoLocally(originalPath, compressedPath, 58.0);

        const compStats = fs.statSync(compressedPath);
        const compSizeMB = compStats.size / (1024 * 1024);

        if (compSizeMB <= 64.0) {
            await sendTextMessage(sender_psid, `🚀 نجح الضغط المحلي! الحجم أصبح (${compSizeMB.toFixed(1)} MB). جاري إرساله لواتساب...`);
            await uploadVideoToWhatsApp(sender_psid, compressedPath);
        } else {
            await sendTextMessage(sender_psid, `⚠️ الحجم متجاوز للحد.\n\n🔗 يمكنك التحميل عبر الرابط المباشر:\n${directUrl}`);
        }

        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

    } catch (error) {
        let realError = error.response?.data ? JSON.stringify(error.response.data) : (error.message || error);
        console.error("⚠️ حدث خطأ حقيقي أثناء معالجة أو إرسال الفيديو:", realError);
        
        if (originalPath && fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);

        await sendTextMessage(sender_psid, `❌ حدث خطأ تقني:\n${realError}`);
    }
}

// دالة الضغط الذكية مع مراقبة التقدم
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
                    '-threads 2', 
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

async function uploadVideoToWhatsApp(sender_psid, filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`الملف المطلوب إرساله لواتساب غير موجود: ${filePath}`);
    }
    await sock.sendMessage(sender_psid, {
        video: { url: filePath },
        mimetype: 'video/mp4'
    });
    console.log("✅ تم إرسال الفيديو للمستخدم في واتساب بنجاح!");
}

async function sendTextMessage(sender_psid, text) {
    await sock.sendMessage(sender_psid, { text: text });
}

async function sendButtonMessage(sender_psid, text, buttons) {
    let msg = `${text}\n\n`;
    buttons.forEach(b => {
        msg += `✨ ${b.title}\n🔗 ${b.payload}\n\n`;
    });
    await sock.sendMessage(sender_psid, { text: msg });
}

async function sendCarouselMessage(sender_psid, elements, currentPage, searchQuery) {
    let msg = "✨ الفيديوهات المتاحة (انسخ الرابط وأرسله لي لاختيار الجودة):\n\n";
    elements.forEach((el, index) => {
        msg += `🎬 ${index + 1}. ${el.title}\n${el.subtitle}\n🔗 ${el.link}\n\n`;
    });
    
    msg += `🔄 للمزيد من الفيديوهات أرسل الأمر التالي:\nLOAD_MORE|${currentPage + 1}|${searchQuery}`;
    
    await sock.sendMessage(sender_psid, { text: msg });
}

const PORT = process.env.PORT ? process.env.PORT : 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`);
});
