FROM node:18-alpine

# تحديد مجلد العمل داخل السيرفر
WORKDIR /app

# نسخ ملفات تعريف المكتبات أولاً
COPY package*.json ./

# تثبيت المكتبات (فايربيس، كلاود فلير وغيرها)
RUN npm install

# نسخ باقي ملفات المشروع (مثل server.js)
COPY . .

# فتح المنفذ 8080 الذي برمجناه
EXPOSE 8080

# أمر تشغيل السيرفر
CMD ["npm", "start"]
