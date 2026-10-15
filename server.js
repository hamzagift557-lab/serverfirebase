const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');

// استدعاء مكتبات الضغط والمعالجة المحلية
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();
let currentQR = ''; 
let isConnected = false; 

// ذاكرة البوت لتخزين نتائج البحث والأقفال
const userSessions = new Map();
const userLocks = new Map();

// دالة مساعدة لاستخراج الخطأ الحقيقي بالكامل وطباعته
function getRealError(err) {
    if (!err) return "Unknown Error";
    if (err.response && err.response.data) {
        try {
            return typeof err.response.data === 'object' ? JSON.stringify(err.response.data, null, 2) : String(err.response.data);
        } catch (e) {
            return String(err.response.data);
        }
    }
    if (err.stack) return String(err.stack);
    if (err.message) return String(err.message);
    return String(err);
}

// دالة انتظار لحماية الرقم من الحظر
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Awake and Running (Fast RAM Cache)!'));

app.get('/qr', (req, res) => {
    if (isConnected) {
        res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ البوت متصل بواتساب بنجاح!</h2>');
    } else if (currentQR) {
        res.send(`
            <html>
                <body style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; background-color:#f0f2f5; font-family: Arial, sans-serif;">
                    <div style="text-align:center; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        <h2 style="color: #075e54;">📱 ربط بوت واتساب</h2>
                        <img src="${currentQR}" style="width:300px; height:300px; border: 2px solid #ddd; border-radius: 10px; padding: 10px;"/>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h2 style="text-align: center; margin-top: 50px;">⏳ جاري توليد الكود أو جلب الجلسة من Firebase...</h2>');
    }
});

const SCRAPER_API_KEY = "e52e3ecb8172c130934a150b2e7c5f22";
const FIREBASE_DB_URL = "https://hamza-kr-default-rtdb.firebaseio.com/whatsapp_auth";

// 🌟 نظام الجلسة الفوري: يقرأ من الرام في 0ms ويحفظ في Firebase بالخلفية دون أي تأخير
async function useFastFirebaseAuthState() {
    let memoryKeys = {};
    let creds = null;

    try {
        console.log('📥 جاري تحميل الجلسة بالكامل في الذاكرة السريعة (RAM)...');
        const res = await axios.get(`${FIREBASE_DB_URL}.json`, { timeout: 15000 });
        if (res.data) {
            if (res.data.creds) {
                creds = JSON.parse(JSON.stringify(res.data.creds), BufferJSON.reviver);
            }
            if (res.data.keys) {
                for (const k in res.data.keys) {
                    memoryKeys[k] = JSON.parse(JSON.stringify(res.data.keys[k]), BufferJSON.reviver);
                }
            }
        }
    } catch (err) {
        console.error("⚠️ خطأ حقيقي أثناء قراءة الجلسة الأولية من Firebase:", getRealError(err));
    }

    if (!creds) {
        creds = initAuthCreds();
        const str = JSON.stringify(creds, BufferJSON.replacer);
        axios.put(`${FIREBASE_DB_URL}/creds.json`, JSON.parse(str)).catch(err => {
            console.error("⚠️ خطأ حقيقي أثناء حفظ creds الأولي في Firebase:", getRealError(err));
        });
    }

    // مزامنة غير متزامنة في الخلفية لعدم تأخير الردود نهائياً
    let pendingUpdates = {};
    let syncTimer = null;

    const scheduleBackgroundSync = () => {
        if (syncTimer) return;
        syncTimer = setTimeout(async () => {
            const payload = pendingUpdates;
            pendingUpdates = {};
            syncTimer = null;
            try {
                await axios.patch(`${FIREBASE_DB_URL}/keys.json`, payload);
            } catch (err) {
                console.error("⚠️ خطأ حقيقي أثناء مزامنة المفاتيح في الخلفية:", getRealError(err));
            }
        }, 1500);
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const safeId = encodeURIComponent(id).replace(/\./g, '%2E');
                        const keyName = `${type}-${safeId}`;
                        let value = memoryKeys[keyName];
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const safeId = encodeURIComponent(id).replace(/\./g, '%2E');
                            const keyName = `${category}-${safeId}`;
                            if (value) {
                                memoryKeys[keyName] = value;
                                const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
                                pendingUpdates[keyName] = serialized;
                            } else {
                                delete memoryKeys[keyName];
                                pendingUpdates[keyName] = null;
                            }
                        }
                    }
                    scheduleBackgroundSync();
                }
            }
        },
        saveCreds: () => {
            const str = JSON.stringify(creds, BufferJSON.replacer);
            axios.put(`${FIREBASE_DB_URL}/creds.json`, JSON.parse(str)).catch(err => {
                console.error("⚠️ خطأ حقيقي أثناء تحديث creds في Firebase:", getRealError(err));
            });
        },
        clearSession: async () => {
            memoryKeys = {};
            try {
                await axios.delete(`${FIREBASE_DB_URL}.json`);
            } catch (err) {
                console.error("⚠️ خطأ حقيقي أثناء مسح الجلسة من Firebase:", getRealError(err));
            }
        }
    };
}

let sock;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds, clearSession } = await useFastFirebaseAuthState();

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'error' }),
            browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: true,
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                let appName = process.env.FLY_APP_NAME ? process.env.FLY_APP_NAME : 'serverfirebase';
                console.log(`📱 تم توليد الكود! افتح الرابط لمسحه: https://${appName}.fly.dev/qr`);
                currentQR = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                isConnected = false;
                currentQR = '';
                let statusCode = 0;
                if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output) {
                    statusCode = lastDisconnect.error.output.statusCode;
                }
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.error('⚠️ انقطع اتصال واتساب. السبب الأصلي:', getRealError(lastDisconnect ? lastDisconnect.error : 'Unknown Disconnect'));

                if (shouldReconnect) {
                    let errStr = getRealError(lastDisconnect ? lastDisconnect.error : '');
                    if (errStr.includes('Bad MAC') ? true : errStr.includes('decrypt')) {
                        console.log('🔄 تلف في الجلسة. جاري مسحها لطلب كود جديد...');
                        await clearSession();
                    }
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    console.log('❌ تم تسجيل الخروج. جاري مسح الجلسة...');
                    await clearSession();
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQR = '';
                console.log('✅ تم ربط واتساب بنجاح وجاهز للاستجابة الفورية!');
                await sock.sendPresenceUpdate('available');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            if (msg.messageTimestamp && msg.messageTimestamp < Math.floor(Date.now() / 1000) - 60) {
                return;
            }

            const sender_psid = msg.key.remoteJid;
            
            let userText = "";
            if (msg.message.conversation) {
                userText = msg.message.conversation;
            } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) {
                userText = msg.message.extendedTextMessage.text;
            }
            userText = userText.trim();

            if (!userText) return;
            console.log(`📩 رسالة فورية من ${sender_psid}: "${userText}"`);

            // إرسال إشعار القراءة فوراً للرد اللحظي
            try {
                await sock.readMessages([msg.key]);
            } catch (e) {}

            let session = userSessions.get(sender_psid);

            // 🌟 1. معالجة أمر الرابط (مثال: "2 link" أو "link 2") بشكل فوري حتى لو هناك قفل
            let linkMatch1 = userText.match(/^(\d+)\s+link$/i);
            let linkMatch2 = userText.match(/^link\s+(\d+)$/i);
            let linkNum = null;
            if (linkMatch1) linkNum = parseInt(linkMatch1[1]);
            if (linkMatch2) linkNum = parseInt(linkMatch2[1]);

            if (linkNum !== null) {
                if (session && session.items && session.items[linkNum - 1]) {
                    let item = session.items[linkNum - 1];
                    await sendLinkDetails(sender_psid, item, linkNum);
                } else {
                    await sendTextMessage(sender_psid, "❌ لم يتم العثور على هذا الرقم في قائمة البحث الحالية. ابحث أولاً ثم اختر من 1 إلى 10.");
                }
                return;
            }

            // 🌟 2. فحص القفل لمنع تضارب الأوامر
            const currentTask = userLocks.get(sender_psid);
            if (currentTask) {
                await sendTextMessage(sender_psid, `⏳ أنا أعمل حالياً على: (${currentTask})...\nيرجى الانتظار حتى أنتهي ولا ترسل أوامر أخرى لعدم حدوث تضارب!`);
                return;
            }

            try {
                let lowerText = userText.toLowerCase();
                let num = parseInt(userText);

                // إذا أرسل رقماً فقط (من 1 إلى 10)
                if (!isNaN(num) && String(num) === userText && num >= 1 && num <= 10 && session) {
                    if (session.type === 'search' && session.items && session.items[num - 1]) {
                        userLocks.set(sender_psid, `فحص جودات الفيديو رقم ${num}`);
                        await fetchQualitiesAndSendOptions(sender_psid, session.items[num - 1]);
                    } else if (session.type === 'quality' && session.qualities && session.qualities[num - 1]) {
                        userLocks.set(sender_psid, `تحميل وضغط الفيديو بالجودة رقم ${num}`);
                        await downloadAndCompressVideo(sender_psid, session.qualities[num - 1], session.selectedVideo);
                    } else {
                        await sendTextMessage(sender_psid, "❌ الرقم غير موجود في الخيارات المتاحة حالياً.");
                    }
                }
                // إذا أرسل كلمة nex لعرض المزيد
                else if (lowerText === 'nex') {
                    if (session && session.searchPage !== undefined) {
                        let nextP = session.searchPage + 1;
                        userLocks.set(sender_psid, `جلب الصفحة رقم ${nextP}`);
                        await fetchAndSendVideos(sender_psid, nextP, session.searchQuery);
                    } else {
                        await sendTextMessage(sender_psid, "❌ لا يوجد بحث سابق لعرض المزيد منه. أرسل كلمة بحث أولاً.");
                    }
                }
                // الترحيب أو البحث مع الاختصارات
                else {
                    if (userText === 'مرحبا' ? true : lowerText === 'hi') {
                        userLocks.set(sender_psid, 'جلب فيديوهات الصفحة الرئيسية');
                        await fetchAndSendVideos(sender_psid, 1, "");
                    } else if (userText.startsWith('http')) {
                        await sendTextMessage(sender_psid, "❌ البوت يعمل عبر البحث المباشر أو الأرقام فقط.");
                    } else {
                        // تطبيق اختصارات البحث المطلوبة
                        let finalQuery = userText;
                        if (lowerText === 'a') finalQuery = 'anal';
                        if (lowerText === 's') finalQuery = 'sex';
                        if (lowerText === 'p') finalQuery = 'porn';

                        userLocks.set(sender_psid, `البحث عن "${finalQuery}"`);
                        await fetchAndSendVideos(sender_psid, 1, finalQuery);
                    }
                }
            } catch (error) {
                const realErr = getRealError(error);
                console.error("⚠️ خطأ حقيقي أثناء تنفيذ طلب المستخدم:", realErr);
                await sendTextMessage(sender_psid, `❌ حدث خطأ حقيقي أثناء التنفيذ:\n${realErr}`);
            } finally {
                userLocks.delete(sender_psid);
            }
        });

    } catch (err) {
        console.error("❌ خطأ حقيقي أثناء تهيئة الاتصال:", getRealError(err));
    }
}

