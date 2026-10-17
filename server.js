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

app.get('/', (req, res) => res.send('🤖 WhatsApp Bot is Awake (RAM Optimized)!'));
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
                        userLocks.set(sender_psid, `تحميل الفيديو ${num}`);
                        await downloadAndSendVideo(sender_psid, session.qualities[num - 1], session.selectedVideo);
                    } else await sendTextMessage(sender_psid, "❌ الرقم غير موجود ضمن الخيارات المعروضة.");
                } else if (lowerText === 'nex') {
                    if (session && session.searchPage !== undefined) {
                        let nextP = session.searchPage + 1;
                        userLocks.set(sender_psid, `جلب صفحة ${nextP}`);
                        await fetchAndSendVideos(sender_psid, nextP, session.searchQuery);
                    } else await sendTextMessage(sender_psid, "❌ لا يوجد بحث سابق لعرض المزيد.");
                } else {
                    let isWelcome = userText === 'مرحبا';
                    let isHi = lowerText === 'hi';
                    if (isWelcome ? true : isHi) {
                        userLocks.set(sender_psid, 'جلب الرئيسية');
                        await fetchAndSendVideos(sender_psid, 1, "");
                    } else if (userText.startsWith('http')) {
                        await sendTextMessage(sender_psid, "❌ البوت يعمل عبر البحث المباشر فقط.");
                    } else {
                        let finalQuery = userText;
                        if (lowerText === 'a') finalQuery = 'anal';
                        if (lowerText === 's') finalQuery = 'sex';
                        if (lowerText === 'p') finalQuery = 'porn';
                        userLocks.set(sender_psid, `البحث عن "${finalQuery}"`);
                        await fetchAndSendVideos(sender_psid, 1, finalQuery);
                    }
                }
            } catch (error) {} finally { userLocks.delete(sender_psid); }
        });
    } catch (err) {}
}

connectToWhatsApp();

process.on('uncaughtException', (err) => { console.error("🔥 uncaughtException:\n", getRealError(err)); });
process.on('unhandledRejection', async (reason) => {
    let errStr = String(reason);
    if (errStr.includes('_deserialize_chains') || errStr.includes('Cannot convert undefined')) {
        try { await axios.delete(`${FIREBASE_DB_URL}.json`); } catch(e){}
        process.exit(1); 
    }
});

async function sendLinkDetails(sender_psid, item, indexNum) {
    try {
        let channelName = item.channel;
        if (!channelName ? true : channelName === "غير متوفر") {
            try {
                const html = await fetchHtmlSmart(item.link, SCRAPER_API_KEY);
                let uploaderMatch = html.match(/setUploaderName\(['"]([^'"]+)['"]\)/);
                if (uploaderMatch && uploaderMatch[1]) channelName = uploaderMatch[1];
            } catch (innerErr) {}
        }
        let finalChannel = channelName ? channelName : 'غير متوفر';
        const msg = `📌 *تفاصيل الخيار [ ${indexNum} ]:*\n\n📝 *العنوان:* ${item.title}\n📺 *القناة:* ${finalChannel}\n⏱️ *المدة:* ${item.duration}\n🔗 *الرابط:* ${item.link}`;
        await sendTextMessage(sender_psid, msg);
    } catch (err) {}
}

