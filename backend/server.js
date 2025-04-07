const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cors = require('cors');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ✅ Multer Storage with Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    upload_preset: 'my_preset', // 🛠️ Ensure this matches Cloudinary preset
    folder: 'mySocial/posts',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'avi', 'webm', 'mp3', 'wav'],
    resource_type: 'auto' // Auto-detect image/video/audio
  }
});

const upload = multer({ storage });

// ✅ Firebase Admin Setup
const serviceAccount = require('./firebase-service-account-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://social-media-98249.firebaseio.com"
});
const db = admin.firestore();

// ✅ Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mysocialsecret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// ✅ Serve Static Files
app.use(express.static(path.join(__dirname, '../frontend')));

// ✅ Authentication Middleware
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ✅ Cloudinary Image Upload Route
app.post('/api/upload', authenticateUser, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded or invalid file type' });
    }

    // ✅ Correct way to get Cloudinary URL
    const mediaUrl = req.file.path; // Cloudinary Secure URL
    const mediaType = req.file.mimetype.startsWith('image') ? 'image' : 'video'; // Detect type
    const publicId = req.file.filename || req.file.originalname; // Correct ID retrieval

    console.log('✅ Cloudinary Upload Success:', { url: mediaUrl, type: mediaType, publicId });

    res.status(200).json({
      success: true,
      url: mediaUrl,
      type: mediaType,
      publicId: publicId
    });
  } catch (error) {
    console.error('🚨 Upload error:', error.message);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// ✅ Create Post API
app.post('/api/posts', authenticateUser, async (req, res) => {
  try {
    const { caption, location, mediaUrl, mediaType, tags, filterApplied, postType } = req.body;
    if (!mediaUrl || !mediaType) {
      return res.status(400).json({ error: 'Media URL and type are required' });
    }

    const postData = {
      userId: req.user.uid,
      caption: caption || '',
      location: location || '',
      mediaUrl,
      mediaType,
      tags: tags || [],
      filterApplied: filterApplied || 'Normal',
      postType: postType || 'post',
      likes: 0,
      comments: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    console.log('✅ Post Created:', postData);

    const postRef = await db.collection('posts').add(postData);
    await db.collection('users').doc(req.user.uid).update({
      posts: admin.firestore.FieldValue.arrayUnion(postRef.id)
    });
    res.status(201).json({
      success: true,
      postId: postRef.id,
      message: 'Post created successfully'
    });
  } catch (error) {
    console.error('🚨 Create post error:', error);
    res.status(500).json({ error: 'Failed to create post', details: error.message });
  }
});

// ✅ Create Story API
app.post('/api/stories', authenticateUser, async (req, res) => {
  try {
    const { mediaUrl, mediaType, duration, music, stickers } = req.body;
    if (!mediaUrl || !mediaType) {
      return res.status(400).json({ error: 'Media URL and type are required' });
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    const storyData = {
      userId: req.user.uid,
      mediaUrl,
      mediaType,
      duration: duration || '15s',
      music: music || null,
      stickers: stickers || [],
      viewers: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt)
    };

    console.log('✅ Story Created:', storyData);

    const storyRef = await db.collection('stories').add(storyData);
    res.status(201).json({
      success: true,
      storyId: storyRef.id,
      message: 'Story created successfully'
    });
  } catch (error) {
    console.error('🚨 Create story error:', error);
    res.status(500).json({ error: 'Failed to create story', details: error.message });
  }
});

// ✅ NEW: Get Posts API - Get all posts (with pagination)
app.get('/api/posts', authenticateUser, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const lastVisible = req.query.lastVisible || null;
    
    let postsQuery = db.collection('posts')
      .orderBy('createdAt', 'desc')
      .limit(limit);
    
    // Apply pagination if lastVisible is provided
    if (lastVisible) {
      const lastDoc = await db.collection('posts').doc(lastVisible).get();
      if (lastDoc.exists) {
        postsQuery = postsQuery.startAfter(lastDoc);
      }
    }
    
    const postsSnapshot = await postsQuery.get();
    const posts = [];
    
    for (const doc of postsSnapshot.docs) {
      const postData = doc.data();
      const userDoc = await db.collection('users').doc(postData.userId).get();
      
      posts.push({
        id: doc.id,
        ...postData,
        user: userDoc.exists ? {
          id: userDoc.id,
          displayName: userDoc.data().displayName || 'User',
          photoURL: userDoc.data().photoURL || '',
        } : { displayName: 'Unknown User', photoURL: '' },
        createdAt: postData.createdAt ? postData.createdAt.toDate() : null,
        updatedAt: postData.updatedAt ? postData.updatedAt.toDate() : null
      });
    }
    
    const lastVisibleId = postsSnapshot.docs.length > 0 ? 
      postsSnapshot.docs[postsSnapshot.docs.length - 1].id : null;
    
    console.log(`✅ Fetched ${posts.length} posts`);
    
    res.status(200).json({
      success: true,
      posts,
      lastVisible: lastVisibleId,
      hasMore: postsSnapshot.docs.length === limit
    });
  } catch (error) {
    console.error('🚨 Get posts error:', error);
    res.status(500).json({ error: 'Failed to fetch posts', details: error.message });
  }
});



