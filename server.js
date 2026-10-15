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

// 🌟 ذاكرة البوت الذكية لتخزين نتائج البحث للمستخدمين
const userSessions = new Map();

app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Running (Premium Version)!'));

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

// المحول الذكي لحفظ جلسة واتساب في Firebase
async function useFirebaseAuthState() {
    const readData = async (path) => {
        try {
            const res = await axios.get(`${FIREBASE_DB_URL}/${path}.json`);
            if (res.data) {
                return JSON.parse(JSON.stringify(res.data), BufferJSON.reviver);
            }
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
                        const safeId = encodeURIComponent(id).replace(/\./g, '%2E');
                        let value = await readData(`keys/${type}-${safeId}`);
                        if (type === 'app-state-sync-key') {
                            if (value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
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
                            if (value) {
                                tasks.push(writeData(keyPath, value));
                            } else {
                                tasks.push(removeData(keyPath));
                            }
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
            browser: ['WhatsApp Bot', 'Chrome', '1.0.0']
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
                    let errStr = "";
                    if (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) {
                        errStr = String(lastDisconnect.error.message);
                    }
                    let hasBadMac = errStr.includes('Bad MAC');
                    let hasDecrypt = errStr.includes('decrypt');

                    if (hasBadMac) {
                        console.log('🔄 تلف في الجلسة. جاري مسحها لطلب كود جديد...');
                        await clearSession();
                    } else if (hasDecrypt) {
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
                console.log('✅ تم ربط واتساب بنجاح!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            const sender_psid = msg.key.remoteJid;
            
            let userText = "";
            if (msg.message.conversation) {
                userText = msg.message.conversation;
            } else if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) {
                userText = msg.message.extendedTextMessage.text;
            }
            userText = userText.trim();

            if (!userText) return;
            console.log(`📩 رسالة من ${sender_psid}: "${userText}"`);

            try {
                let num = parseInt(userText);
                let session = userSessions.get(sender_psid);

                if (!isNaN(num) && num >= 1 && num <= 5 && session) {
                    if (session.type === 'search' && session.urls[num - 1]) {
                        await fetchQualitiesAndSendOptions(sender_psid, session.urls[num - 1]);
                    } else if (session.type === 'quality' && session.qualities[num - 1]) {
                        await downloadAndCompressVideo(sender_psid, session.qualities[num - 1].url);
                    } else {
                        await sendTextMessage(sender_psid, "❌ خيار غير صالح. يرجى التأكد من الرقم.");
                    }
                    return;
                }

                if (userText === 'التالي' && session && session.type === 'search') {
                    await fetchAndSendVideos(sender_psid, session.page + 1, session.searchQuery);
                    return;
                }

                let isHi = userText.toLowerCase() === 'hi';
                if (userText === 'مرحبا') {
                    await fetchAndSendVideos(sender_psid, 1, "");
                } else if (isHi) {
                    await fetchAndSendVideos(sender_psid, 1, "");
                } else if (userText.startsWith('http')) {
                    await sendTextMessage(sender_psid, "❌ عذراً، البوت يقبل أسماء البحث فقط وليس الروابط.");
                } else {
                    await fetchAndSendVideos(sender_psid, 1, userText);
                }

            } catch (error) {
                let errMsg = error ? error.message : "خطأ غير معروف";
                console.error("⚠️ حدث خطأ:", errMsg);
            }
        });

    } catch (err) {
        let errMsg = err ? err.message : "خطأ غير معروف";
        console.error("❌ خطأ أثناء الاتصال:", errMsg);
    }
}

connectToWhatsApp();

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

// 🌟 دالة الجلب الاحترافية (صور + مدة فقط)
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
        
        if (page === 1) {
            await sendTextMessage(sender_psid, `🔍 جاري البحث وتجهيز الصور...`);
        }

        const response = await axios.get(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}`);
        const $ = cheerio.load(response.data);
        let elements = [];
        
        // جلب 5 فيديوهات فقط
        $('.thumb-block').toArray().slice(0, 5).forEach(element => {
            let link = $(element).find('.title a').attr('href');
            let durationText = $(element).find('.duration').text().trim();
            let duration = durationText ? durationText : "غير محدد";
            
            let imgUrl = $(element).find('.thumb img').attr('data-src');
            if (!imgUrl) {
                imgUrl = $(element).find('.thumb img').attr('src');
            }
            
            if (link && imgUrl) {
                let fullLink = link.startsWith('http') ? link : 'https://www.xvideos.com' + link;
                elements.push({
                    link: fullLink,
                    duration: duration,
                    image: imgUrl
                });
            }
        });

        if (elements.length > 0) {
            let urls = [];
            elements.forEach(e => urls.push(e.link));
            userSessions.set(sender_psid, { type: 'search', urls: urls, page: page, searchQuery: searchQuery });

            for (let i = 0; i < elements.length; i++) {
                await sock.sendMessage(sender_psid, {
                    image: { url: elements[i].image },
                    caption: `🎬 خيار رقم [ ${i + 1} ]\n⏱️ المدة: ${elements[i].duration}`
                });
            }

            await sendTextMessage(sender_psid, `✨ للتحميل: أرسل رقم الخيار (مثال: 1)\n🔄 للمزيد: أرسل كلمة "التالي"`);
        } else {
            await sendTextMessage(sender_psid, "❌ لم أتمكن من العثور على نتائج.");
        }
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ حدث خطأ في النظام.`);
    }
}

