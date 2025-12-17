const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const cors = require('cors');

const app = express();
app.use(cors());

// ✅ App ID và App Certificate (đọc từ ENV, fallback nếu chưa set)
const APP_ID = process.env.APP_ID || '6093d63485f6406893958f398c53e7c8';
const APP_CERTIFICATE =
  process.env.APP_CERTIFICATE || '12d95395baf94a5dabb45cb88b4ffdd7';

// 📌 Endpoint tạo token
app.get('/agora/token', (req, res) => {
  const { userId, channelName } = req.query;

  if (!userId || !channelName) {
    return res
      .status(400)
      .json({ error: 'Missing userId or channelName' });
  }

  // Convert userId thành UID (số) – phải giống Flutter
  let uid;
  if (/^\d+$/.test(userId)) {
    // Nếu userId toàn số, dùng trực tiếp (KHÔNG mod)
    uid = parseInt(userId, 10);
  } else {
    // Nếu là string, hash giống Flutter
    uid =
      Math.abs(
        userId.split('').reduce((a, b) => {
          a = ((a << 5) - a) + b.charCodeAt(0);
          return a & a;
        }, 0)
      ) % 2147483647; // Max int32
  }

  console.log('Generate token', { userId, uid, channelName });

  // Token hết hạn sau 1 giờ
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs =
    currentTimestamp + expirationTimeInSeconds;

  // Tạo token
  const token = RtcTokenBuilder.buildTokenWithUid(
    APP_ID,
    APP_CERTIFICATE,
    channelName,
    uid,
    RtcRole.PUBLISHER,
    privilegeExpiredTs
  );

  return res.json({ token });
});

// Khởi động server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ Agora Token Server đang chạy tại http://localhost:${PORT}`
  );
  console.log(
    `📝 Test: http://localhost:${PORT}/agora/token?userId=test123&channelName=test_channel`
  );
});
