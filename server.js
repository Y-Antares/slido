// server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
// 使用 express.json() 中间件来解析JSON格式的请求体
app.use(express.json());
// 托管 public 文件夹中的静态文件 (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 监听WebSocket连接
wss.on('connection', (ws) => {
    console.log('一个展示页(Presenter)已连接');
    ws.on('close', () => {
        console.log('一个展示页(Presenter)已断开连接');
    });
});

// 创建一个API端点，用于接收学生提交的问题
app.post('/ask', (req, res) => {
    const { question } = req.body;
    if (question) {
        console.log(`收到新问题: ${question}`);

        // 将新问题广播给所有连接的展示页
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'new_question', payload: question }));
            }
        });

        res.status(200).json({ message: '问题已收到' });
    } else {
        res.status(400).json({ message: '问题不能为空' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器正在运行于 http://localhost:${PORT}`);
    console.log(`请在浏览器中打开 http://localhost:${PORT}/presenter.html`);
});