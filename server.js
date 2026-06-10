require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json());

let db = null;
let s3Client = null;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://hamza-f798c-default-rtdb.firebaseio.com"
        });
        db = admin.database();
        
        const initialKeys = { "hamza store": "hamzax1", "forlan shop": "forlanx1", "lwajdi": "wajdix1" };
        db.ref('keys').once('value', snapshot => {
            if (!snapshot.exists()) db.ref('keys').set(initialKeys);
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

const upload = multer({ storage: multer.memoryStorage() });

// =========================================================
// خوارزمية الفرز المتقدم وتجهيز الرد للتطبيق (الأساسي)
// =========================================================
async function sendUpdatedActiveAccounts(res, sellerName) {
    const snapshot = await db.ref(`sellers_data/${sellerName}`).once('value');
    const data = snapshot.val() || {};
    
    const statsSnap = await db.ref(`sellers_stats/${sellerName}`).once('value');
    const viewDay = (statsSnap.val() && statsSnap.val().view_day) ? statsSnap.val().view_day : 0;

    const accountsArray = Object.keys(data).map(key => {
        return { key: key, ...data[key] };
    }).filter(acc => acc.status !== 'delete');

    accountsArray.sort((a, b) => {
        const order = { 'available': 1, 'att': 2, 'sold': 3 };
        const stA = order[a.status] || 4;
        const stB = order[b.status] || 4;

        if (stA !== stB) return stA - stB;

        if (a.status === 'available' || a.status === 'att') {
            const pA = parseFloat(a.bank_price) || 0;
            const pB = parseFloat(b.bank_price) || 0;
            return pB - pA;
        }

        if (a.status === 'sold') {
            const parseD = (d) => {
                if(!d) return 0;
                const p = d.split(/[ \-:]/); 
                if(p.length >= 5) return new Date(p[2], p[1]-1, p[0], p[3], p[4]).getTime();
                return 0;
            }
            return parseD(b.sell_date) - parseD(a.sell_date);
        }
        return 0;
    });

    return res.json({
        view_day: viewDay,
        accounts: accountsArray
    });
}

// =========================================================
// مسارات لوحة التحكم (الويب)
// =========================================================

app.post('/api/login', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "السيرفر غير متصل بفايربيس" });
    const { sellerKey } = req.body;
    try {
        const snapshot = await db.ref('keys').once('value');
        const keys = snapshot.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        if (sellerName) {
            // إضافة ميزة إنشاء مجلد information de clien تلقائياً
            const infoRef = db.ref(`information de clien/${sellerName}`);
            const infoSnap = await infoRef.once('value');
            if (!infoSnap.exists()) {
                await infoRef.set({
                    email: "",
                    link: "",
                    json: "[]"
                });
            }

            res.json({ success: true, sellerName });
        }
        else res.status(401).json({ success: false, message: "المفتاح غير صحيح" });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    if (!s3Client) return res.status(500).json({ success: false, message: "Cloudflare R2 غير متصل" });
    try {
        const file = req.file;
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random()*1000)}.${file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: file.buffer, ContentType: file.mimetype }));
        res.json({ success: true, imageUrl: `${process.env.R2_PUBLIC_URL}/${fileName}` });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/save-account', async (req, res) => {
    try {
        const { id, sellerKey, title, desc, email, password, bankPrice, webPrice, price_bot, isGg, isGameCenter, imgUrl, img, img2, img3, limit } = req.body;
        if (!sellerKey || !title) return res.status(400).json({ success: false, message: "بيانات ناقصة" });

        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        if (!sellerName) return res.status(401).json({ success: false, message: "مفتاح البائع غير صحيح" });

        const primaryImg = img || imgUrl;
        if (!primaryImg) return res.status(400).json({ success: false, message: "صورة أساسية مطلوبة" });

        const publicData = { 
            seller: sellerName, title, desc: desc || "", bank_price: bankPrice || 0, price_web: webPrice, 
            price_bot: price_bot || "", 
            gg: isGg || false, game_center: isGameCenter || false, 
            img: primaryImg, img2: img2 || "", img3: img3 || "", limit: limit || "" 
        };
        const privateData = { ...publicData, email: email || "", password: password || "" };

        if (id) {
            await db.ref(`acc/${id}`).update(publicData);
            await db.ref(`sellers_data/${sellerName}/${id}`).update(privateData);
        } else {
            const today = new Date();
            const timestamp = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
            
            publicData.view = 0;
            privateData.view = 0;
            
            publicData.timestamp = timestamp; publicData.status = "available";
            privateData.timestamp = timestamp; privateData.status = "available";

            const newId = db.ref('acc').push().key;
            const updates = {};
            updates[`acc/${newId}`] = publicData;
            updates[`sellers_data/${sellerName}/${newId}`] = privateData;
            await db.ref().update(updates);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/update-status', async (req, res) => {
    try {
        const { id, status, sellerName } = req.body;
        const updates = {};
        updates[`acc/${id}/status`] = status;
        updates[`sellers_data/${sellerName}/${id}/status`] = status;
        await db.ref().update(updates);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/mark-sold', async (req, res) => {
    try {
        const { id, sellerName, sellPrice, price_bot } = req.body;
        const accRef = db.ref(`sellers_data/${sellerName}/${id}`);
        const snapshot = await accRef.once('value');

        if (snapshot.exists()) {
            const accData = snapshot.val();
            const finalPrice = sellPrice && String(sellPrice).trim() !== "" ? parseFloat(sellPrice) : parseFloat(accData.price_web);
            const today = new Date();
            const sellDate = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()} ${today.getHours()}:${today.getMinutes()}`;
            
            const soldData = { ...accData, status: 'sold', sell_date: sellDate, final_sell_price: finalPrice };
            
            if (price_bot !== undefined) {
                soldData.price_bot = price_bot;
            }

            const updates = {};
            updates[`acc/${id}/status`] = 'sold';
            updates[`sellers_data/${sellerName}/${id}/status`] = 'sold';
            updates[`sellers_data_sold/${sellerName}/${id}`] = soldData;
            
            if (price_bot !== undefined) {
                updates[`acc/${id}/price_bot`] = price_bot;
                updates[`sellers_data/${sellerName}/${id}/price_bot`] = price_bot;
            }

            await db.ref().update(updates);
            res.json({ success: true });
        } else { res.status(404).json({ success: false, message: "الحساب غير موجود" }); }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/my-accounts/:sellerName', async (req, res) => {
    try {
        const snapshot = await db.ref(`sellers_data/${req.params.sellerName}`).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// =========================================================
// مسارات التطبيق (Sketchware App)
// =========================================================

app.post('/api/app/verify-key', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.send("false");
    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        
        if (sellerName) {
            // إضافة ميزة إنشاء مجلد information de clien تلقائياً لتطبيق Sketchware
            const infoRef = db.ref(`information de clien/${sellerName}`);
            const infoSnap = await infoRef.once('value');
            if (!infoSnap.exists()) {
                await infoRef.set({
                    email: "",
                    link: "",
                    json: "[]"
                });
            }

            res.send("true");
        } else {
            res.send("false");
        }
    } catch (error) { res.send("false"); }
});

app.post('/api/app/get-active-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("مفتاح البائع مطلوب"); 
    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        if (sellerName) await sendUpdatedActiveAccounts(res, sellerName);
        else res.status(401).send("غير مصرح لك"); 
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/get-sold-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("مفتاح البائع مطلوب");
    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const soldSnap = await db.ref(`sellers_data_sold/${sellerName}`).once('value');
            const data = soldSnap.val() || {};
            const soldArray = Object.keys(data).map(key => ({ key: key, ...data[key] })).filter(acc => acc.status !== 'delete').reverse();
            res.send(soldArray); 
        } else { res.status(401).send("غير مصرح لك"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/set-account-status', async (req, res) => {
    const { sellerKey, accountId, status } = req.body;
    if (!sellerKey || !accountId || !status) return res.status(400).send("بيانات ناقصة");
    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        if (sellerName) {
            const updates = {};
            updates[`acc/${accountId}/status`] = status;
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
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const snapshot = await accRef.once('value');
            if (snapshot.exists()) {
                const accData = snapshot.val();
                const finalPrice = sellPrice && String(sellPrice).trim() !== "" ? parseFloat(sellPrice) : parseFloat(accData.price_web);
                const today = new Date();
                const sellDate = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()} ${today.getHours()}:${today.getMinutes()}`;
                
                const soldData = { ...accData, status: 'sold', sell_date: sellDate, final_sell_price: finalPrice };
                if (price_bot !== undefined) {
                    soldData.price_bot = price_bot;
                }

                const updates = {};
                updates[`acc/${accountId}/status`] = 'sold';
                updates[`sellers_data/${sellerName}/${accountId}/status`] = 'sold';
                updates[`sellers_data_sold/${sellerName}/${accountId}`] = soldData;
                
                if (price_bot !== undefined) {
                    updates[`acc/${accountId}/price_bot`] = price_bot;
                    updates[`sellers_data/${sellerName}/${accountId}/price_bot`] = price_bot;
                }

                await db.ref().update(updates);
                await sendUpdatedActiveAccounts(res, sellerName);
            } else { res.status(404).send("حساب غير موجود"); }
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/delete-account', async (req, res) => {
    const { sellerKey, accountId } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("بيانات ناقصة");
    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const updates = {};
            updates[`acc/${accountId}/status`] = 'delete';
            updates[`sellers_data/${sellerName}/${accountId}/status`] = 'delete';
            updates[`sellers_data_sold/${sellerName}/${accountId}/status`] = 'delete';
            await db.ref().update(updates);
            await sendUpdatedActiveAccounts(res, sellerName);
        } else { res.status(401).send("غير مصرح"); }
    } catch (error) { res.status(500).send(`خطأ: ${error.message}`); }
});

