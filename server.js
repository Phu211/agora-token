const express = require('express');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Simple request log (for Render logs)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
    );
  });
  next();
});

// ✅ App ID và App Certificate (PHẢI để trong env của Render, không hardcode)
const APP_ID = process.env.APP_ID;
const APP_CERTIFICATE = process.env.APP_CERTIFICATE;

// =========================
// Firebase Admin (FCM + Firestore)
// =========================
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!json && !b64) {
    console.warn(
      '[WARN] Missing FIREBASE_SERVICE_ACCOUNT_JSON (or _BASE64). Push endpoints will not work.'
    );
    admin.initializeApp();
    return;
  }

  let serviceAccount;
  try {
    if (json) {
      serviceAccount = JSON.parse(json);
    } else {
      serviceAccount = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
  } catch (e) {
    console.error('[ERROR] Invalid service account env var:', e);
    admin.initializeApp();
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

initFirebaseAdmin();

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing Authorization token' });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function previewBody(messageData) {
  const text = (messageData.content || '').toString().trim();
  if (text) return text;
  if (messageData.imageUrl) return '[Ảnh]';
  if (messageData.videoUrl) return '[Video]';
  if (messageData.audioUrl) return '[Voice]';
  if (messageData.gifUrl) return '[GIF]';
  return 'Bạn có tin nhắn mới';
}

// Kiểm tra xem cuộc trò chuyện có bị tắt thông báo cho user không
async function isConversationMuted(conversationId, userId) {
  if (!conversationId || !userId) return false;
  try {
    const muteDoc = await admin.firestore()
      .collection('conversations')
      .doc(conversationId)
      .collection('mutes')
      .doc(userId)
      .get();
    
    if (!muteDoc.exists) return false;
    
    const data = muteDoc.data();
    const mutedUntil = data?.mutedUntil;
    if (!mutedUntil) return false;
    
    const mutedUntilDate = new Date(mutedUntil);
    const now = new Date();
    // Kiểm tra xem thời gian mute còn hiệu lực không
    return mutedUntilDate > now;
  } catch (e) {
    console.error('Error checking mute status:', e);
    return false; // Mặc định là không mute nếu có lỗi
  }
}

app.get('/agora/token', (req, res) => {
  const { userId, channelName } = req.query;

  if (!userId || !channelName) {
    return res
      .status(400)
      .json({ error: 'Missing userId or channelName' });
  }
  if (!APP_ID || !APP_CERTIFICATE) {
    return res
      .status(500)
      .json({ error: 'Server missing APP_ID/APP_CERTIFICATE env vars' });
  }

  // Convert userId to UID (Agora yêu cầu UID là số)
  let uid;
  if (/^\d+$/.test(userId)) {
    uid = parseInt(userId, 10);
  } else {
    uid =
      Math.abs(
        userId.split('').reduce((a, b) => {
          a = ((a << 5) - a) + b.charCodeAt(0);
          return a & a;
        }, 0)
      ) % 2147483647;
  }

  // 🔍 Log để debug, đặt TRONG handler
  console.log('Generate token', { userId, uid, channelName });

  // Token hết hạn sau 1 giờ
  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs =
    currentTimestamp + expirationTimeInSeconds;

  // Generate token
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

app.get('/health', (_, res) => res.json({ ok: true }));

// =========================
// Push gateway endpoints (Render free)
// =========================

// Direct message push
app.post('/notify/message', requireAuth, async (req, res) => {
  const { messageId, senderId, receiverId, conversationId } = req.body || {};
  if (!messageId || !senderId || !receiverId || !conversationId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (req.user.uid !== senderId) return res.status(403).json({ error: 'Forbidden' });

  // Kiểm tra xem conversation có bị mute cho receiver không
  const isMuted = await isConversationMuted(conversationId, receiverId);
  if (isMuted) {
    console.log(`Conversation ${conversationId} is muted for user ${receiverId}, skipping notification`);
    return res.json({ sent: false, reason: 'muted' });
  }

  const receiverDoc = await admin.firestore().doc(`users/${receiverId}`).get();
  const token = receiverDoc.get('fcmToken');
  if (!token) return res.json({ sent: false, reason: 'no_token' });

  let senderName = 'Synap';
  try {
    const senderDoc = await admin.firestore().doc(`users/${senderId}`).get();
    senderName = senderDoc.get('fullName') || senderDoc.get('username') || senderName;
  } catch (_) {}

  let body = 'Bạn có tin nhắn mới';
  try {
    const msgDoc = await admin.firestore().doc(`messages/${messageId}`).get();
    if (msgDoc.exists) body = previewBody(msgDoc.data() || {});
  } catch (_) {}

  await admin.messaging().send({
    token: token.toString(),
    notification: { title: senderName, body },
    data: {
      type: 'chat_message',
      senderId: senderId.toString(),
      receiverId: receiverId.toString(),
      conversationId: conversationId.toString(),
      messageId: messageId.toString(),
    },
    android: { notification: { channelId: 'synap_general' } },
  });

  return res.json({ sent: true });
});

// Group message push
app.post('/notify/group-message', requireAuth, async (req, res) => {
  const { messageId, senderId, groupId, conversationId } = req.body || {};
  if (!messageId || !senderId || !groupId || !conversationId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (req.user.uid !== senderId) return res.status(403).json({ error: 'Forbidden' });

  const groupDoc = await admin.firestore().doc(`groups/${groupId}`).get();
  const memberIds = (groupDoc.get('memberIds') || []).map((x) => x.toString());
  const targets = memberIds.filter((uid) => uid && uid !== senderId);
  if (!targets.length) return res.json({ sent: false, reason: 'no_targets' });

  // Kiểm tra mute status cho từng user và lọc bỏ những user đã tắt thông báo
  const tokenPairs = await Promise.all(
    targets.map(async (uid) => {
      // Kiểm tra xem conversation có bị mute cho user này không
      const isMuted = await isConversationMuted(conversationId, uid);
      if (isMuted) return null; // Bỏ qua user đã tắt thông báo
      
      const u = await admin.firestore().doc(`users/${uid}`).get();
      const t = u.get('fcmToken');
      return t ? t.toString() : null;
    })
  );
  const tokens = tokenPairs.filter(Boolean);
  if (!tokens.length) return res.json({ sent: false, reason: 'no_token' });

  let senderName = 'Synap';
  try {
    const senderDoc = await admin.firestore().doc(`users/${senderId}`).get();
    senderName = senderDoc.get('fullName') || senderDoc.get('username') || senderName;
  } catch (_) {}

  let body = 'Bạn có tin nhắn mới';
  try {
    const msgDoc = await admin.firestore().doc(`messages/${messageId}`).get();
    if (msgDoc.exists) body = previewBody(msgDoc.data() || {});
  } catch (_) {}

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: senderName, body },
    data: {
      type: 'group_chat_message',
      senderId: senderId.toString(),
      groupId: groupId.toString(),
      conversationId: conversationId.toString(),
      messageId: messageId.toString(),
    },
    android: { notification: { channelId: 'synap_general' } },
  });

  return res.json({ sent: true, tokens: tokens.length });
});

// Incoming call push
app.post('/notify/call', requireAuth, async (req, res) => {
  const { callId, callerId, recipientUserId, channelName, isVideo, callerName } =
    req.body || {};
  if (!callId || !callerId || !recipientUserId || !channelName) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (req.user.uid !== callerId) return res.status(403).json({ error: 'Forbidden' });

  const receiverDoc = await admin.firestore().doc(`users/${recipientUserId}`).get();
  const token = receiverDoc.get('fcmToken');
  if (!token) {
    console.log(`No FCM token found for user ${recipientUserId}. User needs to log in to receive calls when app is closed.`);
    return res.json({ sent: false, reason: 'no_token' });
  }
  
  console.log(`Sending call notification to user ${recipientUserId} with token: ${token.substring(0, 20)}...`);

  const title = (callerName || '').toString() || 'Cuộc gọi đến';
  const body = isVideo ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến';

  // Gửi notification với priority cao và sound để nhận cuộc gọi khi app ở background/terminated
  // Đảm bảo notification hiển thị ngay cả khi app terminated
  const message = {
    token: token.toString(),
    notification: { 
      title, 
      body,
      sound: 'default', // Phát âm thanh
    },
    data: {
      type: 'incoming_call',
      callerId: callerId.toString(),
      recipientUserId: recipientUserId.toString(),
      isVideo: isVideo ? 'true' : 'false',
      callId: callId.toString(),
      channelName: channelName.toString(),
      callerName: callerName?.toString() || '',
      // Thêm click_action để đảm bảo notification có thể tap được
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: { 
      notification: { 
        channelId: 'synap_calls', // Dùng channel riêng cho calls với priority cao nhất
        priority: 'max', // Max priority để hiển thị ngay cả khi app terminated
        sound: 'default',
        visibility: 'public',
        // Thêm actions cho notification
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        // Đảm bảo notification hiển thị ngay cả khi app terminated
        notificationCount: 1,
        // Thêm tag để có thể update notification
        tag: `call_${callId}`,
      },
      priority: 'high', // High priority message
      // Đảm bảo notification hiển thị ngay cả khi app terminated
      ttl: 3600000, // 1 hour TTL
      // Direct boot ok để notification hiển thị ngay cả khi device khởi động lại
      directBootOk: true,
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          'content-available': 1,
          'mutable-content': 1,
          'interruption-level': 'critical', // Critical interruption cho iOS
          // Đảm bảo notification hiển thị ngay cả khi app terminated
          alert: {
            title: title,
            body: body,
          },
          // Thêm category để có thể xử lý action buttons
          category: 'INCOMING_CALL',
        },
      },
      // Thêm headers để đảm bảo notification được gửi ngay
      headers: {
        'apns-priority': '10', // High priority cho iOS (0-10, 10 là cao nhất)
        'apns-push-type': 'alert', // Đảm bảo notification hiển thị ngay
      },
    },
    // Web push config (nếu có)
    webpush: {
      notification: {
        title: title,
        body: body,
        icon: '/icon.png',
        badge: '/badge.png',
        requireInteraction: true, // Yêu cầu user tương tác
      },
      fcmOptions: {
        link: '/call',
      },
    },
  };

  try {
    await admin.messaging().send(message);
    console.log(`Call notification sent successfully to user ${recipientUserId}`);
  } catch (error) {
    console.error(`Error sending call notification: ${error}`);
    // Không throw để không làm gián đoạn cuộc gọi
  }

  return res.json({ sent: true });
});

// App notification push (like/follow/friendRequest...)
app.post('/notify/app-notification', requireAuth, async (req, res) => {
  const { notificationId, userId, actorId, notificationType, postId, commentId } =
    req.body || {};
  if (!notificationId || !userId || !actorId || !notificationType) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  if (req.user.uid !== actorId) return res.status(403).json({ error: 'Forbidden' });

  const receiverDoc = await admin.firestore().doc(`users/${userId}`).get();
  const token = receiverDoc.get('fcmToken');
  if (!token) return res.json({ sent: false, reason: 'no_token' });

  let actorName = 'Ai đó';
  try {
    const actorDoc = await admin.firestore().doc(`users/${actorId}`).get();
    actorName = actorDoc.get('fullName') || actorDoc.get('username') || actorName;
  } catch (_) {}

  // Reuse the same texts as client UI
  const bodyByType = {
    like: `${actorName} đã thích bài viết của bạn`,
    comment: `${actorName} đã bình luận bài viết của bạn`,
    reply: `${actorName} đã phản hồi bình luận của bạn`,
    follow: `${actorName} đã theo dõi bạn`,
    share: `${actorName} đã chia sẻ bài viết của bạn`,
    mention: `${actorName} đã gắn thẻ bạn trong bài viết`,
    friendRequest: `${actorName} đã gửi lời mời kết bạn`,
  };
  const body = bodyByType[notificationType] || 'Bạn có thông báo mới';

  await admin.messaging().send({
    token: token.toString(),
    notification: { title: 'Synap', body },
    data: {
      type: 'app_notification',
      notificationId: notificationId.toString(),
      notificationType: notificationType.toString(),
      userId: userId.toString(),
      actorId: actorId.toString(),
      postId: (postId || '').toString(),
      commentId: (commentId || '').toString(),
    },
    android: { notification: { channelId: 'synap_general' } },
  });

  return res.json({ sent: true });
});

// =========================
// SendGrid Email Setup
// =========================
const sgMail = require('@sendgrid/mail');
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
} else {
  console.warn('[WARN] Missing SENDGRID_API_KEY. Email endpoints will not work.');
}

