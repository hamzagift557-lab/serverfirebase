require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', true);

const corsOptions = {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json());

app.get('/', (req, res) => {
    res.status(200).send('Server is up and running!');
});

// 🔥 دالة الحماية ضد ثغرات XSS (Sanitization)
// تقوم بتحويل أي أكواد HTML أو Javascript مدخلة إلى نصوص عادية غير ضارة
const sanitizeText = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
};

const getClientIp = (req) => {
    if (req.headers['fly-client-ip']) return req.headers['fly-client-ip'];
    if (req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
    return req.ip;
};

const limitMessage = { success: false, message: "فشل إرسال الطلب، يوجد ضغط على السيرفرات. تفضل بالانتظار قليلاً." };

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 200, 
    message: limitMessage,
    standardHeaders: true, 
    legacyHeaders: false,
    keyGenerator: getClientIp
});
app.use('/api/', apiLimiter);

const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 20, 
    message: limitMessage,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getClientIp
});

app.use('/api/login', strictLimiter);
app.use('/api/app/verify-key', strictLimiter);
app.use('/api/app/delete-account', strictLimiter);
app.use('/api/app/set-account-status', strictLimiter);
app.use('/api/app/edit-account', strictLimiter);

let db = null;
let s3Client = null;

const generateSecureKey = () => crypto.randomBytes(25).toString('hex');

const getCurrentLocalTime = () => {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    return d;
};

const getFormattedDate = () => {
    const d = getCurrentLocalTime();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://hamza-f798c-default-rtdb.firebaseio.com"
        });
        db = admin.database();
        
        db.ref('keys').once('value', snapshot => {
            if (!snapshot.exists()) console.warn("⚠️ [Security] لا توجد مفاتيح في قاعدة البيانات.");
        });

        db.ref('acc').once('value', async (snap) => {
            if (snap.exists()) {
                const accs = snap.val();
                let updates = {};
                for (let id in accs) {
                    if (id !== "bot_menu") {
                        if (!accs[id].key) {
                            updates[`acc/${id}/key`] = id;
                            if (accs[id].seller) updates[`sellers_data/${accs[id].seller}/${id}/key`] = id;
                        }
                        if (accs[id].push === undefined) {
                            updates[`acc/${id}/push`] = true;
                            if (accs[id].seller) updates[`sellers_data/${accs[id].seller}/${id}/push`] = true;
                        }
                    }
                }
                if (Object.keys(updates).length > 0) {
                    await db.ref().update(updates);
                    console.log("✅ [System] تم التحديث بنجاح.");
                }
            }
        });
    }
} catch (error) { console.error("Firebase Error:", error.message); }

try {
    if (process.env.R2_ACCESS_KEY_ID) {
        s3Client = new S3Client({
            region: "auto",
            endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        });
    }
} catch (error) { console.error("R2 Error:", error.message); }

// حجم الصورة الأقصى 15 ميجابايت مع فلترة الأنواع
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg'];
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح، يرجى رفع صورة فقط.'), false);
        }
    }
});

let keysCache = null;
let lastKeysFetch = 0;
let keysPromise = null;

async function verifySeller(sellerKey) {
    if (!sellerKey) return null;
    const now = Date.now();
    if (keysCache && (now - lastKeysFetch < 5 * 60 * 1000)) {
        return Object.keys(keysCache).find(name => keysCache[name] === sellerKey);
    }
    if (!keysPromise) {
        keysPromise = db.ref('keys').once('value').then(snap => {
            keysCache = snap.val() || {};
            lastKeysFetch = Date.now();
            keysPromise = null;
            return keysCache;
        }).catch(() => {
            keysPromise = null;
            return keysCache || {};
        });
    }
    const keys = await keysPromise || keysCache;
    return Object.keys(keys || {}).find(name => keys[name] === sellerKey);
}

let publicAccountsCache = null;
let lastPublicFetch = 0;
let fetchPromise = null;

