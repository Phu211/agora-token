# Agora Token Server

Backend server để generate Agora RTC tokens cho tính năng gọi điện và video call.

## 🚀 Cài đặt và chạy Local

### 1. Cài đặt dependencies

```bash
npm install
```

### 2. Chạy server

```bash
npm start
```

Hoặc với nodemon (tự động restart khi có thay đổi):

```bash
npm run dev
```

Server sẽ chạy tại: `http://localhost:3000`

## 📝 Test endpoint

Mở trình duyệt và truy cập:

```
http://localhost:3000/agora/token?userId=test123&channelName=test_channel
```

Kết quả mong đợi:

```json
{
  "token": "006abc123def456..."
}
```

## ⚙️ Cấu hình

App ID và App Certificate đã được cấu hình sẵn trong file `server.js`:

- **App ID**: `6093d63485f6406893958f398c53e7c8`
- **App Certificate**: `12d95395baf94a5dabb45cb88b4ffdd7`

### Environment Variables (Tùy chọn)

Bạn có thể set environment variables để override:

```bash
export APP_ID=your-app-id
export APP_CERTIFICATE=your-app-certificate
```

## 🔧 API Endpoint

### GET /agora/token

Generate Agora RTC token.

**Query Parameters:**
- `userId` (required): User ID của người dùng
- `channelName` (required): Tên channel (được tạo tự động từ 2 userIds)

**Response:**
```json
{
  "token": "006abc123def456..."
}
```

**Error Response:**
```json
{
  "error": "Missing userId or channelName"
}
```

## 📱 Cấu hình trong Flutter App

Flutter app tự động chuyển giữa development và production:

- **Development (Debug)**: `http://localhost:3000/agora/token`
- **Production (Release)**: `https://your-backend.com/agora/token`

Xem file `DEPLOY_PRODUCTION.md` để biết cách deploy.

## 🌐 Deploy lên Production

Xem file `DEPLOY_PRODUCTION.md` để có hướng dẫn chi tiết deploy lên:
- Render (miễn phí - khuyến nghị)
- Railway
- Heroku
- Vercel
- AWS/Google Cloud

## 🔒 Bảo mật

⚠️ **Lưu ý:** Khi deploy lên production, nên sử dụng environment variables thay vì hardcode App Certificate trong code.

Trên Render/Railway, thêm environment variables:
- `APP_ID`
- `APP_CERTIFICATE`
