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

// 1. إعداد فايربيس
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

// 2. إعداد Cloudflare R2
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
// مسارات (APIs)
// =========================================================

// تسجيل الدخول
app.post('/api/login', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "السيرفر غير متصل بفايربيس" });
    const { sellerKey } = req.body;
    try {
        const snapshot = await db.ref('keys').once('value');
        const keys = snapshot.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);
        if (sellerName) res.json({ success: true, sellerName });
        else res.status(401).json({ success: false, message: "المفتاح غير صحيح" });
    } catch (error) { res.status(500).json({ success: false, message: "خطأ في السيرفر" }); }
});

// رفع الصورة
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    if (!s3Client) return res.status(500).json({ success: false });
    try {
        const file = req.file;
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random()*1000)}.${file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: file.buffer, ContentType: file.mimetype }));
        res.json({ success: true, imageUrl: `${process.env.R2_PUBLIC_URL}/${fileName}` });
    } catch (error) { res.status(500).json({ success: false }); }
});

// حفظ الحساب (مع الفصل الأمني القوي)
app.post('/api/save-account', async (req, res) => {
    try {
        const { id, sellerName, title, email, password, bankPrice, webPrice, isGg, isGameCenter, imgUrl } = req.body;
        if (!sellerName || !title || !imgUrl) return res.status(400).json({ success: false });

        // 1. البيانات العامة للمتجر الرئيسي (بدووون باسورد أو إيميل لحمايتها)
        const publicData = {
            seller: sellerName, 
            title: title, 
            bank_price: bankPrice || 0, 
            price_web: webPrice,
            gg: isGg || false, 
            game_center: isGameCenter || false, 
            img: imgUrl
        };

        // 2. البيانات الخاصة للبائع (توضع في مجلده السري وتتضمن كل شيء)
        const privateData = {
            ...publicData,
            email: email || "", 
            password: password || ""
        };

        if (id) {
            // تحديث حساب موجود (نحدث في المجلدين معاً)
            await db.ref(`acc/${id}`).update(publicData);
            await db.ref(`sellers_data/${sellerName}/${id}`).update(privateData);
        } else {
            // إنشاء حساب جديد كلياً
            const today = new Date();
            const timestamp = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
            
            publicData.timestamp = timestamp;
            publicData.status = "available";
            
            privateData.timestamp = timestamp;
            privateData.status = "available";

            // إنشاء ID موحد
            const newRef = db.ref('acc').push();
            const newId = newRef.key;

            // حقن البيانات في المجلدين في نفس اللحظة
            const updates = {};
            updates[`acc/${newId}`] = publicData;
            updates[`sellers_data/${sellerName}/${newId}`] = privateData;
            
            await db.ref().update(updates);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// تحديث الحالة (تتحدث في المجلدين معاً بضربة واحدة)
app.post('/api/update-status', async (req, res) => {
    try {
        const { id, status, sellerName } = req.body;
        
        const updates = {};
        updates[`acc/${id}/status`] = status;
        updates[`sellers_data/${sellerName}/${id}/status`] = status;
        
        await db.ref().update(updates);
        
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// جلب حسابات البائع (الآن نجلبها من مجلده الخاص والسري مباشرة!)
app.get('/api/my-accounts/:sellerName', async (req, res) => {
    try {
        const { sellerName } = req.params;
        const snapshot = await db.ref(`sellers_data/${sellerName}`).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`🚀 Server running!`));
