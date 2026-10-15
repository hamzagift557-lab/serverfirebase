FROM node:20-bookworm

WORKDIR /app

# تثبيت متصفح Chromium الرسمي ومكتبات النظام اللازمة لتشغيل Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# إخبار Puppeteer بعدم تحميل كروم خارجي واستخدام كروم النظام المستقر
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# نسخ ملفات تعريف المشروع
COPY package*.json ./

# تثبيت مكتبات Node.js
RUN npm install

# نسخ بقية ملفات المشروع
COPY . .

# المنفذ الذي يستخدمه السيرفر في server.js
EXPOSE 8080

CMD ["npm", "start"]