async function fetchAndSendVideos(sender_psid, page = 1, searchQuery = "") {
    try {
        let targetUrl = 'https://www.xvideos.com/';
        if (searchQuery !== "") {
            let p = page - 1;
            targetUrl = `https://www.xvideos.com/?k=${encodeURIComponent(searchQuery)}`;
            if (p > 0) targetUrl = targetUrl + '&p=' + p;
        } else if (page > 1) {
            let p = page - 1;
            targetUrl = `https://www.xvideos.com/new/${p}/`;
        }

        let searchLabel = searchQuery !== "" ? `(${searchQuery})` : `الرئيسية`;
        await sendTextMessage(sender_psid, `⚡ جاري البحث عن ${searchLabel} - صفحة ${page}...`);

        const htmlData = await fetchHtmlSmart(targetUrl, SCRAPER_API_KEY);
        const $ = cheerio.load(htmlData);
        let elements = [];
        
        $('.thumb-block').toArray().forEach(element => {
            if (elements.length >= 10) return;
            let titleEl = $(element).find('.title a');
            let link = titleEl.attr('href');
            let titleAttr = titleEl.attr('title');
            let titleText = titleEl.text().trim();
            let title = titleAttr ? titleAttr : (titleText ? titleText : "بدون عنوان");
            let durationText = $(element).find('.duration').text().trim();
            let duration = durationText ? durationText : "غير محدد";
            let ch1 = $(element).find('.metadata .name').text().trim();
            let ch2 = $(element).find('.uploader .name').text().trim();
            let ch3 = $(element).find('.name').first().text().trim();
            let channel = ch1 ? ch1 : (ch2 ? ch2 : (ch3 ? ch3 : "غير متوفر"));
            let imgUrl = $(element).find('.thumb img').attr('data-src');
            if (!imgUrl) imgUrl = $(element).find('.thumb img').attr('src');
            
            if (link && imgUrl && link.includes('/video')) {
                let fullLink = link.startsWith('http') ? link : 'https://www.xvideos.com' + link;
                elements.push({ link: fullLink, title: title, channel: channel, duration: duration, image: imgUrl });
            }
        });

        if (elements.length > 0) {
            userSessions.set(sender_psid, { type: 'search', items: elements, searchPage: page, searchQuery: searchQuery });
            for (let i = 0; i < elements.length; i++) {
                try { await sock.sendPresenceUpdate('composing', sender_psid); } catch (e) {}
                await sock.sendMessage(sender_psid, { image: { url: elements[i].image }, caption: `🎬 خيار رقم [ ${i + 1} ]\n⏱️ المدة: ${elements[i].duration}` });
                await delay(800);
            }
            await sendTextMessage(sender_psid, `✅ تم عرض ${elements.length} فيديوهات!\n\n📥 *للتحميل:* أرسل رقم الفيديو\n🔗 *للتفاصيل:* أرسل الرقم مع كلمة link (مثال: 2 link)\n⏭️ *للمزيد:* أرسل nex`);
        } else await sendTextMessage(sender_psid, `❌ لم يتم العثور على فيديوهات.`);
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ الخطأ أثناء البحث:\n${getRealError(error)}`);
    }
}

async function fetchQualitiesAndSendOptions(sender_psid, videoItem) {
    try {
        await sendTextMessage(sender_psid, "⏳ جاري استخراج الجودات...");
        let sessionQualities = [];
        
        // المحرك الأساسي (yt-dlp)
        try {
            const info = await youtubedl(videoItem.link, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                referer: 'https://www.xvideos.com/'
            });

            if (info && info.formats) {
                let seenHeights = {};
                info.formats.forEach(f => {
                    let h = f.height;
                    let url = f.url;
                    if (h && url && h >= 144 && f.vcodec !== 'none') {
                        if (!seenHeights[h]) {
                            seenHeights[h] = true;
                            let sizeMB = "?";
                            if (f.filesize) sizeMB = (f.filesize / 1048576).toFixed(1);
                            else if (f.filesize_approx) sizeMB = (f.filesize_approx / 1048576).toFixed(1);
                            
                            sessionQualities.push({ 
                                label: `${h}p`, url: url, sizeMB: sizeMB, 
                                isYtDlp: true, format_id: f.format_id, height: h 
                            });
                        }
                    }
                });
            }
        } catch (ytErr) { console.log("⚠️ فشل محرك yt-dlp، جاري التحويل للمحرك اليدوي..."); }

        // الخطة البديلة (Scraping)
        if (sessionQualities.length === 0) {
            const html = await fetchHtmlSmart(videoItem.link, SCRAPER_API_KEY);
            let durationSec = 0;
            let durMatch = html.match(/setVideoDuration\((\d+(?:\.\d+)?)\)/);
            if (durMatch && durMatch[1]) durationSec = parseFloat(durMatch[1]);

            let matchHLS = html.match(/setVideoHLS\(['"]([^'"]+)['"]\)/);
            if (matchHLS && matchHLS[1]) {
                const hlsMasterUrl = matchHLS[1];
                const baseUrl = hlsMasterUrl.substring(0, hlsMasterUrl.lastIndexOf('/') + 1);
                try {
                    const m3u8Res = await axios.get(hlsMasterUrl, { headers: BROWSER_HEADERS, httpsAgent, timeout: 20000 });
                    const lines = String(m3u8Res.data).split('\n');
                    let pendingInfo = null;
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (line.startsWith('#EXT-X-STREAM-INF:')) {
                            let resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                            let bwMatch = line.match(/BANDWIDTH=(\d+)/);
                            let height = resMatch && resMatch[1] ? parseInt(resMatch[1]) : 0;
                            let bandwidth = bwMatch && bwMatch[1] ? parseInt(bwMatch[1]) : 0;
                            pendingInfo = { label: `${height}p`, height, bandwidth };
                        } else if (line && !line.startsWith('#') && pendingInfo) {
                            let streamUrl = line.startsWith('http') ? line : baseUrl + line;
                            let sizeMB = "?";
                            if (pendingInfo.bandwidth > 0 && durationSec > 0) sizeMB = ((pendingInfo.bandwidth * durationSec) / (8 * 1024 * 1024)).toFixed(1);
                            sessionQualities.push({ label: pendingInfo.label, url: streamUrl, sizeMB: sizeMB, isYtDlp: false, isHLS: true, height: pendingInfo.height });
                            pendingInfo = null;
                        }
                    }
                } catch (hlsErr) {}
            }

            if (sessionQualities.length === 0) {
                let matchLow = html.match(/setVideoUrlLow\(['"]([^'"]+)['"]\)/);
                let matchHigh = html.match(/setVideoUrlHigh\(['"]([^'"]+)['"]\)/);
                if (matchLow && matchLow[1]) sessionQualities.push({ label: "360p (SD)", url: matchLow[1], sizeMB: "?", isYtDlp: false, isHLS: false, height: 360 });
                if (matchHigh && matchHigh[1]) sessionQualities.push({ label: "720p (HD)", url: matchHigh[1], sizeMB: "?", isYtDlp: false, isHLS: false, height: 720 });
            }
        }

        sessionQualities.sort((a, b) => a.height - b.height);

        if (sessionQualities.length > 0) {
            let currentSession = userSessions.get(sender_psid);
            userSessions.set(sender_psid, {
                type: 'quality', qualities: sessionQualities, selectedVideo: videoItem,
                items: currentSession ? currentSession.items : [],
                searchPage: currentSession ? currentSession.searchPage : 1,
                searchQuery: currentSession ? currentSession.searchQuery : ""
            });
            
            let msg = `✅ *الجودات المتاحة (${sessionQualities.length}):*\nأرسل الرقم للتحميل:\n\n`;
            sessionQualities.forEach((q, index) => { msg += `*[ ${index + 1} ]* 📥 جودة ${q.label} — (الحجم: ${q.sizeMB}MB)\n`; });
            await sendTextMessage(sender_psid, msg);
        } else await sendTextMessage(sender_psid, `❌ فشل استخراج الجودات.`);
    } catch (error) {
        await sendTextMessage(sender_psid, `❌ الخطأ الأصلي:\n${getRealError(error)}`);
    }
}

async function downloadAndSendVideo(sender_psid, qualityObj, videoItem) {
    const timestamp = Date.now();
    let originalPath = path.join('/tmp', `vid_${timestamp}.mp4`);
    let thumbPath = path.join('/tmp', `thumb_${timestamp}.jpg`);
    let rawTsPath = path.join('/tmp', `raw_${timestamp}.ts`);

    try {
        await sendTextMessage(sender_psid, `📥 جاري التحميل (${qualityObj.label})... يرجى الانتظار.`);

        if (qualityObj.isYtDlp && qualityObj.format_id) {
            await youtubedl(videoItem.link, {
                format: `${qualityObj.format_id}+bestaudio/best`, 
                mergeOutputFormat: 'mp4',
                output: originalPath,
                noWarnings: true,
                noCheckCertificates: true,
                referer: 'https://www.xvideos.com/',
                ffmpegLocation: ffmpegStatic 
            });
        } else if (qualityObj.isHLS) {
            await downloadHLSInNode(qualityObj.url, rawTsPath, originalPath);
        } else {
            await downloadFileLocally(qualityObj.url, originalPath);
        }

        if (!fs.existsSync(originalPath)) throw new Error("ملف الفيديو غير موجود.");

        const fileSizeMB = fs.statSync(originalPath).size / (1024 * 1024);
        
        // 🌟 الخدعة الذكية لحماية الرام (إرسال كملف إذا كان كبيراً لعدم استخدام FFmpeg للضغط)
        if (fileSizeMB <= 60.0) {
            await sendTextMessage(sender_psid, `⚡ اكتمل التحميل (${fileSizeMB.toFixed(1)}MB)! جاري الإرسال كفيديو...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath, null, videoItem, qualityObj.label, false);
        } else {
            await sendTextMessage(sender_psid, `⚠️ الفيديو بحجم (${fileSizeMB.toFixed(1)}MB).\n🚀 لتجنب انهيار السيرفر، جاري إرساله كـ "ملف" (Document)...`);
            await uploadVideoToWhatsApp(sender_psid, originalPath, null, videoItem, qualityObj.label, true);
        }

    } catch (error) {
        console.error("❌ خطأ التحميل:", getRealError(error));
        await sendTextMessage(sender_psid, `❌ حدث خطأ أثناء التحميل.`);
    } finally {
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        if (fs.existsSync(rawTsPath)) fs.unlinkSync(rawTsPath);

        let currentSession = userSessions.get(sender_psid);
        if (currentSession && currentSession.items) {
            userSessions.set(sender_psid, { type: 'search', items: currentSession.items, searchPage: currentSession.searchPage, searchQuery: currentSession.searchQuery });
        } else userSessions.delete(sender_psid);
    }
}

