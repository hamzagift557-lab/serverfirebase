const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');

// استدعاء مكتبات الضغط المحلي الذكي
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

// تهيئة مسارات تشغيل FFmpeg
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();
let currentQR = ''; 
let isConnected = false; 

app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Running with Firebase Auth!'));

app.get('/qr', (req, res) => {
    if (isConnected) {
        res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ البوت متصل بواتساب بنجاح! لا حاجة لمسح الكود.</h2>');
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

// 🌟 المحول الذكي لحفظ جلسة واتساب في Firebase (البديل لمساحات التخزين)
async function useFirebaseAuthState() {
    const readData = async (path) => {
        try {
            const res = await axios.get(`${FIREBASE_DB_URL}/${path}.json`);
            if (res.data) return JSON.parse(JSON.stringify(res.data), BufferJSON.reviver);
            return null;
        } catch (e) { return null; }
    };

    const writeData = async (path, data) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await axios.put(`${FIREBASE_DB_URL}/${path}.json`, JSON.parse(str));
        } catch (e) {}
    };

    const removeData = async (path) => {
        try { await axios.delete(`${FIREBASE_DB_URL}/${path}.json`); } catch (e) {}
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData('creds', creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        // تشفير الـ ID لمنع أخطاء Firebase بسبب الرموز الممنوعة
                        const safeId = encodeURIComponent(id).replace(/\./g, '%2E');
                        let value = await readData(`keys/${type}-${safeId}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const safeId = encodeURIComponent(id).replace(/\./g, '%2E');
                            const keyPath = `keys/${category}-${safeId}`;
                            if (value) tasks.push(writeData(keyPath, value));
                            else tasks.push(removeData(keyPath));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds),
        clearSession: async () => {
            try { await axios.delete(`${FIREBASE_DB_URL}.json`); } catch (e) {}
        }
    };
}

let sock;

async function connectToWhatsApp() {
    try {
        console.log('🔄 جاري جلب جلسة واتساب من Firebase...');
        const { state, saveCreds, clearSession } = await useFirebaseAuthState();

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`📱 تم توليد الكود! افتح الرابط لمسحه: https://${process.env.FLY_APP_NAME}.fly.dev/qr`);
                currentQR = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                isConnected = false;
                currentQR = '';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    const errStr = String(lastDisconnect?.error?.message || '');
                    if (errStr.includes('Bad MAC') || errStr.includes('decrypt')) {
                        console.log('🔄 تلف في الجلسة. جاري مسحها من Firebase لطلب كود جديد...');
                        await clearSession();
                    } else {
                        console.log('🔄 جاري إعادة الاتصال بواتساب...');
                    }
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    console.log('❌ تم تسجيل الخروج. جاري مسح الجلسة من Firebase...');
                    await clearSession();
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                isConnected = true;
                currentQR = '';
                console.log('✅ تم ربط واتساب بنجاح بفضل Firebase!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender_psid = msg.key.remoteJid;
            const userText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

            if (!userText) return;

            try {
                if (userText.startsWith('LOAD_MORE|')) {
                    let parts = userText.split('|');
                    await fetchAndSendVideos(sender_psid, parseInt(parts[1]), parts[2] ? parts[2] : "");
                } else if (userText.startsWith('http') && (userText.includes('mp4_sd.mp4') || userText.includes('secure='))) {
                    await downloadAndCompressVideo(sender_psid, userText);
                } else if (userText.startsWith('http') && userText.includes('xvideos.com')) {
                    await fetchQualitiesAndSendOptions(sender_psid, userText);
                } else if (userText === 'مرحبا' || userText.toLowerCase() === 'hi') {
                    await fetchAndSendVideos(sender_psid, 1, "");
                } else {
                    await fetchAndSendVideos(sender_psid, 1, userText);
                }
            } catch (error) {
                console.error("⚠️ حدث خطأ أثناء معالجة الرسالة:", error?.message);
            }
        });

    } catch (err) {
        console.error("❌ خطأ أثناء الاتصال:", err?.message);
    }
}

connectToWhatsApp();

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

// باقي الدوال (جلب الفيديوهات والضغط) 
async function fetchAndSendVideos(sender_psid, page = 1, searchQuery = "") {
    try {
        let targetUrl = searchQuery !== "" 
            ? `https://www.xvideos.com/?k=${encodeURIComponent(searchQuery)}${page - 1 > 0 ? '&p=' + (page - 1) : ''}` 
            : (page === 1 ? 'https://www.xvideos.com/' : `https://www.xvideos.com/new/${page - 1}/`);
        
        if (page === 1 && searchQuery !== "") await sendTextMessage(sender_psid, `🔍 جاري البحث عن: ${searchQuery}...`);

        const response = await axios.get(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`);
        const $ = cheerio.load(response.data);
        let elements = [];
        
        $('.thumb-block').toArray().slice(0, 9).forEach(element => {
            let title = $(element).find('.title a').attr('title') \vert{}\vert{}$(element).find('.title a').text().trim();
            let link = $(element).find('.title a').attr('href');
            let duration = $(element).find('.duration').text().trim();
            if (title && link) elements.push({ title: title.substring(0, 75) + "..", subtitle: duration ? `المدة: ${duration} ⏱️` : "", link: link.startsWith('http') ? link : 'https://www.xvideos.com' + link });
        });

        if (elements.length > 0) await sendCarouselMessage(sender_psid, elements, page, searchQuery);
        else await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على فيديوهات.");
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ خطأ في الجلب.`);
    }
}

async function fetchQualitiesAndSendOptions(sender_psid, videoUrl) {
    try {
        await sendTextMessage(sender_psid, "⏳ جاري فحص الجودات...");
        const response = await axios.get(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(videoUrl)}`);
        const html = response.data;
        let qualities = [];
        
        let matchLow = html.match(/setVideoUrlLow\('([^']+)'\)/);
        let matchHigh = html.match(/setVideoUrlHigh\('([^']+)'\)/);

        if (matchLow && matchLow[1]) qualities.push({ label: "منخفضة", url: matchLow[1] });
        if (matchHigh && matchHigh[1]) qualities.push({ label: "عالية", url: matchHigh[1] });

        let buttons = [];
        for (let q of qualities) {
            try {
                const headRes = await axios.head(q.url, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
                let sizeMB = headRes.headers['content-length'] ? (headRes.headers['content-length'] / (1024 * 1024)).toFixed(1) : "?";
                buttons.push({ title: `📥 ${q.label} (${sizeMB}M)`, payload: q.url });
            } catch (e) {}
        }
        if (buttons.length > 0) await sendButtonMessage(sender_psid, "✅ تم العثور على الجودات. (انسخ رابط الجودة للتحميل):", buttons);
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ خطأ في فحص الجودات.`);
    }
}

async function downloadAndCompressVideo(sender_psid, directUrl) {
    let originalPath = path.join('/tmp', `orig_${Date.now()}.mp4`);
    let compressedPath = path.join('/tmp', `comp_${Date.now()}.mp4`);

    try {
        await sendTextMessage(sender_psid, "📥 جاري تحميل الفيديو...");
        await downloadFileLocally(directUrl, originalPath);

        const originalSizeMB = fs.statSync(originalPath).size / (1024 * 1024);

        if (originalSizeMB <= 60.0) {
            await sendTextMessage(sender_psid, `🚀 الحجم مناسب (${originalSizeMB.toFixed(1)} MB)! جاري رفعه...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath);
        } else {
            await sendTextMessage(sender_psid, `⚠️ الحجم (${originalSizeMB.toFixed(1)} MB) كبير. جاري ضغطه...`);
            await compressVideoLocally(originalPath, compressedPath, 58.0);
            await sendTextMessage(sender_psid, `🚀 نجح الضغط! جاري الإرسال...`);
            await uploadVideoToWhatsApp(sender_psid, compressedPath);
        }
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ خطأ في التحميل.`);
    } finally {
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
    }
}

function compressVideoLocally(inputPath, outputPath, targetSizeMB) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            let targetVideoBitrate = '300k'; 
            if (!err && metadata?.format?.duration) {
                let vBitrate = Math.floor((targetSizeMB * 8192) / metadata.format.duration) - 128;
                targetVideoBitrate = (vBitrate < 100 ? 100 : vBitrate) + 'k';
            }
            ffmpeg(inputPath)
                .outputOptions(['-y', '-c:v libx264', `-b:v ${targetVideoBitrate}`, '-preset ultrafast', '-threads 2', '-c:a aac', '-b:a 128k', '-movflags +faststart'])
                .save(outputPath).on('end', () => resolve(outputPath)).on('error', reject);
        });
    });
}

async function downloadFileLocally(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 300000 });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
}

async function uploadVideoToWhatsApp(sender_psid, filePath) {
    await sock.sendMessage(sender_psid, { video: { url: filePath }, mimetype: 'video/mp4' });
}

async function sendTextMessage(sender_psid, text) { await sock.sendMessage(sender_psid, { text: text }); }
async function sendButtonMessage(sender_psid, text, buttons) {
    let msg = `${text}\n\n`; buttons.forEach(b => msg += `✨ ${b.title}\n🔗 ${b.payload}\n\n`);
    await sock.sendMessage(sender_psid, { text: msg });
}
async function sendCarouselMessage(sender_psid, elements, currentPage, searchQuery) {
    let msg = "✨ الفيديوهات المتاحة (انسخ الرابط وأرسله):\n\n";
    elements.forEach((el, index) => msg += `🎬 ${index + 1}. ${el.title}\n${el.subtitle}\n🔗 ${el.link}\n\n`);
    msg += `🔄 للمزيد أرسل:\nLOAD_MORE|${currentPage + 1}|${searchQuery}`;
    await sock.sendMessage(sender_psid, { text: msg });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`); });
