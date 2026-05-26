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

// 1. رفع الصورة فوراً
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    if (!s3Client) return res.status(500).json({ success: false });
    try {
        const file = req.file;
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random()*1000)}.${file.originalname.split('.').pop()}`;
        await s3Client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: fileName, Body: file.buffer, ContentType: file.mimetype }));
        res.json({ success: true, imageUrl: `${process.env.R2_PUBLIC_URL}/${fileName}` });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 2. إضافة أو تعديل الحساب
app.post('/api/save-account', async (req, res) => {
    try {
        const { id, sellerName, title, email, password, bankPrice, webPrice, isGg, isGameCenter, imgUrl } = req.body;
        if (!sellerName || !title || !imgUrl) return res.status(400).json({ success: false });

        const accountData = {
            seller: sellerName, title, email: email || "", password: password || "",
            bank_price: bankPrice || 0, price_web: webPrice,
            gg: isGg || false, game_center: isGameCenter || false, img: imgUrl
        };

        if (id) {
            await db.ref(`acc/${id}`).update(accountData);
        } else {
            const today = new Date();
            accountData.timestamp = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
            accountData.status = "available";
            await db.ref('acc').push().set(accountData);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 3. تغيير الحالة (مؤقت، مباع، حذف)
app.post('/api/update-status', async (req, res) => {
    try {
        const { id, status, sellerName } = req.body;
        const accRef = db.ref(`acc/${id}`);
        const snapshot = await accRef.once('value');
        if (snapshot.exists() && snapshot.val().seller === sellerName) {
            await accRef.update({ status: status });
            res.json({ success: true });
        } else { res.status(403).json({ success: false }); }
    } catch (error) { res.status(500).json({ success: false }); }
});

// جلب حسابات بائع
app.get('/api/my-accounts/:sellerName', async (req, res) => {
    try {
        const snapshot = await db.ref('acc').orderByChild('seller').equalTo(req.params.sellerName).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log(`🚀 Server running!`));
