// --- 依赖引入 (Dependencies) ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session'); // 新增：Session管理
const cookieParser = require('cookie-parser'); // 新增：Cookie解析
const MongoStore = require('connect-mongo');
const { nanoid } = require('nanoid');

// --- 数据库设置 (Database Setup) ---
const MONGO_URI = process.env.MONGO_URI; 
mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// --- 数据模型定义 (Data Models) ---
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) },
    totalConnections: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

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
app.use(cookieParser()); // 使用 cookie-parser

// --- Session认证系统配置 ---
// --- Session认证系统配置 (升级) ---
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // 2. 将 store 配置为 MongoStore
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI, // 使用您的MongoDB连接字符串
        ttl: 14 * 24 * 60 * 60, // Session有效期14天 (可选)
        autoRemove: 'native' // 使用MongoDB原生的TTL功能自动清理过期Session
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7 // Cookie有效期7天
    }
}));


// --- 新的认证守卫中间件 ---
const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next(); // 如果session中认证状态为true，则通过
    }
    res.redirect('/login'); // 否则，重定向到登录页
};


// --- 路由定义 (Routes) ---

// 1. 登录页面的路由 (公开)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2. 登出路由
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid'); // 清除session cookie
        res.redirect('/login');
    });
});

// 3. 仪表盘主页 (使用新的守卫来保护)
app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 4. 旧版数据分析页 (也使用新的守卫)
app.get('/admin', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 5. 场次展示页和提问页 (公开访问)
app.get('/session/:code', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});
app.get('/session/:code/ask', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// 托管 public 文件夹中的其他静态文件
app.use(express.static(path.join(__dirname, 'public')));


// --- API 接口定义 ---

// a. 处理登录请求的API
// a. 处理登录请求的API (*** 核心修改区域 ***)
app.post('/login', (req, res) => {
    // --- 黑匣子诊断开始 ---
    console.log("--- [Login Attempt] ---");
    console.log(`[1] 收到登录请求。时间: ${new Date().toISOString()}`);

    const { username, password } = req.body;
    console.log(`[2] 从浏览器收到的数据: 用户名='${username}', 密码='${password}'`);

    const env_user = process.env.ADMIN_USERNAME;
    const env_pass = process.env.ADMIN_PASSWORD;
    console.log(`[3] 从Render环境变量读取的数据: 用户名='${env_user}', 密码='${env_pass}'`);

    const isMatch = (username === env_user && password === env_pass);
    console.log(`[4] 比对结果 (是否匹配): ${isMatch}`);
    // --- 黑匣子诊断结束 ---

    if (isMatch) {
        req.session.isAuthenticated = true; // 认证成功
        console.log("[5] 认证成功，设置Session并返回200 OK。");
        res.status(200).json({ message: 'Login successful' });
    } else {
        console.log("[5] 认证失败，返回401 Unauthorized。");
        res.status(401).json({ message: 'Invalid credentials' });
    }
    console.log("--- [End of Login Attempt] ---\n");
});

// b. 创建新场次 (受保护)
app.post('/api/sessions', checkAuth, async (req, res) => {
    try {
        const newSession = new Session({ name: req.body.name });
        await newSession.save();
        res.status(201).json(newSession);
    } catch (e) { res.status(500).json({ message: '创建失败' }); }
});

// c. 获取所有场次列表 (受保护)
app.get('/api/sessions', checkAuth, async (req, res) => {
    try {
        const sessions = await Session.find().sort({ createdAt: -1 });
        res.json(sessions);
    } catch (e) { res.status(500).json({ message: '获取列表失败' }); }
});

// d. 删除问题 (受保护)
app.delete('/api/questions/:id', checkAuth, async (req, res) => {
    try {
        const questionId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(questionId)) {
            return res.status(400).json({ message: '无效的问题ID' });
        }
        const deletedQuestion = await Question.findByIdAndDelete(questionId);
        if (!deletedQuestion) {
            return res.status(404).json({ message: '问题未找到' });
        }
        const session = await Session.findById(deletedQuestion.sessionId);
        if (session) {
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

// e. 获取特定时间段问题 (受保护)
app.get('/api/questions', checkAuth, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) {
        return res.status(400).json({ message: '必须提供开始和结束时间参数' });
    }
    try {
        const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } };
        const filteredQuestions = await Question.find(query).sort({ createdAt: 1 });
        res.status(200).json(filteredQuestions);
    } catch (error) { res.status(500).json({ message: '服务器错误' }); }
});

// f. 获取单个场次信息 (公开)
app.get('/api/sessions/:code', async (req, res) => {
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: -1 }).lean();
        res.json({ session, questions });
    } catch (e) { res.status(500).json({ message: '获取场次信息失败' }); }
});

// g. 提交新问题 (公开)
app.post('/api/ask/:code', async (req, res) => {
    const { question, name } = req.body;
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        const newQuestion = new Question({ text: question, name: name || '匿名', sessionId: session._id });
        await newQuestion.save();
        broadcastToRoom(session.code, {
            type: 'new_question',
            payload: { _id: newQuestion._id, text: newQuestion.text, name: newQuestion.name }
        });
        res.status(200).json({ message: '问题已收到' });
    } catch (e) { res.status(500).json({ message: '提交失败' }); }
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

// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
    console.log("--- 环境变量诊断信息 ---");
    console.log(`读取到的 ADMIN_USERNAME: [${process.env.ADMIN_USERNAME}]`);
    console.log(`读取到的 ADMIN_PASSWORD: [${process.env.ADMIN_PASSWORD}]`);
});