// ✅ NEW: Get Post by ID
app.get('/api/posts/:postId', authenticateUser, async (req, res) => {
  try {
    const postId = req.params.postId;
    const postDoc = await db.collection('posts').doc(postId).get();
    
    if (!postDoc.exists) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const postData = postDoc.data();
    const userDoc = await db.collection('users').doc(postData.userId).get();
    
    const post = {
      id: postDoc.id,
      ...postData,
      user: userDoc.exists ? {
        id: userDoc.id,
        displayName: userDoc.data().displayName || 'User',
        photoURL: userDoc.data().photoURL || '',
      } : { displayName: 'Unknown User', photoURL: '' },
      createdAt: postData.createdAt ? postData.createdAt.toDate() : null,
      updatedAt: postData.updatedAt ? postData.updatedAt.toDate() : null
    };
    
    console.log(`✅ Fetched post: ${postId}`);
    
    res.status(200).json({
      success: true,
      post
    });
  } catch (error) {
    console.error('🚨 Get post error:', error);
    res.status(500).json({ error: 'Failed to fetch post', details: error.message });
  }
});

// ✅ NEW: Get User Posts API
app.get('/api/users/:userId/posts', authenticateUser, async (req, res) => {
  try {
    const userId = req.params.userId;
    const limit = parseInt(req.query.limit) || 10;
    const lastVisible = req.query.lastVisible || null;
    
    let postsQuery = db.collection('posts')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(limit);
    
    // Apply pagination if lastVisible is provided
    if (lastVisible) {
      const lastDoc = await db.collection('posts').doc(lastVisible).get();
      if (lastDoc.exists) {
        postsQuery = postsQuery.startAfter(lastDoc);
      }
    }
    
    const postsSnapshot = await postsQuery.get();
    const posts = postsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt ? doc.data().createdAt.toDate() : null,
      updatedAt: doc.data().updatedAt ? doc.data().updatedAt.toDate() : null
    }));
    
    const lastVisibleId = postsSnapshot.docs.length > 0 ? 
      postsSnapshot.docs[postsSnapshot.docs.length - 1].id : null;
    
    console.log(`✅ Fetched ${posts.length} posts for user: ${userId}`);
    
    res.status(200).json({
      success: true,
      posts,
      lastVisible: lastVisibleId,
      hasMore: postsSnapshot.docs.length === limit
    });
  } catch (error) {
    console.error('🚨 Get user posts error:', error);
    res.status(500).json({ error: 'Failed to fetch user posts', details: error.message });
  }
});

// ✅ Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});