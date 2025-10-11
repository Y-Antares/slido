/*
 * ===================================================================
 * 实时问答平台 - 后端服务器 (server.js)
 * ===================================================================
 * 功能:
 * - 提供Web服务，托管前端页面
 * - 提供API接口，用于管理场次(Session)和问题(Question)
 * - 实现WebSocket服务，用于实时通信
 * - 通过Session和Cookie实现管理员登录认证
 * ===================================================================
 */

// --- 1. 依赖引入 (Dependencies) ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const MongoStore = require('connect-mongo');
const { nanoid } = require('nanoid');

// --- 2. 数据库与数据模型 (Database & Models) ---

// a. 连接数据库
const MONGO_URI = process.env.MONGO_URI;
const dbConnectionPromise = mongoose.connect(MONGO_URI)
    .then(m => {
        console.log('成功连接到 MongoDB Atlas');
        return m.connection.getClient(); // 返回一个Promise，供connect-mongo使用
    })
    .catch(err => {
        console.error('连接 MongoDB 失败，应用将退出:', err);
        process.exit(1); // 如果数据库连接失败，直接退出程序，防止后续错误
    });

// b. 定义“场次”数据模型
const sessionSchema = new mongoose.Schema({
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, default: () => nanoid(6) },
    totalConnections: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// c. 定义“问题”数据模型
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);


// --- 3. Express 应用与中间件配置 (App & Middleware) ---

const app = express();

// a. 解析请求体中的JSON数据和Cookie
app.use(express.json());
app.use(cookieParser());

// b. 配置 Session 中间件
app.use(session({
    // Secret 用于签名 session ID cookie，防止篡改。必须从环境变量读取。
    secret: process.env.SESSION_SECRET,
    // (resave: false) 强制 session 在未修改时不会被重新保存，提升性能。
    resave: false,
    // (saveUninitialized: false) 强制未初始化的 session (例如新用户) 不会被保存，节省存储空间。
    saveUninitialized: false,
    // 将 session 存储到 MongoDB，以实现持久化
    store: MongoStore.create({
        clientPromise: dbConnectionPromise, // 共享之前已建立的数据库连接
        collectionName: 'user_sessions',    // 指定存储session的集合名称
        ttl: 14 * 24 * 60 * 60,             // Session 在数据库中的有效期：14天
    }),
    // Cookie 配置
    cookie: {
        secure: process.env.NODE_ENV === 'production', // 仅在 https 下发送 cookie
        maxAge: 1000 * 60 * 60 * 24 * 7             // Cookie 在浏览器中的有效期：7天
    }
}));

// c. 认证守卫中间件：检查用户是否已登录
const checkAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next(); // 已登录，继续处理请求
    }
    // 未登录，返回403 Forbidden错误
    res.status(403).send('Forbidden: Please log in using your secret entry link.');
};


// --- 4. 路由定义 (Routes) ---
// 注意：路由定义的顺序非常重要！

// a. 核心认证路由
//  - 秘密登录链接路由
app.get('/entry/:secretPath', (req, res, next) => {
    if (!process.env.ADMIN_SECRET_PATH) {
        console.error("ADMIN_SECRET_PATH is not set in environment variables.");
        return res.status(500).send('Server configuration error.');
    }
    if (req.params.secretPath === process.env.ADMIN_SECRET_PATH) {
        req.session.isAuthenticated = true;
        req.session.save((err) => {
            if (err) return next(err);
            res.redirect('/'); // 登录成功后跳转到仪表盘
        });
    } else {
        next(); // 如果路径不匹配，交给下一个路由处理
    }
});

//  - 登出路由
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.send('您已成功登出。请通过您的秘密入口链接重新登录。');
    });
});

// b. 受保护的管理页面路由
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// c. 公开的场次页面路由
app.get('/session/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/session/:code/ask', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));

// d. 静态文件服务 (放在所有页面路由之后)
app.use(express.static(path.join(__dirname, 'public')));


// --- 5. API 接口 (API Endpoints) ---

