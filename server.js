// server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const mongoose = require('mongoose'); // 引入 mongoose

// --- 数据库连接 ---
// 从环境变量获取连接字符串，这是最佳实践
const MONGO_URI = process.env.MONGO_URI; 

mongoose.connect(MONGO_URI)
    .then(() => console.log('成功连接到 MongoDB Atlas'))
    .catch(err => console.error('连接 MongoDB 失败:', err));

// 定义一个数据模型 (Schema)
const questionSchema = new mongoose.Schema({
    text: String,
    name: { type: String, default: '匿名' }, // 增加 name 字段，并设置默认值为'匿名'
    createdAt: { type: Date, default: Date.now }
});
const Question = mongoose.model('Question', questionSchema);
// --- 数据库部分结束 ---


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.redirect('/presenter.html');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => { /* ... */ });

// 修改 /ask 接口以使用数据库
app.post('/ask', async (req, res) => {
    // 从请求体中同时获取 question 和 name
    const { question, name } = req.body; 

    if (question) {
        try {
            // 创建实例时同时保存 text 和 name
            const newQuestion = new Question({
                text: question,
                // 如果用户没填名字，就使用'匿名'
                name: name || '匿名' 
            });
            await newQuestion.save();
            console.log(`问题已保存: "${question}" by ${newQuestion.name}`);

            // 广播给前端时，把整个问题对象（包含text和name）都发过去
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'new_question',
                        // payload 现在是一个包含 text 和 name 的对象
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

// (可选) 新增一个接口，用于查看所有已保存的问题
app.get('/questions', async (req, res) => {
    try {
        const allQuestions = await Question.find().sort({ createdAt: -1 }); // 按时间倒序
        res.json(allQuestions);
    } catch (err) {
        res.status(500).json({ message: '获取问题失败' });
    }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于 http://localhost:${PORT}`);
});