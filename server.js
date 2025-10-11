// --- 依赖引入 (Dependencies) ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth');
const { nanoid } = require('nanoid');

// --- 数据库设置 (Database Setup) ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// --- 数据模型定义 (Data Models) ---
// 场次 (Session) 的数据模型
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) },
    totalConnections: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// 问题 (Question) 的数据模型
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);

// --- Express 应用初始化 ---
const app = express();
app.use(express.json());

// --- 安全与中间件 (Security & Middleware) ---
const adminAuth = basicAuth({
    users: { [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD },
    challenge: true,
});

// --- 路由定义 (Routes) ---
// 仪表盘主页 (受密码保护)
app.get('/', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 旧版数据分析页 (受密码保护)
app.get('/admin', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 动态场次展示页
app.get('/session/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});
// 动态场次提问页
app.get('/session/:code/ask', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// 托管 public 文件夹中的其他静态文件
app.use(express.static(path.join(__dirname, 'public')));


// --- API 接口定义 ---
// 创建新场次
app.post('/api/sessions', adminAuth, async (req, res) => {
    try {
        const newSession = new Session({ name: req.body.name });
        await newSession.save();
        res.status(201).json(newSession);
    } catch (e) {
        res.status(500).json({ message: '创建失败' });
    }
});

// 获取所有场次列表
app.get('/api/sessions', adminAuth, async (req, res) => {
    try {
        const sessions = await Session.find().sort({ createdAt: -1 });
        res.json(sessions);
    } catch (e) {
        res.status(500).json({ message: '获取列表失败' });
    }
});

// 获取单个场次的详细信息和所有历史问题
app.get('/api/sessions/:code', async (req, res) => {
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        
        // .lean() 可以让返回的对象更轻量，并确保 _id 可用
        const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: 1 }).lean();
        res.json({ session, questions });
    } catch (e) {
        res.status(500).json({ message: '获取场次信息失败' });
    }
});

// 提交新问题
app.post('/api/ask/:code', async (req, res) => {
    const { question, name } = req.body;
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });

        const newQuestion = new Question({ text: question, name: name || '匿名', sessionId: session._id });
        await newQuestion.save();

        broadcastToRoom(session.code, {
            type: 'new_question',
            payload: { 
                _id: newQuestion._id, // <-- 关键新增
                text: newQuestion.text,
                name: newQuestion.name
            }
        });
        res.status(200).json({ message: '问题已收到' });
    } catch (e) { /* ... */ }
});

//删除问题
app.delete('/api/questions/:id', async (req, res) => {
    try {
        const questionId = req.params.id;
        // 验证ID格式是否正确
        if (!mongoose.Types.ObjectId.isValid(questionId)) {
            return res.status(400).json({ message: '无效的问题ID' });
        }

        // 找到并删除问题，同时获取到被删除问题的信息
        const deletedQuestion = await Question.findByIdAndDelete(questionId);

        if (!deletedQuestion) {
            return res.status(404).json({ message: '问题未找到或已被删除' });
        }

        // 找到该问题所属的场次，以便知道要向哪个房间广播
        const session = await Session.findById(deletedQuestion.sessionId);
        if (session) {
            // 广播删除消息
            broadcastToRoom(session.code, {
                type: 'question_deleted',
                payload: { questionId: deletedQuestion._id }
            });
        }

        res.status(200).json({ message: '问题已成功删除' });
    } catch (e) {
        console.error("删除问题失败:", e);
        res.status(500).json({ message: '服务器错误' });
    }
});


// admin页面用于获取特定时间段问题的API接口
app.get('/api/questions', adminAuth, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) {
        return res.status(400).json({ message: '必须提供开始(start)和结束(end)时间参数' });
    }
    try {
        const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } };
        const filteredQuestions = await Question.find(query).sort({ createdAt: 1 });
        res.status(200).json(filteredQuestions);
    } catch (error) {
        res.status(500).json({ message: '服务器错误' });
    }
});

// --- 服务器与WebSocket设置 ---
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

                if (!rooms.has(roomCode)) {
                    rooms.set(roomCode, new Set());
                }
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
            
            // 4. 新增：客户端离开后，也广播最新的实时在线人数
            if (room.size > 0) {
                const currentCount = room.size;
                broadcastToRoom(ws.roomCode, { type: 'client_count_update', count: currentCount });
            } else {
                // 如果房间空了，可以从Map中删除以释放内存
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

// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
});