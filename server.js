
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
        // استقبال المفتاح السري (sellerKey) للتحقق الأمني
        const { id, sellerKey, title, desc, email, password, bankPrice, webPrice, isGg, isGameCenter, imgUrl, img, img2, img3, limit } = req.body;
        
        if (!sellerKey || !title) return res.status(400).json({ success: false, message: "بيانات ناقصة: المفتاح السري والعنوان إجباريان" });

        // التحقق الأمني واستخراج اسم البائع الحقيقي (مثل hamza store)
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (!sellerName) {
            return res.status(401).json({ success: false, message: "مفتاح البائع غير صحيح، غير مصرح لك بالإضافة" });
        }

        // التحقق الذكي لضمان التوافق بين الويب (imgUrl) والتطبيق (img)
        const primaryImg = img || imgUrl;
        if (!primaryImg) return res.status(400).json({ success: false, message: "بيانات ناقصة: يجب توفير رابط الصورة الأساسية للحساب" });

        const publicData = { 
            seller: sellerName, 
            title, 
            desc: desc || "", 
            bank_price: bankPrice || 0, 
            price_web: webPrice, 
            gg: isGg || false, 
            game_center: isGameCenter || false, 
            img: primaryImg,
            img2: img2 || "", // حفظ الصورة الثانوية الثانية
            img3: img3 || "", // حفظ الصورة الثانوية الثالثة
            limit: limit || "" // حفظ مفتاح الـ limit الجديد
        };
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
