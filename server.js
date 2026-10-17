const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const youtubedl = require('youtube-dl-exec');

// استدعاء مكتبات الضغط والمعالجة
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();
let currentQR = ''; 
let isConnected = false; 

const userSessions = new Map();
const userLocks = new Map();

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Referer': 'https://www.xvideos.com/'
};
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getRealError(err) {
    if (!err) return "Unknown Error";
    let details = [];
    if (err.response) details.push(`HTTP ${err.response.status}`);
    if (err.stack) details.push(String(err.stack));
    else if (err.message) details.push(String(err.message));
    return details.length > 0 ? details.join('\n') : String(err);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchHtmlSmart(targetUrl, SCRAPER_API_KEY) {
    try {
        const directRes = await axios.get(targetUrl, { headers: BROWSER_HEADERS, httpsAgent, timeout: 15000 });
        if (directRes.data && (directRes.data.includes('setVideoHLS') || directRes.data.includes('setVideoUrl'))) return directRes.data;
    } catch (e) {}
    const scraperUrl = `https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
    const proxyRes = await axios.get(scraperUrl, { headers: BROWSER_HEADERS, httpsAgent, timeout: 45000 });
    return proxyRes.data;
}

app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Awake (yt-dlp Engine)!'));
app.get('/qr', (req, res) => {
    if (isConnected) res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ البوت متصل بواتساب بنجاح!</h2>');
    else if (currentQR) res.send(`<html><body style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; background-color:#f0f2f5; font-family: Arial, sans-serif;"><div style="text-align:center; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);"><h2 style="color: #075e54;">📱 ربط بوت واتساب</h2><img src="${currentQR}" style="width:300px; height:300px; border: 2px solid #ddd; border-radius: 10px; padding: 10px;"/></div></body></html>`);
    else res.send('<h2 style="text-align: center; margin-top: 50px;">⏳ جاري توليد الكود أو جلب الجلسة...</h2>');
});

const SCRAPER_API_KEY = "e52e3ecb8172c130934a150b2e7c5f22";
const FIREBASE_DB_URL = "https://hamza-kr-default-rtdb.firebaseio.com/whatsapp_auth";

