const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// كلمة السر التي سنضعها في إعدادات فيسبوك للتحقق من ملكيتك للسيرفر
const VERIFY_TOKEN = "hamza_webhook_123";

// التوكن الخاص بصفحتك الذي أرسلته لي
const PAGE_ACCESS_TOKEN = "EAAG5a8VWw5IBSQsr4ZBce4wv6ZAL8q5xGe0eHaVMZB0mp1KpdPOw42SAFcpUSGrEBsoMnG8BNuTjRK0ZAuKRKizmSZCwPIBZCH8XV0TZBMF6ztKQm2vFLnyqM0QMw8v65uNsSX5ZCrB0F5Felk9HP32lBKxqMLtdTkfLUUjMWqMQqzjLLX4QsIdmJzsxtlVPOsxoa9VU";

// 1. مسار التحقق (GET) - يطلبه فيسبوك مرة واحدة عند ربط التطبيق
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.error("❌ فشل التحقق: التوكن غير متطابق");
            res.sendStatus(403);
        }
    }
});

// 2. مسار استقبال الرسائل (POST) - يرسل إليه فيسبوك أي حدث جديد
app.post('/webhook', (req, res) => {
    try {
        let body = req.body;

        // التأكد من أن الحدث قادم من صفحة فيسبوك
        if (body.object === 'page') {
            body.entry.forEach(function(entry) {
                // جلب الحدث (الرسالة أو الضغطة على الزر)
                let webhook_event = entry.messaging[0];
                console.log("📩 تم استلام حدث جديد من فيسبوك:");
                console.log(JSON.stringify(webhook_event, null, 2));
                
                // في الخطوات القادمة، سنضيف هنا كود الرد على الرسائل والبحث في الموقع
            });
            
            // يجب دائماً الرد على فيسبوك بـ 200 OK ليعرف أننا استلمنا الرسالة
            res.status(200).send('EVENT_RECEIVED');
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        // طباعة الخطأ الحقيقي والأصلي بوضوح تام كما تفضل
        console.error("⚠️ حدث خطأ داخلي أثناء معالجة الـ Webhook:");
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

// تشغيل السيرفر على المنفذ 8080 والعنوان 0.0.0.0 المخصص لـ Fly.io
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 السيرفر يعمل بنجاح على المنفذ ${PORT}`);
    console.log(`في إعدادات فيسبوك، استخدم التوكن التالي للتحقق: ${VERIFY_TOKEN}`);
});