app.post('/api/app/edit-account', async (req, res) => {
    const { sellerKey, accountId, title, desc, webPrice, bankPrice, price_bot, email, password, isGg, isGameCenter, img, img2, img3, limit } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("فشل التعديل: المفتاح السري والمعرف مطلوبان");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const checkSnap = await accRef.once('value');
            if (!checkSnap.exists()) return res.status(404).send("فشل التعديل: الحساب غير موجود");
            
            const existingData = checkSnap.val();

            const publicData = {};
            if (title !== undefined) publicData.title = title;
            if (desc !== undefined) publicData.desc = desc;
            if (bankPrice !== undefined) publicData.bank_price = bankPrice;
            if (webPrice !== undefined) publicData.price_web = webPrice;
            if (price_bot !== undefined) publicData.price_bot = price_bot; 
            if (isGg !== undefined) publicData.gg = isGg;
            if (isGameCenter !== undefined) publicData.game_center = isGameCenter;
            if (img !== undefined) publicData.img = img;
            if (img2 !== undefined) publicData.img2 = img2;
            if (img3 !== undefined) publicData.img3 = img3;
            if (limit !== undefined) publicData.limit = limit;

            const privateData = { ...publicData };
            if (email !== undefined) privateData.email = email;
            if (password !== undefined) privateData.password = password;

            const updates = {};
            for (let k in publicData) updates[`acc/${accountId}/${k}`] = publicData[k];
            for (let k in privateData) updates[`sellers_data/${sellerName}/${accountId}/${k}`] = privateData[k];
            if (existingData.status === 'sold') {
                for (let k in privateData) updates[`sellers_data_sold/${sellerName}/${accountId}/${k}`] = privateData[k];
            }

            await db.ref().update(updates);
            await sendUpdatedActiveAccounts(res, sellerName);
        } else {
            res.status(401).send("فشل التعديل: غير مصرح لك");
        }
    } catch (error) { res.status(500).send(`فشل التعديل بسبب خطأ داخلي: ${error.message}`); }
});