async function useFastFirebaseAuthState() {
    let memoryKeys = {};
    let creds = null;
    try {
        const res = await axios.get(`${FIREBASE_DB_URL}.json`, { timeout: 15000 });
        if (res.data) {
            if (res.data.creds) creds = typeof res.data.creds === 'string' ? JSON.parse(res.data.creds, BufferJSON.reviver) : JSON.parse(JSON.stringify(res.data.creds), BufferJSON.reviver);
            if (res.data.keys) {
                for (const k in res.data.keys) {
                    let val = res.data.keys[k];
                    memoryKeys[k] = typeof val === 'string' ? JSON.parse(val, BufferJSON.reviver) : JSON.parse(JSON.stringify(val), BufferJSON.reviver);
                }
            }
        }
    } catch (err) {}

    if (!creds) {
        creds = initAuthCreds();
        const credsStr = JSON.stringify(creds, BufferJSON.replacer);
        axios.put(`${FIREBASE_DB_URL}/creds.json`, JSON.stringify(credsStr)).catch(()=>{});
    }

    let pendingUpdates = {};
    let syncTimer = null;
    const scheduleBackgroundSync = () => {
        if (syncTimer) return;
        syncTimer = setTimeout(async () => {
            const payload = pendingUpdates;
            pendingUpdates = {};
            syncTimer = null;
            try { await axios.patch(`${FIREBASE_DB_URL}/keys.json`, payload); } catch (err) {}
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
                            if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
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
                                pendingUpdates[keyName] = JSON.stringify(value, BufferJSON.replacer);
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
            const credsStr = JSON.stringify(creds, BufferJSON.replacer);
            axios.put(`${FIREBASE_DB_URL}/creds.json`, JSON.stringify(credsStr)).catch(()=>{});
        },
        clearSession: async () => {
            memoryKeys = {};
            try { await axios.delete(`${FIREBASE_DB_URL}.json`); } catch (err) {}
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
            logger: pino({ level: 'silent' }),
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
                console.log(`📱 افتح الرابط لمسح الكود: https://${appName}.fly.dev/qr`);
                currentQR = await qrcode.toDataURL(qr);
            }
            if (connection === 'close') {
                isConnected = false; currentQR = '';
                let statusCode = lastDisconnect?.error?.output?.statusCode || 0;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    let errStr = getRealError(lastDisconnect ? lastDisconnect.error : '');
                    if (errStr.includes('Bad MAC') || errStr.includes('decrypt') || errStr.includes('_deserialize_chains') || errStr.includes('undefined')) {
                        await clearSession();
                    }
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    await clearSession();
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                isConnected = true; currentQR = '';
                console.log('✅ تم ربط واتساب بنجاح!');
                await sock.sendPresenceUpdate('available');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            if (msg.messageTimestamp && msg.messageTimestamp < Math.floor(Date.now() / 1000) - 60) return;

            const sender_psid = msg.key.remoteJid;
            let userText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!userText) return;

            try { await sock.readMessages([msg.key]); } catch (e) {}
            let session = userSessions.get(sender_psid);

            let linkMatch1 = userText.match(/^(\d+)\s+link$/i);
            let linkMatch2 = userText.match(/^link\s+(\d+)$/i);
            let linkNum = linkMatch1 ? parseInt(linkMatch1[1]) : (linkMatch2 ? parseInt(linkMatch2[1]) : null);

            if (linkNum !== null) {
                if (session && session.items && session.items[linkNum - 1]) await sendLinkDetails(sender_psid, session.items[linkNum - 1], linkNum);
                else await sendTextMessage(sender_psid, "❌ الرقم غير متوفر في البحث الحالي.");
                return;
            }

            const currentTask = userLocks.get(sender_psid);
            if (currentTask) {
                await sendTextMessage(sender_psid, `⏳ أنا أعمل حالياً على: (${currentTask})...\nيرجى الانتظار!`);
                return;
            }

            try {
                let lowerText = userText.toLowerCase();
                let num = parseInt(userText);

                if (!isNaN(num) && String(num) === userText && num >= 1 && num <= 15 && session) {
                    if (session.type === 'search' && session.items && session.items[num - 1]) {
                        userLocks.set(sender_psid, `فحص جودات الفيديو ${num}`);
                        await fetchQualitiesAndSendOptions(sender_psid, session.items[num - 1]);
                    } else if (session.type === 'quality' && session.qualities && session.qualities[num - 1]) {
                        userLocks.set(sender_psid, `معالجة جودة ${num}`);
                      // 🌟 المحرك الجديد: تحميل وإرسال ذكي بدون ضغط (لمنع انهيار السيرفر SIGSEGV)
async function downloadAndCompressVideo(sender_psid, qualityObj, videoItem) {
    const timestamp = Date.now();
    let originalPath = path.join('/tmp', `vid_${timestamp}.mp4`);
    let thumbPath = path.join('/tmp', `thumb_${timestamp}.jpg`);

    try {
        await sendTextMessage(sender_psid, `📥 جاري التحميل (${qualityObj.label}) بجودته الأصلية... يرجى الانتظار.`);

        // تحميل الفيديو
        if (qualityObj.isYtDlp && qualityObj.format_id) {
            await youtubedl(videoItem.link, {
                format: qualityObj.format_id,
                output: originalPath,
                noWarnings: true,
                noCheckCertificates: true,
                referer: 'https://www.xvideos.com/'
            });
        } else if (qualityObj.isHLS) {
            await downloadHLSInNode(qualityObj.url, path.join('/tmp', `raw_${timestamp}.ts`), originalPath);
        } else {
            await downloadFileLocally(qualityObj.url, originalPath);
        }

        if (!fs.existsSync(originalPath)) {
            throw new Error("ملف الفيديو لم يتم تنزيله بنجاح.");
        }

        const fileSizeMB = fs.statSync(originalPath).size / (1024 * 1024);
        await generateThumbnail(originalPath, thumbPath);

        // 🌟 الخدعة الذكية: إرسال كملف إذا كان كبيراً لتجنب الضغط وانهيار السيرفر
        if (fileSizeMB <= 60.0) {
            await sendTextMessage(sender_psid, `⚡ اكتمل التحميل (${fileSizeMB.toFixed(1)}MB)! جاري الإرسال كفيديو مباشر...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath, thumbPath, videoItem, qualityObj.label, false);
        } else {
            await sendTextMessage(sender_psid, `⚠️ الفيديو بحجم (${fileSizeMB.toFixed(1)}MB) وهو كبير جداً (HD).\n🚀 لتجنب انهيار السيرفر، جاري إرساله كـ "ملف مستند" (Document) عالي الجودة...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath, thumbPath, videoItem, qualityObj.label, true);
        }

    } catch (error) {
        console.error("❌ خطأ التحميل:", getRealError(error));
        await sendTextMessage(sender_psid, `❌ حدث خطأ أثناء تحميل الفيديو. قد يكون الموقع حظر هذا الفيديو مؤقتاً.`);
    } finally {
        // تنظيف الملفات للحفاظ على مساحة السيرفر
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        let rawTsPath = path.join('/tmp', `raw_${timestamp}.ts`);
        if (fs.existsSync(rawTsPath)) fs.unlinkSync(rawTsPath);

        let currentSession = userSessions.get(sender_psid);
        if (currentSession && currentSession.items) {
            userSessions.set(sender_psid, { type: 'search', items: currentSession.items, searchPage: currentSession.searchPage, searchQuery: currentSession.searchQuery });
        } else {
            userSessions.delete(sender_psid);
        }
    }
}

// 🌟 تحديث دالة الرفع لدعم وضع المستندات (Documents)
async function uploadVideoToWhatsApp(sender_psid, filePath, thumbPath, videoItem, qualityLabel, sendAsDocument) {
    let thumbBuffer = undefined;
    if (thumbPath && fs.existsSync(thumbPath)) thumbBuffer = fs.readFileSync(thumbPath);

    const captionText = `✅ *تم التحميل بنجاح*\n🎞️ الجودة: ${qualityLabel}\n⏱️ المدة: ${videoItem ? videoItem.duration : ''}`;

    if (sendAsDocument) {
        // إرسال الفيديوهات الكبيرة كملفات (تدعم حتى 2GB)
        await sock.sendMessage(sender_psid, {
            document: { url: filePath },
            mimetype: 'video/mp4',
            fileName: `${qualityLabel}_Video.mp4`,
            caption: captionText,
            jpegThumbnail: thumbBuffer
        });
    } else {
        // إرسال الفيديوهات الصغيرة كفيديو عادي
        const messagePayload = {
            video: { url: filePath },
            mimetype: 'video/mp4',
            caption: captionText
        };
        if (thumbBuffer) messagePayload.jpegThumbnail = thumbBuffer;
        await sock.sendMessage(sender_psid, messagePayload);
    }
}

async function sendTextMessage(sender_psid, text) { await sock.sendMessage(sender_psid, { text: text }); }

const PORT = process.env.PORT ? process.env.PORT : 8080;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 السيرفر يعمل بأقصى سرعة على المنفذ ${PORT}`); 
    setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/`); } catch (e) {} }, 4 * 60 * 1000);
});