app.get('/api/public/accounts', async (req, res) => {
    try {
        const now = Date.now();
        if (publicAccountsCache && (now - lastPublicFetch < 5 * 60 * 1000)) { 
            return res.json({ success: true, accounts: publicAccountsCache });
        }
        
        if (!fetchPromise) {
            fetchPromise = db.ref('acc').once('value').then(snapshot => {
                const data = snapshot.val() || {};
                publicAccountsCache = Object.keys(data).map(key => ({
                    key: key,
                    ...data[key]
                })).filter(acc => acc.status !== 'delete');
                lastPublicFetch = Date.now();
                fetchPromise = null;
                return publicAccountsCache;
            }).catch(err => {
                fetchPromise = null;
                throw err;
            });
        }
        
        const accounts = await fetchPromise || publicAccountsCache;
        res.json({ success: true, accounts });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

async function sendUpdatedActiveAccounts(res, sellerName) {
    const snapshot = await db.ref(`sellers_data/${sellerName}`).once('value');
    const data = snapshot.val() || {};
    let totalViews = 0; 
    const accountsArray = Object.keys(data).map(key => {
        totalViews += (parseInt(data[key].view) || 0); 
        return { key: key, ...data[key] };
    }).filter(acc => acc.status !== 'delete');

    accountsArray.sort((a, b) => {
        const order = { 'available': 1, 'att': 2, 'sold': 3 };
        const stA = order[a.status] || 4;
        const stB = order[b.status] || 4;
        if (stA !== stB) return stA - stB;
        if (a.status === 'sold') {
            const parseD = (d) => {
                if(!d) return 0;
                const p = d.split(/[ \-:]/); 
                if(p.length >= 5) return new Date(p[2], p[1]-1, p[0], p[3], p[4]).getTime();
                return 0;
            }
            return parseD(b.sell_date) - parseD(a.sell_date);
        }
        if (a.status === 'available' || a.status === 'att') {
            const pA = parseFloat(a.bank_price) || 0;
            const pB = parseFloat(b.bank_price) || 0;
            return pB - pA;
        }
        return 0;
    });

    return res.json({ view_day: totalViews, accounts: accountsArray });
}

async function getUpdatedRequestsArray(sellerName) {
    const reqSnap = await db.ref('Requests')
        .orderByChild('seller')
        .equalTo(sellerName)
        .once('value');
        
    const requests = reqSnap.val() || {};
    const reqArray = Object.keys(requests).map(k => ({ key: k, ...requests[k] }));
    
    reqArray.sort((a, b) => {
        const isAPending = a.status === 'pending' ? 1 : 0;
        const isBPending = b.status === 'pending' ? 1 : 0;
        if (isAPending !== isBPending) return isBPending - isAPending; 
        return (b.timestamp || 0) - (a.timestamp || 0);
    });
    return reqArray;
}

app.post('/api/increment-view', async (req, res) => {
    const { seller, id } = req.body;
    if (!seller || !id) return res.json({ success: false });
    try {
        await db.ref(`acc/${id}/view`).set(admin.database.ServerValue.increment(1));
        await db.ref(`sellers_data/${seller}/${id}/view`).set(admin.database.ServerValue.increment(1));
        res.json({ success: true });
    } catch (error) { res.json({ success: false, message: error.message }); }
});

app.post('/api/login', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "السيرفر غير متصل" });
    const { sellerKey } = req.body;
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const infoRef = db.ref(`information de clien/${sellerName}`);
            const infoSnap = await infoRef.once('value');
            if (!infoSnap.exists()) await infoRef.set({ email: "", link: "", json: "[]" });
            res.json({ success: true, sellerName });
        } else {
            res.status(401).json({ success: false, message: "المفتاح غير صحيح" });
        }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/upload-image', (req, res, next) => {
    upload.single('image')(req, res, function (err) {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    if (!s3Client) return res.status(500).json({ success: false, message: "Cloudflare R2 غير متصل" });
    const { sellerKey } = req.body; 
    try {
        const isValid = await verifySeller(sellerKey);
        if (!isValid) return res.status(401).json({ success: false, message: "غير مصرح برفع الصور" });

        const file = req.file;
        if (!file) return res.status(400).json({ success: false, message: "لم يتم إرسال أي صورة" });
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random()*1000)}.${file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: file.buffer, ContentType: file.mimetype }));
        res.json({ success: true, imageUrl: `${process.env.R2_PUBLIC_URL}/${fileName}` });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/save-account', async (req, res) => {
    try {
        const { id, sellerKey, title, desc, email, password, bankPrice, webPrice, price_bot, isGg, isGameCenter, imgUrl, img, img2, img3, limit, push } = req.body;
        if (!sellerKey || !title) return res.status(400).json({ success: false, message: "بيانات ناقصة" });

        const sellerName = await verifySeller(sellerKey);
        if (!sellerName) return res.status(401).json({ success: false, message: "مفتاح البائع غير صحيح" });

        const primaryImg = img || imgUrl;
        if (!primaryImg) return res.status(400).json({ success: false, message: "صورة أساسية مطلوبة" });

        // تنظيف النصوص من XSS
        const safeTitle = sanitizeText(title);
        const safeDesc = sanitizeText(desc || "");
        const safePriceBot = sanitizeText(price_bot || "");
        const safeLimit = sanitizeText(limit || "");

        const publicData = { 
            seller: sellerName, title: safeTitle, desc: safeDesc, bank_price: bankPrice || 0, price_web: webPrice, price_bot: safePriceBot, 
            gg: isGg || false, game_center: isGameCenter || false, img: primaryImg, img2: img2 || "", img3: img3 || "", limit: safeLimit 
        };
        if (push !== undefined) publicData.push = push; else if (!id) publicData.push = true; 

        const privateData = { ...publicData, email: email || "", password: password || "" };

        if (id) {
            const ownershipSnap = await db.ref(`sellers_data/${sellerName}/${id}`).once('value');
            if (!ownershipSnap.exists()) return res.status(403).json({ success: false, message: "هذا الحساب لا يخصك" });

            await db.ref(`acc/${id}`).update(publicData);
            await db.ref(`sellers_data/${sellerName}/${id}`).update(privateData);
        } else {
            const today = getCurrentLocalTime(); 
            const timestamp = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
            const newId = generateSecureKey();
            
            publicData.view = 0; publicData.key = newId; privateData.view = 0; privateData.key = newId;
            publicData.timestamp = timestamp; publicData.status = "available"; privateData.timestamp = timestamp; privateData.status = "available";

            const updates = {};
            updates[`acc/${newId}`] = publicData;
            updates[`sellers_data/${sellerName}/${newId}`] = privateData;
            await db.ref().update(updates);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/update-status', async (req, res) => {
    const { id, status, sellerName, sellerKey } = req.body;
    try {
        const validSeller = await verifySeller(sellerKey);
        if (!validSeller || validSeller !== sellerName) return res.status(401).json({ success: false, message: "غير مصرح لك بتعديل هذا الحساب" });

        const ownershipSnap = await db.ref(`sellers_data/${sellerName}/${id}`).once('value');
        if (!ownershipSnap.exists()) return res.status(403).json({ success: false, message: "هذا الحساب لا يخصك" });

        const updates = {};
        updates[`acc/${id}/status`] = status;
        updates[`sellers_data/${sellerName}/${id}/status`] = status;
        await db.ref().update(updates);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/mark-sold', async (req, res) => {
    const { id, sellerName, sellPrice, price_bot, sellerKey } = req.body;
    try {
        const validSeller = await verifySeller(sellerKey);
        if (!validSeller || validSeller !== sellerName) return res.status(401).json({ success: false, message: "غير مصرح لك" });

        const accRef = db.ref(`sellers_data/${sellerName}/${id}`);
        const snapshot = await accRef.once('value');

        if (snapshot.exists()) {
            const accData = snapshot.val();
            const finalPrice = sellPrice && String(sellPrice).trim() !== "" ? parseFloat(sellPrice) : parseFloat(accData.price_web);
            const today = getCurrentLocalTime(); 
            const sellDate = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()} ${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
            
            const soldData = { ...accData, status: 'sold', sell_date: sellDate, final_sell_price: finalPrice };
            
            const safePriceBot = sanitizeText(price_bot || "");
            if (price_bot !== undefined) soldData.price_bot = safePriceBot;

            const updates = {};
            updates[`acc/${id}`] = null; 
            updates[`sellers_data/${sellerName}/${id}/status`] = 'sold';
            updates[`sellers_data_sold/${sellerName}/${id}`] = soldData;
            if (price_bot !== undefined) updates[`sellers_data/${sellerName}/${id}/price_bot`] = safePriceBot;

            await db.ref().update(updates);
            res.json({ success: true });
        } else { res.status(404).json({ success: false, message: "الحساب غير موجود أو لا يخصك" }); }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/my-accounts/:sellerName', async (req, res) => {
    const sellerKey = req.query.key;
    try {
        const validSeller = await verifySeller(sellerKey);
        if (!validSeller || validSeller !== req.params.sellerName) return res.status(401).json({ success: false, message: "دخول غير مصرح" });

        const snapshot = await db.ref(`sellers_data/${req.params.sellerName}`).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/app/verify-key', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.send("false");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const infoRef = db.ref(`information de clien/${sellerName}`);
            const infoSnap = await infoRef.once('value');
            if (!infoSnap.exists()) await infoRef.set({ email: "", link: "", json: "[]" });
            res.send("true");
        } else { res.send("false"); }
    } catch (error) { res.send("false"); }
});

app.post('/api/app/get-active-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("مفتاح البائع مطلوب"); 
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) await sendUpdatedActiveAccounts(res, sellerName);
        else res.status(401).send("غير مصرح لك"); 
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/get-sold-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("مفتاح البائع مطلوب");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const soldSnap = await db.ref(`sellers_data_sold/${sellerName}`).once('value');
            const data = soldSnap.val() || {};
            const soldArray = Object.keys(data).map(key => ({ key: key, ...data[key] })).filter(acc => acc.status !== 'delete');
            
            soldArray.sort((a, b) => {
                const parseD = (d) => {
                    if(!d) return 0;
                    const p = d.split(/[ \-:]/); 
                    if(p.length >= 5) return new Date(p[2], p[1]-1, p[0], p[3], p[4]).getTime();
                    return 0;
                }
                return parseD(b.sell_date) - parseD(a.sell_date);
            });
            res.send(soldArray); 
        } else { res.status(401).send("غير مصرح لك"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/set-account-status', async (req, res) => {
    const { sellerKey, accountId, status } = req.body;
    if (!sellerKey || !accountId || !status) return res.status(400).send("بيانات ناقصة");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const ownershipSnap = await db.ref(`sellers_data/${sellerName}/${accountId}`).once('value');
            if (!ownershipSnap.exists()) return res.status(403).send("هذا الحساب لا يخصك");

            const updates = {};
            if (status !== 'available') updates[`acc/${accountId}`] = null;
            else updates[`acc/${accountId}/status`] = status;
            
            updates[`sellers_data/${sellerName}/${accountId}/status`] = status;
            await db.ref().update(updates);
            await sendUpdatedActiveAccounts(res, sellerName);
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/set-account-sold', async (req, res) => {
    const { sellerKey, accountId, sellPrice, price_bot } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("بيانات ناقصة");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const snapshot = await accRef.once('value');
            if (snapshot.exists()) {
                const accData = snapshot.val();
                const finalPrice = sellPrice && String(sellPrice).trim() !== "" ? parseFloat(sellPrice) : parseFloat(accData.price_web);
                const today = getCurrentLocalTime(); 
                const sellDate = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()} ${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
                
                const soldData = { ...accData, status: 'sold', sell_date: sellDate, final_sell_price: finalPrice };
                const safePriceBot = sanitizeText(price_bot || "");
                if (price_bot !== undefined) soldData.price_bot = safePriceBot;

                const updates = {};
                updates[`acc/${accountId}`] = null;
                updates[`sellers_data/${sellerName}/${accountId}/status`] = 'sold';
                updates[`sellers_data_sold/${sellerName}/${accountId}`] = soldData;
                
                if (price_bot !== undefined) updates[`sellers_data/${sellerName}/${accountId}/price_bot`] = safePriceBot;

                await db.ref().update(updates);
                await sendUpdatedActiveAccounts(res, sellerName);
            } else { res.status(404).send("حساب غير موجود أو لا يخصك"); }
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/delete-account', async (req, res) => {
    const { sellerKey, accountId } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("بيانات ناقصة");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const ownershipSnap = await db.ref(`sellers_data/${sellerName}/${accountId}`).once('value');
            if (!ownershipSnap.exists()) return res.status(403).send("هذا الحساب لا يخصك");

            const updates = {};
            updates[`acc/${accountId}`] = null;
            updates[`sellers_data/${sellerName}/${accountId}/status`] = 'delete';
            updates[`sellers_data_sold/${sellerName}/${accountId}/status`] = 'delete';
            await db.ref().update(updates);
            await sendUpdatedActiveAccounts(res, sellerName);
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/edit-account', async (req, res) => {
    const { sellerKey, accountId, title, desc, webPrice, bankPrice, price_bot, email, password, isGg, isGameCenter, img, img2, img3, limit, push } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("بيانات ناقصة");

    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const checkSnap = await accRef.once('value');
            if (!checkSnap.exists()) return res.status(404).send("الحساب غير موجود أو لا يخصك");
            
            const existingData = checkSnap.val();
            const publicData = {};
            
            // تنظيف البيانات
            if (title !== undefined) publicData.title = sanitizeText(title); 
            if (desc !== undefined) publicData.desc = sanitizeText(desc);
            if (bankPrice !== undefined) publicData.bank_price = bankPrice; 
            if (webPrice !== undefined) publicData.price_web = webPrice;
            if (price_bot !== undefined) publicData.price_bot = sanitizeText(price_bot); 
            if (isGg !== undefined) publicData.gg = isGg;
            if (isGameCenter !== undefined) publicData.game_center = isGameCenter; 
            if (img !== undefined) publicData.img = img;
            if (img2 !== undefined) publicData.img2 = img2; 
            if (img3 !== undefined) publicData.img3 = img3;
            if (limit !== undefined) publicData.limit = sanitizeText(limit); 
            if (push !== undefined) publicData.push = push;

            const privateData = { ...publicData };
            if (email !== undefined) privateData.email = email; 
            if (password !== undefined) privateData.password = password;

            const updates = {};
            if (existingData.status === 'available') {
                for (let k in publicData) updates[`acc/${accountId}/${k}`] = publicData[k];
            }
            for (let k in privateData) updates[`sellers_data/${sellerName}/${accountId}/${k}`] = privateData[k];
            if (existingData.status === 'sold') {
                for (let k in privateData) updates[`sellers_data_sold/${sellerName}/${accountId}/${k}`] = privateData[k];
            }

            await db.ref().update(updates);
            await sendUpdatedActiveAccounts(res, sellerName);
        } else { res.status(401).send("غير مصرح لك"); }
    } catch (error) { res.status(500).send(`خطأ داخلي: ${error.message}`); }
});

