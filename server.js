// --- 依赖引入 (Dependencies) ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth');
const { nanoid } = require('nanoid');

// --- 数据库连接 (Database Setup) ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// --- 数据模型定义 (Data Models) ---

// 1. 场次 (Session) 模型
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) },
    totalConnections: { type: Number, default: 0 }, // 记录历史总参与人次
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// 2. 问题 (Question) 模型
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    ipAddress: String, // 记录提问者 IP 地址
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);

// 3. 中奖记录 (LotteryRecord) 模型
const lotteryRecordSchema = new mongoose.Schema({
    sessionName: String,
    sessionCode: String,
    date: String, // 抽奖针对的问题日期
    questionText: String,
    userName: String,
    createdAt: { type: Date, default: Date.now }
});
const LotteryRecord = mongoose.model('LotteryRecord', lotteryRecordSchema);

// --- Express 应用初始化 ---
const app = express();
app.use(express.json());

// --- 安全与中间件 (Security & Middleware) ---
const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD },
    challenge: true,
    realm: 'SlidoAdmin'
});

// --- 路由定义 (Routes) ---

// 1. 保护后台管理页面
app.get('/', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/admin', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 2. 动态场次展示与提问页 (公开)
app.get('/session/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});

app.get('/session/:code/ask', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// 3. 抽奖与记录页 (公开)
app.get('/lottery.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lottery.html'));
});

app.get('/records.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'records.html'));
});

// 托管其他静态资源
app.use(express.static(path.join(__dirname, 'public')));

// --- API 接口定义 ---

// A. 场次管理 API
app.post('/api/sessions', adminAuth, async (req, res) => {
    try {
        const newSession = new Session({ name: req.body.name });
        await newSession.save();
        res.status(201).json(newSession);
    } catch (e) { res.status(500).json({ message: '创建场次失败' }); }
});

app.get('/api/sessions', adminAuth, async (req, res) => {
    try {
        const sessions = await Session.find().sort({ createdAt: -1 });
        res.json(sessions);
    } catch (e) { res.status(500).json({ message: '获取列表失败' }); }
});

app.get('/api/sessions/:code', async (req, res) => {
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: 1 });
        res.json({ session, questions });
    } catch (e) { res.status(500).json({ message: '获取信息失败' }); }
});

// B. 提问与删除 API
app.post('/api/ask/:code', async (req, res) => {
    const { question, name } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; // 获取 IP
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });

        const newQuestion = new Question({ 
            text: question, 
            name: name || '匿名', 
            sessionId: session._id,
            ipAddress: ip 
        });
        await newQuestion.save();

        broadcastToRoom(session.code, {
            type: 'new_question',
            payload: newQuestion // 发送完整对象包含 ID 和时间
        });
        res.status(200).json({ message: '问题已收到' });
    } catch (e) { res.status(500).json({ message: '提交失败' }); }
});

app.delete('/api/questions/:id', async (req, res) => {
    try {
        const question = await Question.findByIdAndDelete(req.params.id);
        if (question) {
            const session = await Session.findById(question.sessionId);
            broadcastToRoom(session.code, { 
                type: 'question_deleted', 
                payload: { questionId: req.params.id } 
            });
        }
        res.json({ message: '已删除' });
    } catch (e) { res.status(500).json({ message: '删除失败' }); }
});

// C. 数据导出 API
app.get('/api/questions', adminAuth, async (req, res) => {
    const { start, end } = req.query;
    try {
        const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } };
        const filteredQuestions = await Question.find(query).sort({ createdAt: 1 });
        res.status(200).json(filteredQuestions);
    } catch (error) { res.status(500).json({ message: '服务器错误' }); }
});

// D. 中奖记录 API
app.post('/api/lottery-records', async (req, res) => {
    try {
        const record = new LotteryRecord(req.body);
        await record.save();
        res.status(201).json(record);
    } catch (e) { res.status(500).json({ message: '保存记录失败' }); }
});

app.get('/api/lottery-records', async (req, res) => {
    try {
        const records = await LotteryRecord.find().sort({ createdAt: -1 });
        res.json(records);
    } catch (e) { res.status(500).json({ message: '获取记录失败' }); }
});

// --- WebSocket 房间逻辑 (Rooms & Real-time) ---
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

                if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
                rooms.get(roomCode).add(ws);

                // 更新历史总连接数并广播当前在线人数
                await Session.findOneAndUpdate({ code: roomCode }, { $inc: { totalConnections: 1 } });
                broadcastCount(roomCode);
            }
        } catch (e) { console.error("WS 消息解析失败", e); }
    });

    ws.on('close', () => {
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            rooms.get(ws.roomCode).delete(ws);
            broadcastCount(ws.roomCode);
        }
    });
});

function broadcastCount(roomCode) {
    if (rooms.has(roomCode)) {
        const count = rooms.get(roomCode).size;
        broadcastToRoom(roomCode, { type: 'client_count_update', count: count });
    }
}

function broadcastToRoom(roomCode, data) {
    if (rooms.has(roomCode)) {
        rooms.get(roomCode).forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
}

// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在端口 ${PORT} 上运行`);
});