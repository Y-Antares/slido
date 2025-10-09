// server.js

// --- 依赖引入 ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth');
const { nanoid } = require('nanoid'); // 引入 nanoid

// --- 数据库连接 (不变) ---
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// --- 数据模型重构 ---
// 1. 新增：场次 (Session) 的数据模型
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) }, // 6位唯一代码
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// 2. 修改：问题 (Question) 的数据模型，增加 sessionId 字段
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true }, // 关联到场次
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);

// --- Express 应用初始化 ---
const app = express();
app.use(express.json());

// --- 安全与中间件 ---
const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD },
    challenge: true,
});

// --- 路由定义 (完全重构) ---

// 托管 public 文件夹中的静态文件（如 CSS, JS 库等）
app.use(express.static(path.join(__dirname, 'public')));

// 1. 主页/仪表盘路由 (受密码保护)
app.get('/', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 2. 场次展示页和提问页路由 (公开访问)
app.get('/session/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});
app.get('/session/:code/ask', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// 3. 管理员后台路由 (admin.html 被 dashboard.html 替代)
app.get('/admin', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- API 接口 (完全重构) ---

// a. 创建新场次
app.post('/api/sessions', adminAuth, async (req, res) => {
    try {
        const newSession = new Session({ name: req.body.name });
        await newSession.save();
        res.status(201).json(newSession);
    } catch (e) {
        res.status(500).json({ message: '创建失败' });
    }
});

// b. 获取所有场次列表
app.get('/api/sessions', adminAuth, async (req, res) => {
    try {
        const sessions = await Session.find().sort({ createdAt: -1 });
        res.json(sessions);
    } catch (e) {
        res.status(500).json({ message: '获取列表失败' });
    }
});

// c. 获取单个场次的详细信息和所有历史问题
app.get('/api/sessions/:code', async (req, res) => {
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        
        const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: 1 });
        res.json({ session, questions });
    } catch (e) {
        res.status(500).json({ message: '获取场次信息失败' });
    }
});

// d. 提交新问题 (现在需要场次代码)
app.post('/api/ask/:code', async (req, res) => {
    const { question, name } = req.body;
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });

        const newQuestion = new Question({ text: question, name: name || '匿名', sessionId: session._id });
        await newQuestion.save();

        // 通过WebSocket广播新问题到对应的房间
        broadcastToRoom(session.code, {
            type: 'new_question',
            payload: { text: newQuestion.text, name: newQuestion.name }
        });
        res.status(200).json({ message: '问题已收到' });
    } catch (e) {
        res.status(500).json({ message: '提交失败' });
    }
});

// --- 服务器与WebSocket升级 (增加房间逻辑) ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 使用 Map 来存储房间和客户端的对应关系
const rooms = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // 当客户端连接时，会发送一个 'join' 消息来加入房间
            if (data.type === 'join' && data.room) {
                const roomCode = data.room;
                ws.roomCode = roomCode; // 在ws对象上存下房间号

                if (!rooms.has(roomCode)) {
                    rooms.set(roomCode, new Set());
                }
                rooms.get(roomCode).add(ws);
                console.log(`一个客户端加入了房间: ${roomCode}`);
            }
        } catch (e) {
            console.error("解析消息失败", e);
        }
    });

    ws.on('close', () => {
        // 当客户端断开时，将它从房间中移除
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            rooms.get(ws.roomCode).delete(ws);
            console.log(`一个客户端离开了房间: ${ws.roomCode}`);
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

// --- 启动服务器 (不变) ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
});