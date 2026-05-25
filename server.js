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

// 1. إعداد فايربيس (بشكل محمي من الانهيار)
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://hamza-kr-default-rtdb.firebaseio.com"
        });
        db = admin.database();
        console.log("✅ تم الاتصال بقاعدة بيانات فايربيس بنجاح!");

        // إنشاء مفاتيح البائعين تلقائياً
        const initialKeys = {
            "hamza store": "hamzax1",
            "forlan shop": "forlanx1",
            "lwajdi": "wajdix1"
        };
        db.ref('keys').once('value', snapshot => {
            if (!snapshot.exists()) {
                db.ref('keys').set(initialKeys);
            }
        });
    } else {
        console.log("⚠️ مفتاح فايربيس مفقود من الـ Secrets");
    }
} catch (error) {
    console.error("❌ فشل قراءة مفتاح فايربيس (تأكد من صحة JSON الذي الصقته):", error.message);
}

// 2. إعداد Cloudflare R2 (بشكل محمي)
try {
    if (process.env.R2_ACCESS_KEY_ID) {
        s3Client = new S3Client({
            region: "auto",
            endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
        });
        console.log("✅ تم الاتصال بـ Cloudflare R2 بنجاح!");
    }
} catch (error) {
    console.error("❌ فشل إعداد Cloudflare R2:", error.message);
}

const upload = multer({ storage: multer.memoryStorage() });

// =========================================================
// واجهات برمجة التطبيقات (APIs)
// =========================================================

// فحص حالة السيرفر
app.get('/', (req, res) => {
    res.send("🚀 السيرفر يعمل بنجاح على منصة Fly.io!");
});

// أ. تسجيل الدخول للبائعين
app.post('/api/login', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "السيرفر غير متصل بفايربيس حالياً" });
    
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).json({ success: false, message: "المرجو إدخال المفتاح" });

    try {
        const snapshot = await db.ref('keys').once('value');
        const keys = snapshot.val();
        
        let sellerName = null;
        for (let name in keys) {
            if (keys[name] === sellerKey) {
                sellerName = name;
                break;
            }
        }

        if (sellerName) {
            res.json({ success: true, sellerName: sellerName, message: "تم تسجيل الدخول بنجاح" });
        } else {
            res.status(401).json({ success: false, message: "المفتاح غير صحيح" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "خطأ في السيرفر" });
    }
});

// ب. إضافة حساب جديد
app.post('/api/add-account', upload.single('image'), async (req, res) => {
    if (!db || !s3Client) return res.status(500).json({ success: false, message: "السيرفر غير مكتمل الإعدادات" });

    try {
        const { sellerName, title, email, password, bankPrice, webPrice, isGg, isIos } = req.body;
        const file = req.file;

        if (!sellerName || !title || !file) {
            return res.status(400).json({ success: false, message: "بيانات ناقصة" });
        }

        const fileExtension = file.originalname.split('.').pop();
        const fileName = `acc_${Date.now()}_${Math.floor(Math.random() * 1000)}.${fileExtension}`;
        
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
        });

        await s3Client.send(command);
        const imageUrl = `${process.env.R2_PUBLIC_URL}/${fileName}`;

        const today = new Date();
        const timestamp = String(today.getDate()).padStart(2, '0') + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + today.getFullYear();

        const accountData = {
            seller: sellerName,
            title: title,
            email: email || "",
            password: password || "",
            bank_price: bankPrice,
            price_web: webPrice,
            gg: isGg || "false",
            ios: isIos || "false",
            img: imageUrl,
            timestamp: timestamp,
            status: "available"
        };

        const newAccRef = db.ref('acc').push();
        await newAccRef.set(accountData);

        res.json({ success: true, message: "تمت إضافة الحساب بنجاح!", accId: newAccRef.key });

    } catch (error) {
        res.status(500).json({ success: false, message: "فشل في رفع الحساب" });
    }
});

// ج. جلب حسابات بائع معين
app.get('/api/my-accounts/:sellerName', async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "السيرفر غير متصل بفايربيس" });

    const { sellerName } = req.params;
    try {
        const snapshot = await db.ref('acc').orderByChild('seller').equalTo(sellerName).once('value');
        res.json({ success: true, data: snapshot.val() || {} });
    } catch (error) {
        res.status(500).json({ success: false, message: "خطأ في جلب الحسابات" });
    }
});

// تشغيل السيرفر بشكل متوافق تماماً مع شبكة Fly.io
// المنصة عادة ما تتواصل مع السيرفر عبر منفذ 8080 أو المنفذ الموجود في fly.toml
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