// =========================================================
// مسارات معلومات العميل (Information de clien)
// =========================================================

app.post('/api/app/get-client-info', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.send("false");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const infoSnap = await db.ref(`information de clien/${sellerName}`).once('value');
            if (infoSnap.exists()) {
                res.send(JSON.stringify([infoSnap.val()]));
            } else {
                res.send("false");
            }
        } else {
            res.send("false");
        }
    } catch (error) {
        res.send("false");
    }
});

app.post('/api/app/save-client-info', async (req, res) => {
    const { sellerKey, email, link, json } = req.body;
    if (!sellerKey) return res.status(400).send("بيانات ناقصة");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const dataToSave = {
                email: email || "",
                link: link || "",
                json: json || ""
            };
            await db.ref(`information de clien/${sellerName}`).set(dataToSave);
            res.json({ success: true, message: "تم نشر المعلومات بنجاح" });
        } else {
            res.status(401).send("غير مصرح");
        }
    } catch (error) {
        res.status(500).send(`خطأ: ${error.message}`);
    }
});

app.post('/api/app/edit-client-info', async (req, res) => {
    const { sellerKey, email, link, json } = req.body;
    if (!sellerKey) return res.status(400).send("بيانات ناقصة");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const updates = {};
            if (email !== undefined) updates.email = email;
            if (link !== undefined) updates.link = link;
            if (json !== undefined) updates.json = json;

            await db.ref(`information de clien/${sellerName}`).update(updates);
            res.json({ success: true, message: "تم تعديل المعلومات بنجاح" });
        } else {
            res.status(401).send("غير مصرح");
        }
    } catch (error) {
        res.status(500).send(`خطأ: ${error.message}`);
    }
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`🚀 Server running!`));