connectToWhatsApp();

// طباعة أي خطأ غير معالج بشكل كامل وحقيقي في اللوغ
process.on('uncaughtException', (err) => {
    console.error('🔥 خطأ غير متوقع (uncaughtException - الرد الأصلي):', getRealError(err));
});
process.on('unhandledRejection', (reason) => {
    console.error('🔥 وعد مرفوض غير معالج (unhandledRejection - الرد الأصلي):', getRealError(reason));
});

// 🌟 دالة إرسال تفاصيل الرابط (2 link)
async function sendLinkDetails(sender_psid, item, indexNum) {
    try {
        let channelName = item.channel;

        // إذا لم تكن القناة ظاهرة في البطاقة الخارجية، نجلبها من صفحة الفيديو
        if (!channelName ? true : channelName === "غير متوفر") {
            try {
                const scraperUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(item.link)}`;
                const res = await axios.get(scraperUrl, { timeout: 20000 });
                const html = res.data;
                let uploaderMatch = html.match(/setUploaderName\('([^']+)'\)/);
                if (uploaderMatch && uploaderMatch[1]) {
                    channelName = uploaderMatch[1];
                }
            } catch (innerErr) {
                console.error("⚠️ خطأ أثناء جلب اسم القناة الإضافي:", getRealError(innerErr));
            }
        }

        const msg = `📌 *تفاصيل الفيديو رقم [ ${indexNum} ]:*\n\n` +
                    `📝 *العنوان:* ${item.title}\n` +
                    `📺 *القناة:* ${channelName ? channelName : 'غير متوفر'}\n` +
                    `⏱️ *المدة:* ${item.duration}\n` +
                    `🔗 *الرابط:* ${item.link}`;

        await sendTextMessage(sender_psid, msg);
    } catch (err) {
        const realErr = getRealError(err);
        console.error("❌ خطأ حقيقي في دالة sendLinkDetails:", realErr);
        await sendTextMessage(sender_psid, `❌ خطأ أثناء جلب تفاصيل الرابط:\n${realErr}`);
    }
}

// 🌟 دالة البحث وإرسال 10 صور بأمان وسرعة
async function fetchAndSendVideos(sender_psid, page = 1, searchQuery = "") {
    try {
        let targetUrl = 'https://www.xvideos.com/';
        if (searchQuery !== "") {
            let p = page - 1;
            targetUrl = `https://www.xvideos.com/?k=${encodeURIComponent(searchQuery)}`;
            if (p > 0) {
                targetUrl = targetUrl + '&p=' + p;
            }
        } else {
            if (page > 1) {
                let p = page - 1;
                targetUrl = `https://www.xvideos.com/new/${p}/`;
            }
        }

        let searchLabel = searchQuery !== "" ? `عن (${searchQuery}) - صفحة ${page}` : `الصفحة الرئيسية (${page})`;
        await sendTextMessage(sender_psid, `⚡ جاري البحث ${searchLabel} وتجهيز 10 فيديوهات...`);

        const scraperUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
        const response = await axios.get(scraperUrl, { timeout: 45000 });
        const $ = cheerio.load(response.data);
        let elements = [];
        
        // جلب 10 فيديوهات
        $('.thumb-block').toArray().slice(0, 10).forEach(element => {
            let titleEl = $(element).find('.title a');
            let link = titleEl.attr('href');
            let titleAttr = titleEl.attr('title');
            let titleText = titleEl.text().trim();
            let title = titleAttr ? titleAttr : (titleText ? titleText : "بدون عنوان");

            let durationText = $(element).find('.duration').text().trim();
            let duration = durationText ? durationText : "غير محدد";

            // استخراج اسم القناة إن وجد
            let ch1 = $(element).find('.metadata .name').text().trim();
            let ch2 = $(element).find('.uploader .name').text().trim();
            let ch3 = $(element).find('.name').first().text().trim();
            let channel = ch1 ? ch1 : (ch2 ? ch2 : (ch3 ? ch3 : "غير متوفر"));
            
            let imgUrl = $(element).find('.thumb img').attr('data-src');
            if (!imgUrl) {
                imgUrl = $(element).find('.thumb img').attr('src');
            }
            
            if (link && imgUrl) {
                let fullLink = link.startsWith('http') ? link : 'https://www.xvideos.com' + link;
                elements.push({
                    link: fullLink,
                    title: title,
                    channel: channel,
                    duration: duration,
                    image: imgUrl
                });
            }
        });

        if (elements.length > 0) {
            userSessions.set(sender_psid, {
                type: 'search',
                items: elements,
                searchPage: page,
                searchQuery: searchQuery
            });

            // إرسال الصور الـ 10 بفاصل زمني آمن (800ms) لحماية الرقم من الحظر
            for (let i = 0; i < elements.length; i++) {
                try {
                    await sock.sendPresenceUpdate('composing', sender_psid);
                } catch (e) {}

                await sock.sendMessage(sender_psid, {
                    image: { url: elements[i].image },
                    caption: `🎬 خيار رقم [ ${i + 1} ]\n⏱️ المدة: ${elements[i].duration}`
                });

                await delay(800);
            }

            await sendTextMessage(
                sender_psid,
                `✅ تم عرض ${elements.length} فيديوهات!\n\n` +
                `📥 *للتحميل:* أرسل رقم الفيديو (من 1 إلى ${elements.length})\n` +
                `🔗 *لمعرفة الرابط والعنوان والقناة:* أرسل الرقم متبوعاً بكلمة link (مثال: *2 link*)\n` +
                `⏭️ *لعرض 10 فيديوهات أخرى:* أرسل كلمة *nex*`
            );
        } else {
            await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على نتائج مطابقة. جرب كلمة بحث أخرى.");
        }
    } catch (error) {
        const realErr = getRealError(error);
        console.error("❌ خطأ حقيقي في fetchAndSendVideos:", realErr);
        await sendTextMessage(sender_psid, `❌ حدث خطأ حقيقي أثناء جلب الفيديوهات:\n${realErr}`);
    }
}

