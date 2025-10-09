// --- 依赖引入 (Dependencies) ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose');
const basicAuth = require('express-basic-auth'); // 用于后台页面密码保护

// --- 数据库设置 (Database Setup) ---
// 从环境变量获取MongoDB连接字符串
const MONGO_URI = process.env.MONGO_URI; 

// 连接到MongoDB Atlas
mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// 定义问题的数据模型 (Schema)，包含问题内容、提问人姓名和创建时间
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' },
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);

// --- Express 应用初始化 ---
const app = express();

// --- 安全与中间件 (Security & Middleware) ---
// 配置后台页面的HTTP Basic Authentication
// 用户名和密码从环境变量中读取，确保安全
const adminAuth = basicAuth({
    users: { 
        [process.env.ADMIN_USERNAME]: process.env.ADMIN_PASSWORD 
    },
    challenge: true, // 验证失败时，浏览器会弹出登录窗口
});

// --- 路由定义 (Routes) ---

// 1. 保护后台管理页面路由
// 只有通过了 adminAuth 验证的用户才能访问 admin.html
app.get('/admin.html', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 2. 托管 public 文件夹中的静态文件（如 presenter.html, client.html, CSS等）
app.use(express.static(path.join(__dirname, 'public')));

// 3. 使用 Express JSON 中间件来解析请求体
app.use(express.json());

// 4. 当用户访问根目录时，自动跳转到展示页面
app.get('/', (req, res) => {
    res.redirect('/presenter.html');
});

// 5. 学生提交问题的API接口
app.post('/ask', async (req, res) => {
    const { question, name } = req.body; 

    if (question) {
        try {
            const newQuestion = new Question({
                text: question,
                name: name || '匿名' 
            });
            await newQuestion.save();
            console.log(`问题已保存: "${question}" by ${newQuestion.name}`);

            // 通过WebSocket将新问题广播给所有连接的展示页
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'new_question',
                        payload: { 
                            text: newQuestion.text,
                            name: newQuestion.name
                        }
                    }));
                }
            });
            res.status(200).json({ message: '问题已收到' });
        } catch (err) {
            console.error('保存问题到数据库失败:', err);
            res.status(500).json({ message: '服务器内部错误' });
        }
    } else {
        res.status(400).json({ message: '问题不能为空' });
    }
});

// 6. 后台管理页面用于获取特定时间段问题的API接口
app.get('/api/questions', async (req, res) => {
    const { start, end } = req.query;

    if (!start || !end) {
        return res.status(400).json({ message: '必须提供开始(start)和结束(end)时间参数' });
    }

    try {
        const query = {
            createdAt: {
                $gte: new Date(start), 
                $lte: new Date(end)
            }
        };
        const filteredQuestions = await Question.find(query).sort({ createdAt: 1 });
        res.status(200).json(filteredQuestions);
    } catch (error) {
        console.error('获取问题失败:', error);
        res.status(500).json({ message: '服务器错误' });
    }
});

// --- 服务器与WebSocket设置 ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('一个展示页(Presenter)已连接');
    ws.on('close', () => {
        console.log('一个展示页(Presenter)已断开连接');
    });
});

// --- 启动服务器 ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于端口 ${PORT}`);
});