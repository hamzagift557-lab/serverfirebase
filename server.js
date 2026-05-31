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

// دالة مساعدة سريعة لجلب البيانات النشطة وإرسالها كمصفوفة نقيّة لتطبيقك
async function sendUpdatedActiveAccounts(res, sellerName) {
    const snapshot = await db.ref(`sellers_data/${sellerName}`).once('value');
    const data = snapshot.val() || {};
    const accountsArray = Object.keys(data).map(key => {
        return { key: key, ...data[key] };
    }).filter(acc => acc.status !== 'delete').reverse();
    return res.send(accountsArray);
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
        if (sellerName) res.json({ success: true, sellerName });
        else res.status(401).json({ success: false, message: "المفتاح غير صحيح" });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    if (!s3Client) return res.status(500).json({ success: false, message: "Cloudflare R2 غير متصل بالسيرفر" });
    try {
        const file = req.file;
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random()*1000)}.${file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: file.buffer, ContentType: file.mimetype }));
        res.json({ success: true, imageUrl: `${process.env.R2_PUBLIC_URL}/${fileName}` });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/save-account', async (req, res) => {
    try {
        const { id, sellerName, title, desc, email, password, bankPrice, webPrice, isGg, isGameCenter, imgUrl } = req.body;
        if (!sellerName || !title || !imgUrl) return res.status(400).json({ success: false, message: "بيانات ناقصة: اسم البائع، العنوان والصورة إجبارية" });

        const publicData = { seller: sellerName, title, desc: desc || "", bank_price: bankPrice || 0, price_web: webPrice, gg: isGg || false, game_center: isGameCenter || false, img: imgUrl };
        const privateData = { ...publicData, email: email || "", password: password || "" };

        if (id) {
            await db.ref(`acc/${id}`).update(publicData);
            await db.ref(`sellers_data/${sellerName}/${id}`).update(privateData);
        } else {
            const today = new Date();
            const timestamp = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
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
        const { id, sellerName, sellPrice } = req.body;
        const accRef = db.ref(`sellers_data/${sellerName}/${id}`);
        const snapshot = await accRef.once('value');

        if (snapshot.exists()) {
            const accData = snapshot.val();
            const finalPrice = sellPrice && String(sellPrice).trim() !== "" ? parseFloat(sellPrice) : parseFloat(accData.price_web);
            
            const today = new Date();
            const sellDate = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()} ${today.getHours()}:${today.getMinutes()}`;

            const soldData = {
                ...accData,
                status: 'sold',
                sell_date: sellDate,
                final_sell_price: finalPrice
            };

            const updates = {};
            updates[`acc/${id}/status`] = 'sold';
            updates[`sellers_data/${sellerName}/${id}/status`] = 'sold';
            updates[`sellers_data_sold/${sellerName}/${id}`] = soldData;

            await db.ref().update(updates);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: "الحساب غير موجود بقاعدة البيانات" });
        }
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/my-accounts/:sellerName', async (req, res) => {
    try {
        const snapshot = await db.ref(`sellers_data/${req.params.sellerName}`).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// =========================================================
// مسارات التطبيق (Sketchware App) السرية والآمنة 100%
// =========================================================

// 1. جلب الحسابات النشطة (sellers_data) على شكل مصفوفة ListMap
app.post('/api/app/get-active-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("فشل الجلب بسبب: مفتاح البائع سري ومطلوب لإتمام العملية"); 

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            await sendUpdatedActiveAccounts(res, sellerName);
        } else {
            res.status(401).send("فشل الجلب بسبب: مفتاح البائع المدخل غير صحيح وغير مصرح له"); 
        }
    } catch (error) { res.status(500).send(`فشل الجلب بسبب خطأ في السيرفر: ${error.message}`); }
});

// 2. جلب الحسابات المباعة (sellers_data_sold) على شكل مصفوفة ListMap
app.post('/api/app/get-sold-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).send("فشل الجلب بسبب: مفتاح البائع سري ومطلوب لإتمام العملية");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const soldSnap = await db.ref(`sellers_data_sold/${sellerName}`).once('value');
            const data = soldSnap.val() || {};
            
            const soldArray = Object.keys(data).map(key => {
                return { key: key, ...data[key] };
            }).filter(acc => acc.status !== 'delete').reverse();

            res.send(soldArray); 
        } else {
            res.status(401).send("فشل الجلب بسبب: مفتاح البائع المدخل غير صحيح وغير مصرح له");
        }
    } catch (error) { res.status(500).send(`فشل الجلب بسبب خطأ في السيرفر: ${error.message}`); }
});

// 3. مسار ضبط وتعديل حالة الحساب (متاحavailable / مؤقتatt) + الإرجاع الفوري للمصفوفة المحدثة
app.post('/api/app/set-account-status', async (req, res) => {
    const { sellerKey, accountId, status } = req.body;
    if (!sellerKey || !accountId || !status) return res.status(400).send("فشل تعديل الحالة بسبب: بيانات ناقصة (sellerKey, accountId, status)");

    if (status !== 'available' && status !== 'att') {
        return res.status(400).send("فشل تعديل الحالة بسبب: الحالة المرسلة غير مدعومة في هذا المسار، استخدم مسارات البيع أو الحذف المخصصة لها");
    }

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const checkSnap = await accRef.once('value');
            if (!checkSnap.exists()) return res.status(404).send("فشل تعديل الحالة بسبب: هذا الحساب غير موجود أو لا ينتمي لهذا البائع");

            const updates = {};
            updates[`acc/${accountId}/status`] = status;
            updates[`sellers_data/${sellerName}/${accountId}/status`] = status;
            await db.ref().update(updates);

            // إرجاع المصفوفة الجديدة المحدثة تلقائياً للـ ListView الخاص بك
            await sendUpdatedActiveAccounts(res, sellerName);
        } else {
            res.status(401).send("فشل تعديل الحالة بسبب: مفتاح البائع المدخل غير صحيح وغير مصرح له");
        }
    } catch (error) { res.status(500).send(`فشل تعديل الحالة بسبب خطأ في السيرفر: ${error.message}`); }
});

// 4. مسار تسجيل عملية البيع النهائي (تم البيع sold) وتوثيق السعر + الإرجاع الفوري للمصفوفة المحدثة
app.post('/api/app/set-account-sold', async (req, res) => {
    const { sellerKey, accountId, sellPrice } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("فشل عملية تسجيل البيع بسبب: بيانات ناقصة (sellerKey, accountId)");

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

                const soldData = {
                    ...accData,
                    status: 'sold',
                    sell_date: sellDate,
                    final_sell_price: finalPrice
                };

                const updates = {};
                updates[`acc/${accountId}/status`] = 'sold';
                updates[`sellers_data/${sellerName}/${accountId}/status`] = 'sold';
                updates[`sellers_data_sold/${sellerName}/${accountId}`] = soldData;

                await db.ref().update(updates);

                // إرجاع المصفوفة الجديدة المحدثة تلقائياً للـ ListView الخاص بك
                await sendUpdatedActiveAccounts(res, sellerName);
            } else {
                res.status(404).send("فشل عملية تسجيل البيع بسبب: هذا الحساب غير موجود أو لا ينتمي لهذا البائع");
            }
        } else {
            res.status(401).send("فشل عملية تسجيل البيع بسبب: مفتاح البائع المدخل غير صحيح وغير مصرح له");
        }
    } catch (error) { res.status(500).send(`فشل عملية تسجيل البيع بسبب خطأ في السيرفر: ${error.message}`); }
});

// 5. مسار الحذف الصارم (تغيير الحالة إلى delete) + الإرجاع الفوري للمصفوفة المحدثة
app.post('/api/app/delete-account', async (req, res) => {
    const { sellerKey, accountId } = req.body;
    if (!sellerKey || !accountId) return res.status(400).send("فشل الحذف بسبب: بيانات ناقصة (مفتاح البائع ومعرّف الحساب مطلوبان)");

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const accRef = db.ref(`sellers_data/${sellerName}/${accountId}`);
            const checkSnap = await accRef.once('value');
            if (!checkSnap.exists()) return res.status(404).send("فشل الحذف بسبب: هذا الحساب غير موجود أو لا ينتمي لهذا البائع");

            const updates = {};
            updates[`acc/${accountId}/status`] = 'delete';
            updates[`sellers_data/${sellerName}/${accountId}/status`] = 'delete';
            updates[`sellers_data_sold/${sellerName}/${accountId}/status`] = 'delete';

            await db.ref().update(updates);

            // إرجاع المصفوفة الجديدة المحدثة تلقائياً للـ ListView الخاص بك
            await sendUpdatedActiveAccounts(res, sellerName);
        } else {
            res.status(401).send("فشل الحذف بسبب: مفتاح البائع المدخل غير صحيح وغير مصرح له");
        }
    } catch (error) { res.status(500).send(`فشل الحذف بسبب خطأ داخلي في السيرفر: ${error.message}`); }
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`🚀 Server running!`));