// 🌟 دالة استخراج جميع الجودات المتاحة (240p, 360p, 480p, 720p, 1080p + MP4)
async function fetchQualitiesAndSendOptions(sender_psid, videoItem) {
    try {
        await sendTextMessage(sender_psid, "⏳ جاري فحص جميع الجودات والأحجام المتاحة لهذا الفيديو...");

        const scraperUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(videoItem.link)}`;
        const response = await axios.get(scraperUrl, { timeout: 45000 });
        const html = response.data;

        // استخراج مدة الفيديو بالثواني لحساب أحجام جودات البث بدقة
        let durationSec = 0;
        let durMatch = html.match(/setVideoDuration\((\d+(?:\.\d+)?)\)/);
        if (durMatch && durMatch[1]) {
            durationSec = parseFloat(durMatch[1]);
        }

        // تحديث اسم القناة إذا وجد في السورس
        let uploaderMatch = html.match(/setUploaderName\('([^']+)'\)/);
        if (uploaderMatch && uploaderMatch[1]) {
            videoItem.channel = uploaderMatch[1];
        }

        let sessionQualities = [];
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        // 1. استخراج جميع الجودات من ملف البث الرئيسي HLS (240p, 360p, 480p, 720p, 1080p)
        let matchHLS = html.match(/setVideoHLS\('([^']+)'\)/);
        if (matchHLS && matchHLS[1]) {
            try {
                const hlsMasterUrl = matchHLS[1];
                const baseUrl = hlsMasterUrl.substring(0, hlsMasterUrl.lastIndexOf('/') + 1);
                const m3u8Res = await axios.get(hlsMasterUrl, { httpsAgent, timeout: 15000 });
                const lines = String(m3u8Res.data).split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('#EXT-X-STREAM-INF:')) {
                        const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
                        if (nextLine && !nextLine.startsWith('#')) {
                            let nameMatch = line.match(/NAME="([^"]+)"/);
                            let resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                            let bwMatch = line.match(/BANDWIDTH=(\d+)/);

                            let label = nameMatch ? nameMatch[1] : (resMatch ? `${resMatch[1]}p` : 'جودة بث');
                            let streamUrl = nextLine.startsWith('http') ? nextLine : baseUrl + nextLine;

                            let sizeMB = "?";
                            if (bwMatch && bwMatch[1] && durationSec > 0) {
                                let bandwidth = parseInt(bwMatch[1]);
                                sizeMB = ((bandwidth * durationSec) / (8 * 1024 * 1024)).toFixed(1);
                            }

                            sessionQualities.push({
                                label: `جودة ${label}`,
                                url: streamUrl,
                                sizeMB: sizeMB,
                                isHLS: true,
                                height: resMatch ? parseInt(resMatch[1]) : 0
                            });
                        }
                    }
                }
                // ترتيب الجودات من الأقل للأعلى
                sessionQualities.sort((a, b) => a.height - b.height);
            } catch (hlsErr) {
                console.error("⚠️ خطأ أثناء قراءة ملف HLS:", getRealError(hlsErr));
            }
        }

        // 2. إضافة روابط MP4 المباشرة (المنخفضة والعالية) إن لم يتوفر HLS أو كخيارات إضافية مضمونة
        let matchLow = html.match(/setVideoUrlLow\('([^']+)'\)/);
        let matchHigh = html.match(/setVideoUrlHigh\('([^']+)'\)/);
        let directList = [];
        if (matchLow && matchLow[1]) directList.push({ label: "MP4 مباشر (منخفضة)", url: matchLow[1] });
        if (matchHigh && matchHigh[1]) directList.push({ label: "MP4 مباشر (أساسية)", url: matchHigh[1] });

        for (let q of directList) {
            try {
                const headRes = await axios.head(q.url, { httpsAgent, timeout: 10000 });
                let sizeBytes = headRes.headers['content-length'];
                let sizeMB = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) : "?";
                sessionQualities.push({ label: q.label, url: q.url, sizeMB: sizeMB, isHLS: false });
            } catch (headErr) {
                sessionQualities.push({ label: q.label, url: q.url, sizeMB: "?", isHLS: false });
            }
        }

        if (sessionQualities.length > 0) {
            let currentSession = userSessions.get(sender_psid);
            userSessions.set(sender_psid, {
                type: 'quality',
                qualities: sessionQualities,
                selectedVideo: videoItem,
                items: currentSession ? currentSession.items : [],
                searchPage: currentSession ? currentSession.searchPage : 1,
                searchQuery: currentSession ? currentSession.searchQuery : ""
            });
            
            let msg = `✅ *تم استخراج جميع الجودات المتاحة (${sessionQualities.length} جودات):*\nأرسل رقم الجودة لبدء التحميل:\n\n`;
            sessionQualities.forEach((q, index) => {
                msg += `*[ ${index + 1} ]* 📥 ${q.label} — (الحجم التقريبي: ${q.sizeMB}MB)\n`;
            });
            await sendTextMessage(sender_psid, msg);
        } else {
            await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على روابط الفيديو في الصفحة.");
        }
    } catch (error) {
        const realErr = getRealError(error);
        console.error("❌ خطأ حقيقي في fetchQualitiesAndSendOptions:", realErr);
        await sendTextMessage(sender_psid, `❌ خطأ حقيقي أثناء فحص الجودات:\n${realErr}`);
    }
}

// 🌟 محرك التحميل، تفعيل التشغيل الفوري (FastStart)، وتوليد الصورة المصغرة
async function downloadAndCompressVideo(sender_psid, qualityObj, videoItem) {
    const timestamp = Date.now();
    let originalPath = path.join('/tmp', `orig_${timestamp}.mp4`);
    let readyPath = path.join('/tmp', `ready_${timestamp}.mp4`);
    let thumbPath = path.join('/tmp', `thumb_${timestamp}.jpg`);

    try {
        await sendTextMessage(sender_psid, `📥 جاري تحميل الفيديو (${qualityObj.label}) إلى السيرفر...`);

        if (qualityObj.isHLS) {
            await downloadHLSStreamLocally(qualityObj.url, originalPath);
        } else {
            await downloadFileLocally(qualityObj.url, originalPath);
        }

        const originalSizeMB = fs.statSync(originalPath).size / (1024 * 1024);

        if (originalSizeMB <= 60.0) {
            await sendTextMessage(sender_psid, `⚡ اكتمل التحميل (${originalSizeMB.toFixed(1)}MB)! جاري تهيئة البث السريع والغلاف...`);
            // تهيئة FastStart بدون إعادة ضغط خلال ثانية واحدة ليعمل الفيديو في واتساب فوراً قبل اكتمال التنزيل
            await remuxFastStart(originalPath, readyPath);
        } else {
            await sendTextMessage(sender_psid, `⚠️ حجم الفيديو (${originalSizeMB.toFixed(1)}MB) أكبر من 60MB، جاري ضغطه محلياً مع الحفاظ على الدقة...`);
            await compressVideoLocally(originalPath, readyPath, 58.0);
        }

        // استخراج صورة مصغرة حقيقية للفيديو لكي يظهر الغلاف في واتساب
        await generateThumbnail(readyPath, thumbPath);

        await sendTextMessage(sender_psid, `🚀 جاري إرسال الفيديو إلى محادثتك الآن...`);
        await uploadVideoToWhatsApp(sender_psid, readyPath, thumbPath, videoItem);

    } catch (error) {
        const realErr = getRealError(error);
        console.error("❌ خطأ حقيقي في downloadAndCompressVideo:", realErr);
        await sendTextMessage(sender_psid, `❌ حدث خطأ حقيقي أثناء تحميل أو معالجة الفيديو:\n${realErr}`);
    } finally {
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(readyPath)) fs.unlinkSync(readyPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

        // إعادة حالة الجلسة إلى البحث السابق لتمكين المستخدم من اختيار فيديو آخر مباشرة
        let currentSession = userSessions.get(sender_psid);
        if (currentSession && currentSession.items && currentSession.items.length > 0) {
            userSessions.set(sender_psid, {
                type: 'search',
                items: currentSession.items,
                searchPage: currentSession.searchPage,
                searchQuery: currentSession.searchQuery
            });
        }
    }
}

// تحميل بث HLS وتحويله إلى MP4 جاهز للبث السريع
function downloadHLSStreamLocally(m3u8Url, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(m3u8Url)
            .inputOptions([
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .outputOptions([
                '-y',
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-movflags', '+faststart'
            ])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

// نقل معلومات الفهرس (moov atom) لبداية الملف لكي يعمل الفيديو في واتساب دون انتظار التحميل الكامل
function remuxFastStart(inputPath, outputPath) {
    return new Promise((resolve) => {
        ffmpeg(inputPath)
            .outputOptions([
                '-y',
                '-c', 'copy',
                '-movflags', '+faststart'
            ])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => {
                console.error("⚠️ تنبيه أثناء عمل FastStart (سيتم استخدام الملف الأصلي):", getRealError(err));
                fs.copyFileSync(inputPath, outputPath);
                resolve(outputPath);
            });
    });
}

// توليد صورة مصغرة (Thumbnail) من داخل الفيديو لعرضها في واتساب
function generateThumbnail(videoPath, thumbPath) {
    return new Promise((resolve) => {
        ffmpeg(videoPath)
            .inputOptions(['-ss', '00:00:02'])
            .outputOptions([
                '-y',
                '-vframes', '1',
                '-vf', 'scale=320:-1',
                '-q:v', '5'
            ])
            .save(thumbPath)
            .on('end', () => resolve(true))
            .on('error', (err) => {
                console.error("⚠️ تنبيه أثناء توليد الصورة المصغرة:", getRealError(err));
                resolve(false);
            });
    });
}

function compressVideoLocally(inputPath, outputPath, targetSizeMB) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            let targetVideoBitrate = '400k'; 
            let hasDuration = metadata && metadata.format && metadata.format.duration;
            if (!err && hasDuration) {
                let vBitrate = Math.floor((targetSizeMB * 8192) / metadata.format.duration) - 128;
                let finalBitrate = vBitrate < 120 ? 120 : vBitrate;
                targetVideoBitrate = finalBitrate + 'k';
            }
            ffmpeg(inputPath)
                .outputOptions([
                    '-y',
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    `-b:v`, targetVideoBitrate,
                    '-preset', 'ultrafast',
                    '-threads', '2',
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-movflags', '+faststart'
                ])
                .save(outputPath)
                .on('end', () => resolve(outputPath))
                .on('error', reject);
        });
    });
}

async function downloadFileLocally(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 300000,
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// 🌟 رفع الفيديو لواتساب مع الصورة المصغرة والمدة لضمان التشغيل الفوري
async function uploadVideoToWhatsApp(sender_psid, filePath, thumbPath, videoItem) {
    let thumbBuffer = undefined;
    if (thumbPath && fs.existsSync(thumbPath)) {
        thumbBuffer = fs.readFileSync(thumbPath);
    }

    let durationSeconds = undefined;
    try {
        durationSeconds = await new Promise((resolve) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (!err && metadata && metadata.format && metadata.format.duration) {
                    resolve(Math.round(metadata.format.duration));
                } else {
                    resolve(undefined);
                }
            });
        });
    } catch (e) {}

    const messagePayload = {
        video: { url: filePath },
        mimetype: 'video/mp4',
        caption: `✅ *تم التحميل بنجاح!*\n⏱️ المدة: ${videoItem ? videoItem.duration : ''}`
    };

    if (thumbBuffer) {
        messagePayload.jpegThumbnail = thumbBuffer;
    }
    if (durationSeconds) {
        messagePayload.seconds = durationSeconds;
    }

    await sock.sendMessage(sender_psid, messagePayload);
}

async function sendTextMessage(sender_psid, text) { 
    await sock.sendMessage(sender_psid, { text: text }); 
}

const PORT = process.env.PORT ? process.env.PORT : 8080;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 السيرفر يعمل بأقصى سرعة على المنفذ ${PORT}`); 
    setInterval(async () => {
        try {
            await axios.get(`http://localhost:${PORT}/`);
        } catch (e) {}
    }, 4 * 60 * 1000);
});