// Send security alert email
app.post('/notify/security-alert', requireAuth, async (req, res) => {
  const { userId, activityType, details, detectedAt } = req.body || {};

  if (!userId || !activityType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Verify user owns this userId
  if (req.user.uid !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!SENDGRID_API_KEY) {
    return res.status(500).json({ error: 'SendGrid not configured' });
  }

  try {
    // Get user email from Firestore
    const userDoc = await admin.firestore().doc(`users/${userId}`).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userEmail = userDoc.get('email');
    if (!userEmail) {
      return res.status(400).json({ error: 'User email not found' });
    }

    // Email content based on activity type
    let subject, htmlContent, textContent;

    switch (activityType) {
      case 'newDevice':
        subject = '🔒 Cảnh báo Bảo mật: Đăng nhập từ thiết bị mới';
        htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f44336; color: white; padding: 20px; text-align: center;">
              <h1>🔒 Cảnh báo Bảo mật</h1>
            </div>
            <div style="background-color: #f9f9f9; padding: 20px;">
              <h2>⚠️ Đăng nhập từ thiết bị mới</h2>
              <p><strong>Thiết bị:</strong> ${details || 'Không xác định'}</p>
              <p><strong>Thời gian:</strong> ${detectedAt || new Date().toISOString()}</p>
              <p style="color: #d32f2f; font-weight: bold;">Nếu không phải bạn, vui lòng đổi mật khẩu ngay lập tức!</p>
            </div>
            <div style="text-align: center; padding: 20px; font-size: 12px; color: #666;">
              <p>Email này được gửi tự động. Vui lòng không trả lời.</p>
            </div>
          </div>
        `;
        textContent = `Cảnh báo Bảo mật\n\n⚠️ Đăng nhập từ thiết bị mới\nThiết bị: ${details || 'Không xác định'}\nThời gian: ${detectedAt || new Date().toISOString()}\n\nNếu không phải bạn, vui lòng đổi mật khẩu ngay lập tức!`;
        break;

      case 'multipleFailedLogins':
        subject = '🔒 Cảnh báo Bảo mật: Nhiều lần đăng nhập sai';
        htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f44336; color: white; padding: 20px; text-align: center;">
              <h1>🔒 Cảnh báo Bảo mật</h1>
            </div>
            <div style="background-color: #f9f9f9; padding: 20px;">
              <h2>⚠️ Nhiều lần đăng nhập sai</h2>
              <p><strong>Chi tiết:</strong> ${details || 'Nhiều lần đăng nhập sai gần đây'}</p>
              <p><strong>Thời gian:</strong> ${detectedAt || new Date().toISOString()}</p>
              <p style="color: #d32f2f; font-weight: bold;">Nếu không phải bạn, vui lòng kiểm tra tài khoản ngay!</p>
            </div>
            <div style="text-align: center; padding: 20px; font-size: 12px; color: #666;">
              <p>Email này được gửi tự động. Vui lòng không trả lời.</p>
            </div>
          </div>
        `;
        textContent = `Cảnh báo Bảo mật\n\n⚠️ Nhiều lần đăng nhập sai\nChi tiết: ${details || 'Nhiều lần đăng nhập sai gần đây'}\nThời gian: ${detectedAt || new Date().toISOString()}\n\nNếu không phải bạn, vui lòng kiểm tra tài khoản ngay!`;
        break;

      case 'passwordChanged':
        subject = '🔒 Thông báo: Mật khẩu đã được thay đổi';
        htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #2196F3; color: white; padding: 20px; text-align: center;">
              <h1>🔐 Thông báo Bảo mật</h1>
            </div>
            <div style="background-color: #f9f9f9; padding: 20px;">
              <h2>🔐 Mật khẩu đã được thay đổi</h2>
              <p><strong>Thời gian:</strong> ${detectedAt || new Date().toISOString()}</p>
              <p style="color: #d32f2f; font-weight: bold;">Nếu không phải bạn, vui lòng liên hệ hỗ trợ ngay!</p>
            </div>
            <div style="text-align: center; padding: 20px; font-size: 12px; color: #666;">
              <p>Email này được gửi tự động. Vui lòng không trả lời.</p>
            </div>
          </div>
        `;
        textContent = `Thông báo Bảo mật\n\n🔐 Mật khẩu đã được thay đổi\nThời gian: ${detectedAt || new Date().toISOString()}\n\nNếu không phải bạn, vui lòng liên hệ hỗ trợ ngay!`;
        break;

      case 'emailChanged':
        subject = '🔒 CẢNH BÁO: Email đã được thay đổi';
        htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f44336; color: white; padding: 20px; text-align: center;">
              <h1>🔒 CẢNH BÁO Bảo mật</h1>
            </div>
            <div style="background-color: #f9f9f9; padding: 20px;">
              <h2>📧 Email đã được thay đổi</h2>
              <p><strong>Chi tiết:</strong> ${details || 'Email đã được thay đổi'}</p>
              <p><strong>Thời gian:</strong> ${detectedAt || new Date().toISOString()}</p>
              <p style="color: #d32f2f; font-weight: bold; font-size: 18px;">⚠️ CẢNH BÁO: Nếu không phải bạn, vui lòng liên hệ hỗ trợ ngay lập tức!</p>
            </div>
            <div style="text-align: center; padding: 20px; font-size: 12px; color: #666;">
              <p>Email này được gửi tự động. Vui lòng không trả lời.</p>
            </div>
          </div>
        `;
        textContent = `CẢNH BÁO Bảo mật\n\n📧 Email đã được thay đổi\nChi tiết: ${details || 'Email đã được thay đổi'}\nThời gian: ${detectedAt || new Date().toISOString()}\n\n⚠️ CẢNH BÁO: Nếu không phải bạn, vui lòng liên hệ hỗ trợ ngay lập tức!`;
        break;

      default:
        subject = '🔒 Cảnh báo Bảo mật';
        htmlContent = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f44336; color: white; padding: 20px; text-align: center;">
              <h1>🔒 Cảnh báo Bảo mật</h1>
            </div>
            <div style="background-color: #f9f9f9; padding: 20px;">
              <p>Phát hiện hoạt động đáng ngờ trong tài khoản của bạn.</p>
              <p><strong>Chi tiết:</strong> ${details || 'Hoạt động đáng ngờ'}</p>
              <p><strong>Thời gian:</strong> ${detectedAt || new Date().toISOString()}</p>
            </div>
            <div style="text-align: center; padding: 20px; font-size: 12px; color: #666;">
              <p>Email này được gửi tự động. Vui lòng không trả lời.</p>
            </div>
          </div>
        `;
        textContent = `Cảnh báo Bảo mật\n\nPhát hiện hoạt động đáng ngờ trong tài khoản của bạn.\nChi tiết: ${details || 'Hoạt động đáng ngờ'}\nThời gian: ${detectedAt || new Date().toISOString()}`;
    }

    // Send email via SendGrid
    const msg = {
      to: userEmail,
      from: process.env.SENDGRID_FROM_EMAIL || 'haphu4192@gmail.com', // Must be verified sender
      subject: subject,
      text: textContent,
      html: htmlContent,
    };

    await sgMail.send(msg);

    return res.json({ sent: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('[ERROR] SendGrid email error:', error);
    return res.status(500).json({
      error: 'Failed to send email',
      details: error.message,
    });
  }
});

// Send welcome email after registration
app.post('/notify/welcome-email', async (req, res) => {
  const { userId, email, fullName, username } = req.body || {};

  if (!userId || !email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!SENDGRID_API_KEY) {
    return res.status(500).json({ error: 'SendGrid not configured' });
  }

  try {
    const subject = '🎉 Chào mừng bạn đến với Synap!';
    const displayName = fullName || username || 'Bạn';
    
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
          <h1 style="margin: 0; font-size: 32px;">🎉 Chào mừng đến với Synap!</h1>
        </div>
        <div style="background-color: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="font-size: 18px; color: #333; margin-bottom: 20px;">Xin chào <strong>${displayName}</strong>!</p>
          <p style="color: #666; line-height: 1.6; margin-bottom: 20px;">
            Cảm ơn bạn đã tham gia cộng đồng Synap! Chúng tôi rất vui mừng được chào đón bạn.
          </p>
          
          <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h2 style="color: #667eea; margin-top: 0; font-size: 20px;">🚀 Bắt đầu khám phá:</h2>
            <ul style="color: #666; line-height: 1.8; padding-left: 20px;">
              <li><strong>📝 Đăng bài viết:</strong> Chia sẻ khoảnh khắc của bạn với bạn bè</li>
              <li><strong>📖 Stories:</strong> Tạo stories 24h để kể câu chuyện của bạn</li>
              <li><strong>💬 Nhắn tin:</strong> Kết nối và trò chuyện với bạn bè</li>
              <li><strong>📞 Cuộc gọi:</strong> Gọi video/voice với người thân</li>
              <li><strong>👥 Kết bạn:</strong> Tìm và kết nối với những người bạn mới</li>
            </ul>
          </div>

          <div style="background-color: #e3f2fd; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2196F3;">
            <p style="color: #1976d2; margin: 0; font-weight: bold;">📧 Xác thực email của bạn</p>
            <p style="color: #666; margin: 10px 0 0 0; font-size: 14px;">
              Để đảm bảo tài khoản của bạn được bảo mật, vui lòng xác thực email bằng cách click vào link trong email xác thực mà chúng tôi đã gửi cho bạn.
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="#" style="background-color: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
              Khám phá Synap ngay
            </a>
          </div>

          <p style="color: #999; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
            Nếu bạn có bất kỳ câu hỏi nào, đừng ngần ngại liên hệ với chúng tôi. Chúng tôi luôn sẵn sàng hỗ trợ bạn!
          </p>
        </div>
        <div style="background-color: #f9f9f9; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; border: 1px solid #e0e0e0; border-top: none;">
          <p style="margin: 0; font-size: 12px; color: #666;">
            Email này được gửi tự động. Vui lòng không trả lời email này.
          </p>
          <p style="margin: 10px 0 0 0; font-size: 12px; color: #999;">
            © ${new Date().getFullYear()} Synap. Tất cả quyền được bảo lưu.
          </p>
        </div>
      </div>
    `;

    const textContent = `Chào mừng đến với Synap!\n\nXin chào ${displayName}!\n\nCảm ơn bạn đã tham gia cộng đồng Synap! Chúng tôi rất vui mừng được chào đón bạn.\n\nBắt đầu khám phá:\n- Đăng bài viết: Chia sẻ khoảnh khắc của bạn với bạn bè\n- Stories: Tạo stories 24h để kể câu chuyện của bạn\n- Nhắn tin: Kết nối và trò chuyện với bạn bè\n- Cuộc gọi: Gọi video/voice với người thân\n- Kết bạn: Tìm và kết nối với những người bạn mới\n\nXác thực email của bạn:\nĐể đảm bảo tài khoản của bạn được bảo mật, vui lòng xác thực email bằng cách click vào link trong email xác thực mà chúng tôi đã gửi cho bạn.\n\nNếu bạn có bất kỳ câu hỏi nào, đừng ngần ngại liên hệ với chúng tôi.\n\n© ${new Date().getFullYear()} Synap. Tất cả quyền được bảo lưu.`;

    // Send email via SendGrid
    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM_EMAIL || 'haphu4192@gmail.com', // Must be verified sender
      subject: subject,
      text: textContent,
      html: htmlContent,
    };

    await sgMail.send(msg);

    return res.json({ sent: true, message: 'Welcome email sent successfully' });
  } catch (error) {
    console.error('[ERROR] SendGrid welcome email error:', error);
    return res.status(500).json({
      error: 'Failed to send welcome email',
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ Agora Token Server đang chạy tại http://localhost:${PORT}`
  );
  console.log(
    `📝 Test: http://localhost:${PORT}/agora/token?userId=test123&channelName=test_channel`
  );
});