// 🌟 دالة اختيار الجودة الاحترافية بالأرقام
async function fetchQualitiesAndSendOptions(sender_psid, videoUrl) {
    try {
        await sendTextMessage(sender_psid, "⏳ جاري فحص الجودات...");
        const response = await axios.get(`https://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(videoUrl)}`);
        const html = response.data;
        let qualities = [];
        
        let matchLow = html.match(/setVideoUrlLow\('([^']+)'\)/);
        let matchHigh = html.match(/setVideoUrlHigh\('([^']+)'\)/);

        if (matchLow && matchLow[1]) {
            qualities.push({ label: "جودة منخفضة", url: matchLow[1] });
        }
        if (matchHigh && matchHigh[1]) {
            qualities.push({ label: "جودة عالية", url: matchHigh[1] });
        }

        let sessionQualities = [];
        for (let q of qualities) {
            try {
                const headRes = await axios.head(q.url, { httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }) });
                let sizeBytes = headRes.headers['content-length'];
                let sizeMB = "?";
                if (sizeBytes) {
                    sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
                }
                sessionQualities.push({ label: q.label, url: q.url, sizeMB: sizeMB });
            } catch (e) {}
        }

        if (sessionQualities.length > 0) {
            userSessions.set(sender_psid, { type: 'quality', qualities: sessionQualities });
            
            let msg = "✅ الجودات المتاحة. أرسل رقم الجودة للتحميل:\n\n";
            sessionQualities.forEach((q, index) => {
                msg += `[ ${index + 1} ] 📥 ${q.label} (الحجم: ${q.sizeMB}M)\n`;
            });
            await sendTextMessage(sender_psid, msg);
        } else {
            await sendTextMessage(sender_psid, "❌ خطأ في قراءة الفيديو.");
        }
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ فشل في فحص الجودات.`);
    }
}

// محرك التحميل والضغط الذكي
async function downloadAndCompressVideo(sender_psid, directUrl) {
    let originalPath = path.join('/tmp', `orig_${Date.now()}.mp4`);
    let compressedPath = path.join('/tmp', `comp_${Date.now()}.mp4`);

    try {
        await sendTextMessage(sender_psid, "📥 جاري التحميل... يرجى الانتظار");
        await downloadFileLocally(directUrl, originalPath);

        const originalSizeMB = fs.statSync(originalPath).size / (1024 * 1024);

        if (originalSizeMB <= 60.0) {
            await uploadVideoToWhatsApp(sender_psid, originalPath);
        } else {
            await sendTextMessage(sender_psid, `⚠️ الفيديو كبير، جاري ضغطه ليتناسب مع واتساب...`);
            await compressVideoLocally(originalPath, compressedPath, 58.0);
            await uploadVideoToWhatsApp(sender_psid, compressedPath);
        }
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ حدث خطأ أثناء إرسال الفيديو.`);
    } finally {
        if (fs.existsSync(originalPath)) {
            fs.unlinkSync(originalPath);
        }
        if (fs.existsSync(compressedPath)) {
            fs.unlinkSync(compressedPath);
        }
    }
}

function compressVideoLocally(inputPath, outputPath, targetSizeMB) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            let targetVideoBitrate = '300k'; 
            let hasDuration = metadata && metadata.format && metadata.format.duration;
            if (!err && hasDuration) {
                let vBitrate = Math.floor((targetSizeMB * 8192) / metadata.format.duration) - 128;
                let finalBitrate = vBitrate < 100 ? 100 : vBitrate;
                targetVideoBitrate = finalBitrate + 'k';
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
    await sendTextMessage(sender_psid, "✅ اكتمل التحميل بنجاح!");
}

async function sendTextMessage(sender_psid, text) { 
    await sock.sendMessage(sender_psid, { text: text }); 
}

const PORT = process.env.PORT ? process.env.PORT : 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 السيرفر يعمل على المنفذ ${PORT}`); });