app.post('/api/app/get-client-info', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.send("false");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const infoSnap = await db.ref(`information de clien/${sellerName}`).once('value');
            if (infoSnap.exists()) res.send(JSON.stringify([infoSnap.val()])); else res.send("false");
        } else { res.send("false"); }
    } catch (error) { res.send("false"); }
});

app.post('/api/app/save-client-info', async (req, res) => {
    const { sellerKey, email, link, json } = req.body;
    if (!sellerKey) return res.status(400).send("بيانات ناقصة");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const dataToSave = { 
                email: sanitizeText(email || ""), 
                link: sanitizeText(link || ""), 
                json: sanitizeText(json || "") 
            };
            await db.ref(`information de clien/${sellerName}`).set(dataToSave);
            res.json({ success: true, message: "تم نشر المعلومات بنجاح" });
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/edit-client-info', async (req, res) => {
    const { sellerKey, email, link, json } = req.body;
    if (!sellerKey) return res.status(400).send("بيانات ناقصة");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const updates = {};
            if (email !== undefined) updates.email = sanitizeText(email); 
            if (link !== undefined) updates.link = sanitizeText(link); 
            if (json !== undefined) updates.json = sanitizeText(json);
            
            await db.ref(`information de clien/${sellerName}`).update(updates);
            res.json({ success: true, message: "تم تعديل المعلومات بنجاح" });
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/submit-order', async (req, res) => {
    try {
        const { accountKey, name, phone, bank, image, deviceInfo, orderId } = req.body;
        if(!accountKey || !name || !phone || !bank || !orderId) return res.status(400).json({ success: false, message: "بيانات ناقصة" });

        // تنظيف البيانات
        const safeName = sanitizeText(name);
        const safePhone = sanitizeText(phone);
        const safeBank = sanitizeText(bank);
        const safeDeviceInfo = sanitizeText(deviceInfo || "Unknown Device");

        const pendingRequestsSnap = await db.ref('Requests').orderByChild('status').equalTo('pending').once('value');
        let pendingCount = 0; 
        let isSpam = false;

        if (pendingRequestsSnap.exists()) {
            const requests = pendingRequestsSnap.val();
            pendingCount = Object.keys(requests).length;
            for (let key in requests) {
                const reqData = requests[key];
                if (reqData.phone === safePhone && reqData.account_key === accountKey && reqData.bank === safeBank) {
                    isSpam = true;
                    break;
                }
            }
        }
        if (isSpam) return res.json({ success: false, message: "تم إنشاء طلبك بالفعل! المرجو الانتظار." });

        const accSnap = await db.ref(`acc/${accountKey}`).once('value');
        if(!accSnap.exists()) {
            return res.status(404).json({ success: false, message: "الحساب غير موجود أو مباع" });
        }
        const accData = accSnap.val();

        const sitePrice = accData.price_web ? Math.round(parseFloat(accData.price_web) * 1.05) : 0;
        const newOrder = {
            order_id: orderId, account_key: accountKey, name: safeName, phone: safePhone, bank: safeBank, image: image || "",
            device_info: safeDeviceInfo, status: "pending", timestamp: admin.database.ServerValue.TIMESTAMP,
            date: getFormattedDate(), img_acc: accData.img || "", price_site: sitePrice, title: accData.title || "",
            seller: accData.seller || "Unknown", gg: accData.gg !== undefined ? accData.gg : false, ios: accData.game_center !== undefined ? accData.game_center : false
        };

        await db.ref(`Requests/${orderId}`).set(newOrder);

        setTimeout(async () => {
            try {
                const adminPhone = "212708011007"; 
                const getBase64 = async (url) => {
                    if (!url) return null;
                    try {
                        const response = await fetch(url);
                        return Buffer.from(await response.arrayBuffer()).toString('base64');
                    } catch (e) { return null; }
                };

                const orderDetailsText = `🛍️ *طلب جديد من المتجر!*\n\n🔖 المرجع: ${orderId}\n👤 الزبون: ${safeName}\n📱 الهاتف: ${safePhone}\n🏪 البائع: ${accData.seller || "غير معروف"}\n🔢 ترتيب الزبون: ${pendingCount + 1}\n💳 طريقة الدفع: ${safeBank}\n💰 المبلغ: ${sitePrice} درهم\n\n🎮 الحساب: ${accData.title || "غير معروف"}\n🔑 المعرف: ${accountKey}\n🕒 الوقت: ${newOrder.date}`;

                if (accData.img) {
                    const accImgBase64 = await getBase64(accData.img);
                    if (accImgBase64) await fetch('https://doomn.fly.dev/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: adminPhone, type: "image", base64Data: accImgBase64, caption: "📸 صورة الحساب المطلوب" }) });
                }
                if (image) {
                    const receiptBase64 = await getBase64(image);
                    if (receiptBase64) await fetch('https://doomn.fly.dev/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: adminPhone, type: "image", base64Data: receiptBase64, caption: "🧾 صورة الإثبات المرفقة" }) });
                }
                await fetch('https://doomn.fly.dev/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: adminPhone, type: "text", content: orderDetailsText }) });

            } catch (err) { console.error("❌ فشل إرسال إشعار الواتساب:", err.message); }
        }, 100);

        res.json({ success: true, position: pendingCount + 1 });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/app/get-requests', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("مفتاح البائع مطلوب");
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const updatedData = await getUpdatedRequestsArray(sellerName);
            res.json(updatedData);
        } else { res.status(401).send("غير مصرح لك"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/update-request-status', async (req, res) => {
    const { sellerKey, orderId, status } = req.body;
    if (!sellerKey || !orderId || !status) return res.status(400).json({ success: false, message: "بيانات ناقصة" });
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const reqRef = db.ref(`Requests/${orderId}`);
            const reqSnap = await reqRef.once('value');
            if (reqSnap.exists()) {
                if (reqSnap.val().seller === sellerName) {
                    await reqRef.update({ status: status });
                    res.json(await getUpdatedRequestsArray(sellerName));
                } else { res.status(403).json({ success: false, message: "هذا الطلب لا يخصك" }); }
            } else { res.status(404).json({ success: false, message: "الطلب غير موجود" }); }
        } else { res.status(401).json({ success: false, message: "غير مصرح لك" }); }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/app/delete-request', async (req, res) => {
    const { sellerKey, orderId } = req.body;
    if (!sellerKey || !orderId) return res.status(400).json({ success: false, message: "بيانات ناقصة" });
    try {
        const sellerName = await verifySeller(sellerKey);
        if (sellerName) {
            const reqRef = db.ref(`Requests/${orderId}`);
            const reqSnap = await reqRef.once('value');
            if (reqSnap.exists()) {
                if (reqSnap.val().seller === sellerName) {
                    await reqRef.remove();
                    res.json(await getUpdatedRequestsArray(sellerName));
                } else { res.status(403).json({ success: false, message: "هذا الطلب لا يخصك" }); }
            } else { res.status(404).json({ success: false, message: "الطلب غير موجود" }); }
        } else { res.status(401).json({ success: false, message: "غير مصرح لك" }); }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}!`);
});
