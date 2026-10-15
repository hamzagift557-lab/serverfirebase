FROM node:20-bookworm

WORKDIR /app

# نسخ ملفات تعريف المشروع
COPY package*.json ./

# تثبيت مكتبات Node.js
RUN npm install

# نسخ بقية ملفات المشروع
COPY . .

# المنفذ الذي يستخدمه السيرفر في server.js
EXPOSE 8080

CMD ["npm", "start"]
