// =========================================================
// مسارات التطبيق (Sketchware App) السرية والآمنة 100%
// =========================================================

// 1. جلب الحسابات النشطة (sellers_data) على شكل مصفوفة ListMap
app.post('/api/app/get-active-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).json([]); // نرجع مصفوفة فارغة لتجنب تحطم التطبيق

    try {
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const snapshot = await db.ref(`sellers_data/${sellerName}`).once('value');
            const data = snapshot.val() || {};
            
            // تحويل البيانات لـ Array وإضافة المعرف في خانة "key" وإخفاء المحذوفة
            const accountsArray = Object.keys(data).map(key => {
                return { key: key, ...data[key] };
            }).filter(acc => acc.status !== 'delete').reverse(); // reverse لعرض الأحدث أولاً

            res.send(accountsArray); // نرسل المصفوفة مباشرة ليتعرف عليها Sketchware
        } else {
            res.status(401).json([]); 
        }
    } catch (error) { res.status(500).json([]); }
});

// 2. جلب الحسابات المباعة (sellers_data_sold) على شكل مصفوفة ListMap
app.post('/api/app/get-sold-accounts', async (req, res) => {
    const { sellerKey } = req.body;
    if (!sellerKey) return res.status(400).json([]);

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
            res.status(401).json([]);
        }
    } catch (error) { res.status(500).json([]); }
});

// 3. مسار الحذف الوهمي (تغيير الحالة إلى delete)
app.post('/api/app/delete-account', async (req, res) => {
    const { sellerKey, accountId } = req.body;
    if (!sellerKey || !accountId) return res.status(400).json({ success: false, message: "بيانات ناقصة" });

    try {
        // التحقق الأمني من المفتاح
        const keysSnap = await db.ref('keys').once('value');
        const keys = keysSnap.val();
        let sellerName = Object.keys(keys || {}).find(name => keys[name] === sellerKey);

        if (sellerName) {
            const updates = {};
            // نغير الحالة إلى delete في كل المجلدات لكي يختفي من المتجر ومن لوحة التحكم
            updates[`acc/${accountId}/status`] = 'delete';
            updates[`sellers_data/${sellerName}/${accountId}/status`] = 'delete';
            
            // في حال كان في مجلد المباع، نحذفه من هناك أيضاً
            updates[`sellers_data_sold/${sellerName}/${accountId}/status`] = 'delete';

            await db.ref().update(updates);
            res.json({ success: true, message: "تم الحذف بنجاح" });
        } else {
            res.status(401).json({ success: false, message: "غير مصرح لك" });
        }
    } catch (error) { res.status(500).json({ success: false, message: "خطأ في السيرفر" }); }
});
