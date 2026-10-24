// --- 依赖引入 (Dependencies) ---
const express = require('express');
const { createHash, randomInt } = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth');
const { nanoid } = require('nanoid');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const AipSpeechClient = require('baidu-aip-sdk').speech;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

// --- 百度语音配置 ---
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
const APP_ID = process.env.BAIDU_APP_ID || '你的APP_ID';
const API_KEY = process.env.BAIDU_API_KEY || '你的API_KEY';
const SECRET_KEY = process.env.BAIDU_SECRET_KEY || '你的SECRET_KEY';
const baiduClient = new AipSpeechClient(APP_ID, API_KEY, SECRET_KEY);
const upload = multer({ dest: os.tmpdir() });

// --- 数据库连接 (Database Setup) ---
const MONGO_URI = process.env.MONGO_URI; 
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
    participantId: { type: String, select: false },
    questionHash: { type: String, select: false },
    ipAddress: String, // 记录提问者 IP 地址
    createdAt: { type: Date, default: Date.now }
});
// 旧数据没有 participantId/questionHash，保留原样；新数据由数据库原子去重。
questionSchema.set('autoIndex', false);
questionSchema.index({ sessionId: 1, participantId: 1, questionHash: 1 }, {
    name: 'unique_participant_question_v1', unique: true,
    partialFilterExpression: { participantId: { $type: 'string' }, questionHash: { $type: 'string' } }
});
const Question = mongoose.model('Question', questionSchema);

function normalizeQuestion(text) {
    return text.replace(/\r\n?/g, '\n').trim();
}
function chinaDate(value) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(value)).replace(/-/g, '/');
}
function chinaPeriod(value) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23'
    }).format(new Date(value)));
    return hour < 12 ? 'am' : 'pm';
}
function buildLotteryPool(questions, period = 'all') {
    const groups = new Map();
    for (const q of questions) {
        if (!q.text || !q.text.trim()) continue;
        // 匿名提问可以保留在展示墙，但不获得抽奖资格（包括历史记录）。
        const nickname = typeof q.name === 'string' ? q.name.trim() : '';
        if (!nickname || nickname === '匿名') continue;
        // 必须先按时段筛选，再按人合并，避免上午问题把下午参与资格挤掉。
        if (period !== 'all' && chinaPeriod(q.createdAt) !== period) continue;
        // 新记录按参与者 ID 合并；历史具名记录按姓名合并。
        const identity = q.participantId ? `id:${q.participantId}` : `legacy:${nickname}`;
        const key = JSON.stringify([chinaDate(q.createdAt), identity]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(q);
    }
    return [...groups.values()].map(items => {
        const q = items[randomInt(items.length)];
        return { _id: q._id, name: q.name.trim(), text: q.text,
            createdAt: q.createdAt, questionCount: items.length };
    });
}

// 3. 中奖记录 (LotteryRecord) 模型
const lotteryRecordSchema = new mongoose.Schema({
    sessionName: String,
    sessionCode: String,
    date: String, // 抽奖针对的问题日期（北京时间）
    period: { type: String, enum: ['all', 'am', 'pm'], default: 'all' },
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
app.get('/lottery-flip.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lottery-flip.html'));
});

app.get('/lottery-ball.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lottery-ball.html'));
});

app.get('/records.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'records.html'));
});

// 4. 提问成功页
app.get('/session/:code/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'success.html'));
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

// 同一场次可按日期和上下午抽奖；每人每个所选范围仅一份资格。
app.get('/api/sessions/:code/lottery-pool', async (req, res) => {
    const period = req.query.period || 'all';
    if (!['all', 'am', 'pm'].includes(period)) return res.status(400).json({ message: '无效的抽奖时段' });
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        const questions = await Question.find({ sessionId: session._id })
            .select('+participantId').sort({ createdAt: 1 }).lean();
        res.set('Cache-Control', 'no-store');
        const dates = [...new Set(questions.map(q => chinaDate(q.createdAt)))].sort().reverse();
        res.json({ session, dates, period, questions: buildLotteryPool(questions, period) });
    } catch (e) { res.status(500).json({ message: '获取抽奖名单失败' }); }
});

// B. 语音转文字 API (新增)
app.post('/api/voice-to-text', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: '未找到音频文件' });
    
    const inputPath = req.file.path;
    const outputPath = `${inputPath}.pcm`;

    ffmpeg(inputPath)
        .outputOptions(['-f s16le', '-acodec pcm_s16le', '-ac 1', '-ar 16000'])
        .save(outputPath)
        .on('end', () => {
            const voiceBuffer = fs.readFileSync(outputPath);
            baiduClient.recognize(voiceBuffer, 'pcm', 16000).then((result) => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                if (result.err_no === 0) {
                    res.json({ text: result.result[0] });
                } else {
                    res.status(500).json({ message: '识别失败: ' + result.err_msg });
                }
            }).catch(() => {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                res.status(500).json({ message: '百度API请求错误' });
            });
        })
        .on('error', () => {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            res.status(500).json({ message: '音频转码失败' });
        });
});

// C. 提问与删除 API
app.post('/api/ask/:code', async (req, res) => {
    const { question, name, participantId } = req.body || {};
    if (typeof question !== 'string' || !normalizeQuestion(question) || question.length > 10000 ||
        (name !== undefined && (typeof name !== 'string' || name.length > 100)) ||
        typeof participantId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(participantId)) {
        return res.status(400).json({ message: '请刷新页面后提交有效的问题（最多10000字，姓名最多100字）' });
    }
    const text = normalizeQuestion(question);
    const ip = req.socket.remoteAddress;
    try {
        const session = await Session.findOne({ code: req.params.code });
        if (!session) return res.status(404).json({ message: '场次不存在' });
        const newQuestion = new Question({ text, name: (name || '').trim() || '匿名',
            participantId: participantId.toLowerCase(),
            questionHash: createHash('sha256').update(text).digest('hex'),
            sessionId: session._id, ipAddress: ip });
        await newQuestion.save();
        const payload = newQuestion.toObject();
        delete payload.participantId;
        delete payload.questionHash;
        broadcastToRoom(session.code, { type: 'new_question', payload });
        res.status(201).json({ message: '问题已收到' });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({
            code: 'DUPLICATE_QUESTION', message: '你已在本场提交过这个问题，请勿重复提交。'
        });
        res.status(500).json({ message: '提交失败，请稍后重试' });
    }
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

// D. 数据导出 API
app.get('/api/questions', adminAuth, async (req, res) => {
    const { start, end } = req.query;
    try {
        const query = { createdAt: { $gte: new Date(start), $lte: new Date(end) } };
        const filteredQuestions = await Question.find(query).sort({ createdAt: 1 });
        res.status(200).json(filteredQuestions);
    } catch (error) { res.status(500).json({ message: '服务器错误' }); }
});

// E. 中奖记录 API
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
// 连接和唯一索引准备完成后才接收请求，防止部署期间漏过查重。
async function start() {
    await mongoose.connect(MONGO_URI);
    await Question.createIndexes();
    server.listen(PORT, () => console.log(`服务器正在端口 ${PORT} 上运行`));
}
start().catch(error => {
    console.error('启动失败：请检查数据库连接和索引创建权限', error);
    process.exitCode = 1;
    server.close();
    mongoose.disconnect();
});