// a. 场次管理 API
app.post('/api/sessions', checkAuth, async (req, res) => { try { const newSession = new Session({ name: req.body.name }); await newSession.save(); res.status(201).json(newSession); } catch (e) { res.status(500).json({ message: '创建失败' }); } });
app.get('/api/sessions', checkAuth, async (req, res) => { try { const sessions = await Session.find().sort({ createdAt: -1 }); res.json(sessions); } catch (e) { res.status(500).json({ message: '获取列表失败' }); } });
app.get('/api/sessions/:code', async (req, res) => { try { const session = await Session.findOne({ code: req.params.code }); if (!session) return res.status(404).json({ message: '场次不存在' }); const questions = await Question.find({ sessionId: session._id }).sort({ createdAt: -1 }).lean(); res.json({ session, questions }); } catch (e) { res.status(500).json({ message: '获取场次信息失败' }); } });

// b. 问题管理 API
app.post('/api/ask/:code', async (req, res) => { const { question, name } = req.body; try { const session = await Session.findOne({ code: req.params.code }); if (!session) return res.status(404).json({ message: '场次不存在' }); const newQuestion = new Question({ text: question, name: name || '匿名', sessionId: session._id }); await newQuestion.save(); broadcastToRoom(session.code, { type: 'new_question', payload: { _id: newQuestion._id, text: newQuestion.text, name: newQuestion.name } }); res.status(200).json({ message: '问题已收到' }); } catch (e) { res.status(500).json({ message: '提交失败' }); } });
app.delete('/api/questions/:id', checkAuth, async (req, res) => { try { const questionId = req.params.id; if (!mongoose.Types.ObjectId.isValid(questionId)) { return res.status(400).json({ message: '无效的问题ID' }); } const deletedQuestion = await Question.findByIdAndDelete(questionId); if (!deletedQuestion) { return res.status(404).json({ message: '问题未找到' }); } const session = await Session.findById(deletedQuestion.sessionId); if (session) { broadcastToRoom(session.code, { type: 'question_deleted', payload: { questionId: deletedQuestion._id } }); } res.status(200).json({ message: '问题已成功删除' }); } catch (e) { console.error("删除问题失败:", e); res.status(500).json({ message: '服务器错误' }); } });
app.get('/api/questions', checkAuth, async (req, res) => { const { start, end } = req.query; if (!start || !end) { return res.status(400).json({ message: '必须提供开始和结束时间参数' }); } try { const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } }; const filteredQuestions = await Question.find(query).sort({ createdAt: 1 }); res.status(200).json(filteredQuestions); } catch (error) { res.status(500).json({ message: '服务器错误' }); } });


// --- 6. WebSocket 服务器设置 (WebSocket Server) ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const rooms = new Map(); // 用于存储每个场次的连接

// a. 处理新连接
wss.on('connection', (ws) => {
    // b. 处理收到的消息
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            // 如果是加入房间的请求
            if (data.type === 'join' && data.room) {
                const roomCode = data.room;
                ws.roomCode = roomCode; // 在连接上标记房间号

                if (!rooms.has(roomCode)) {
                    rooms.set(roomCode, new Set());
                }
                rooms.get(roomCode).add(ws);
                console.log(`一个客户端加入了房间: ${roomCode}`);

                // 更新历史总人次并广播当前在线人数
                await Session.findOneAndUpdate({ code: roomCode }, { $inc: { totalConnections: 1 } });
                const currentCount = rooms.get(roomCode).size;
                broadcastToRoom(roomCode, { type: 'client_count_update', count: currentCount });
            }
        } catch (e) {
            console.error("解析消息失败", e);
        }
    });

    // c. 处理连接关闭
    ws.on('close', () => {
        if (ws.roomCode && rooms.has(ws.roomCode)) {
            const room = rooms.get(ws.roomCode);
            room.delete(ws);
            console.log(`一个客户端离开了房间: ${ws.roomCode}`);
            // 广播更新后的人数
            if (room.size > 0) {
                const currentCount = room.size;
                broadcastToRoom(ws.roomCode, { type: 'client_count_update', count: currentCount });
            } else {
                rooms.delete(ws.roomCode); // 如果房间空了，清理Map
            }
        }
    });
});

// d. 广播消息到指定房间的辅助函数
function broadcastToRoom(roomCode, data) {
    if (rooms.has(roomCode)) {
        rooms.get(roomCode).forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
}


// --- 7. 启动服务器 (Start Server) ---

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
});