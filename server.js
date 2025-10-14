/*
 * ===================================================================
 * 实时问答平台 - 后端服务器 (server.js)
 * 最终版 - 包含IP地址记录功能
 * ===================================================================
 */

// --- 1. 依赖引入 ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const MongoStore = require('connect-mongo');
const { nanoid } = require('nanoid');

// --- 2. 数据库与数据模型 ---

// a. 连接数据库
const MONGO_URI = process.env.MONGO_URI;
const dbConnectionPromise = mongoose.connect(MONGO_URI)
    .then(m => {
        console.log('成功连接到 MongoDB Atlas');
        return m.connection.getClient();
    })
    .catch(err => {
        console.error('连接 MongoDB 失败，应用将退出:', err);
        process.exit(1);
    });

// b. 定义“场次”数据模型
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) },
    totalConnections: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// c. 定义“问题”数据模型 (新增 ipAddress 字段)
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    ipAddress: { type: String }, // <-- 新增：用于记录IP地址
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);


// --- 3. Express 应用与中间件配置 ---

const app = express();
app.set('trust proxy', 1); // 关键：为了在Render这样的代理后正确获取IP地址

app.use(express.json());
app.use(cookieParser());

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        clientPromise: dbConnectionPromise,
        collectionName: 'user_sessions',
        ttl: 14 * 24 * 60 * 60,
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.status(403).send('Forbidden: Please log in using your secret entry link.');
};


// --- 4. 路由定义 ---

app.get('/entry/:secretPath', (req, res, next) => {
    if (!process.env.ADMIN_SECRET_PATH) {
        console.error("ADMIN_SECRET_PATH is not set in environment variables.");
        return res.status(500).send('Server configuration error.');
    }
    if (req.params.secretPath === process.env.ADMIN_SECRET_PATH) {
        req.session.isAuthenticated = true;
        req.session.save((err) => {
            if (err) return next(err);
            res.redirect('/');
        });
    } else {
        next();
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) { return res.redirect('/'); }
        res.clearCookie('connect.sid');
        res.send('您已成功登出。请通过您的秘密入口链接重新登录。');
    });
});

app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/session/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/session/:code/ask', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.use(express.static(path.join(__dirname, 'public')));


// --- 5. API 接口 ---

// a. 提交新问题 (新增IP地址记录逻辑)
app.post('/api/ask/:code', async (req, res) => {
    const { question, name } = req.body;
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });

        const newQuestion = new Question({
            text: question,
            name: name || '匿名',
            sessionId: session._id,
            ipAddress: req.ip // <-- 新增：从请求中获取IP地址并准备保存
        });
        
        await newQuestion.save();
        
        // 广播给前端的内容，不包含 ipAddress
        broadcastToRoom(session.code, {
            type: 'new_question',
            payload: { _id: newQuestion._id, text: newQuestion.text, name: newQuestion.name }
        });
        
        res.status(200).json({ message: '问题已收到' });
    } catch (e) {
        res.status(500).json({ message: '提交失败' });
    }
});

// b. 其他API接口 (保持不变)
app.post('/api/sessions', checkAuth, async (req, res) => { try { const newSession = new Session({ name: req.body.name }); await newSession.save(); res.status(201).json(newSession); } catch (e) { res.status(500).json({ message: '创建失败' }); } });
app.get('/api/sessions', checkAuth, async (req, res) => { try { const sessions = await Session.find().sort({ createdAt: -1 }); res.json(sessions); } catch (e) { res.status(500).json({ message: '获取列表失败' }); } });
app.delete('/api/questions/:id', checkAuth, async (req, res) => { try { const questionId = req.params.id; if (!mongoose.Types.ObjectId.isValid(questionId)) { return res.status(400).json({ message: '无效的问题ID' }); } const deletedQuestion = await Question.findByIdAndDelete(questionId); if (!deletedQuestion) { return res.status(404).json({ message: '问题未找到' }); } const session = await Session.findById(deletedQuestion.sessionId); if (session) { broadcastToRoom(session.code, { type: 'question_deleted', payload: { questionId: deletedQuestion._id } }); } res.status(200).json({ message: '问题已成功删除' }); } catch (e) { console.error("删除问题失败:", e); res.status(500).json({ message: '服务器错误' }); } });
app.get('/api/questions', checkAuth, async (req, res) => { const { start, end } = req.query; if (!start || !end) { return res.status(400).json({ message: '必须提供开始和结束时间参数' }); } try { const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } }; const filteredQuestions = await Question.find(query).sort({ createdAt: 1 }); res.status(200).json(filteredQuestions); } catch (error) { res.status(500).json({ message: '服务器错误' }); } });
app.get('/api/sessions/:code', async (req, res) => { try { const session = await Session.findOne({ code: req.params.code }); if (!session) return res.status(404).json({ message: '场次不存在' }); const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: -1 }).lean(); res.json({ session, questions }); } catch (e) { res.status(500).json({ message: '获取场次信息失败' }); } });


// --- 6. WebSocket 服务器设置 ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map();
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'join' && data.room) {
                const roomCode = data.room;
                ws.roomCode = roomCode;
                if (!rooms.has(roomCode)) { rooms.set(roomCode, new Set()); }
                rooms.get(roomCode).add(ws);
                console.log(`一个客户端加入了房间: ${roomCode}`);
                await Session.findOneAndUpdate({ code: roomCode }, { $inc: { totalConnections: 1 } });
                const currentCount = rooms.get(roomCode).size;
                broadcastToRoom(roomCode, { type: 'client_count_update', count: currentCount });
            }
        } catch (e) { console.error("解析消息失败", e); }
    });
    ws.on('close', () => {
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            const room = rooms.get(ws.roomCode);
            room.delete(ws);
            console.log(`一个客户端离开了房间: ${ws.roomCode}`);
            if (room.size > 0) {
                const currentCount = room.size;
                broadcastToRoom(ws.roomCode, { type: 'client_count_update', count: currentCount });
            } else {
                rooms.delete(ws.roomCode);
            }
        }
    });
});

function broadcastToRoom(roomCode, data) {
    if (rooms.has(roomCode)) {
        rooms.get(roomCode).forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
}


// --- 7. 启动服务器 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
});