// 🌟 تحميل الشرائح باستخدام Streams لعدم استهلاك الرام (0MB استهلاك!)
async function downloadHLSInNode(subM3u8Url, rawTsPath, outputMp4Path) {
    const baseUrl = subM3u8Url.substring(0, subM3u8Url.lastIndexOf('/') + 1);
    const playlistRes = await axios.get(subM3u8Url, { headers: BROWSER_HEADERS, httpsAgent, timeout: 20000 });
    const lines = String(playlistRes.data).split('\n');
    const segmentUrls = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) segmentUrls.push(line.startsWith('http') ? line : baseUrl + line);
    }
    
    const writer = fs.createWriteStream(rawTsPath);
    for (let i = 0; i < segmentUrls.length; i++) {
        try {
            const segRes = await axios.get(segmentUrls[i], { headers: BROWSER_HEADERS, httpsAgent, responseType: 'stream', timeout: 30000 });
            await new Promise((resolve, reject) => {
                segRes.data.pipe(writer, { end: false });
                segRes.data.on('end', resolve);
                segRes.data.on('error', reject);
            });
        } catch (e) { console.warn("⚠️ تخطي شريحة تالفة."); }
    }
    writer.end();
    await new Promise(resolve => writer.on('finish', resolve));

    // دمج بدون استخدام ميزة faststart الثقيلة على الرام
    await new Promise((resolve, reject) => {
        ffmpeg(rawTsPath).outputOptions(['-y', '-c', 'copy', '-bsf:a', 'aac_adtstoasc']).save(outputMp4Path).on('end', () => resolve(outputMp4Path)).on('error', reject);
    });
}

async function downloadFileLocally(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({ url, method: 'GET', headers: BROWSER_HEADERS, responseType: 'stream', timeout: 300000, httpsAgent });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
}

async function uploadVideoToWhatsApp(sender_psid, filePath, thumbPath, videoItem, qualityLabel, sendAsDocument) {
    const captionText = `✅ *تم التحميل بنجاح*\n🎞️ الجودة: ${qualityLabel}\n⏱️ المدة: ${videoItem ? videoItem.duration : ''}`;
    
    if (sendAsDocument) {
        await sock.sendMessage(sender_psid, {
            document: { url: filePath },
            mimetype: 'video/mp4',
            fileName: `${qualityLabel}_Video.mp4`,
            caption: captionText
        });
    } else {
        await sock.sendMessage(sender_psid, {
            video: { url: filePath },
            mimetype: 'video/mp4',
            caption: captionText
        });
    }
}

async function sendTextMessage(sender_psid, text) { await sock.sendMessage(sender_psid, { text: text }); }

const PORT = process.env.PORT ? process.env.PORT : 8080;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 السيرفر يعمل بأقصى سرعة على المنفذ ${PORT}`); 
    setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/`); } catch (e) {} }, 4 * 60 * 1000);
});
