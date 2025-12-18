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

  const tokenPairs = await Promise.all(
    targets.map(async (uid) => {
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
  if (!token) return res.json({ sent: false, reason: 'no_token' });

  const title = (callerName || '').toString() || 'Cuộc gọi đến';
  const body = isVideo ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến';

  await admin.messaging().send({
    token: token.toString(),
    notification: { title, body },
    data: {
      type: 'incoming_call',
      callerId: callerId.toString(),
      recipientUserId: recipientUserId.toString(),
      isVideo: isVideo ? 'true' : 'false',
      callId: callId.toString(),
      channelName: channelName.toString(),
    },
    android: { notification: { channelId: 'synap_general' } },
  });

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
    mention: `${actorName} đã nhắc đến bạn`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(
    `✅ Agora Token Server đang chạy tại http://localhost:${PORT}`
  );
  console.log(
    `📝 Test: http://localhost:${PORT}/agora/token?userId=test123&channelName=test_channel`
  );
});
