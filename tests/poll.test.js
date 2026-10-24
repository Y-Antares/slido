const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load() {
    const routes = new Map(), models = {}, indexes = [], events = [], saved = [];
    class Schema {
        constructor(fields) { this.fields = fields; }
        set() {}
        index(fields, options) { indexes.push({ fields, options }); }
    }
    Schema.Types = { ObjectId: String };
    const mongoose = { Schema, connect: async () => events.push('connect'), disconnect() {},
        model(name, schema) {
            class Model {
                constructor(data) { Object.assign(this, data); this._id = String(saved.length + 1); this.createdAt = new Date(); }
                toObject() { return { ...this }; }
                async save() {
                    // Atomic unique-insert substitute, not a real MongoDB integration test.
                    if (name === 'Question' && saved.some(q => q.sessionId === this.sessionId && q.participantId === this.participantId && q.questionHash === this.questionHash)) {
                        const e = new Error('duplicate'); e.code = 11000; throw e;
                    }
                    saved.push(this);
                }
                static async findOne({ code }) { return code === 'missing' ? null : { _id: code, code, name: code }; }
                static async createIndexes() { events.push('index'); }
            }
            Model.schema = schema; models[name] = Model; return Model;
        }
    };
    const app = { use() {}, get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
        post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); }, delete() {} };
    const express = () => app; express.json = express.static = () => () => {};
    class WS { static OPEN = 1; static Server = class { on() {} }; }
    const deps = { express, mongoose, ws: WS, http: { createServer: () => ({ listen: () => events.push('listen'), close() {} }) },
        'express-basic-auth': () => () => {}, nanoid: { nanoid: () => 'ABC123' }, multer: () => ({ single: () => () => {} }),
        'baidu-aip-sdk': { speech: class {} }, 'fluent-ffmpeg': { setFfmpegPath() {} }, '@ffmpeg-installer/ffmpeg': { path: '/ffmpeg' } };
    const context = vm.createContext({ require: name => deps[name] || require(name), console,
        process: { env: {} }, __dirname: path.resolve(__dirname, '..') });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
    return { context, routes, models, indexes, events, saved };
}
const id = '01234567-89ab-4cde-8fab-0123456789ab';
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, set() {} }; }
function request(code = 'am', question = '问题', participantId = id) { return { params: { code }, body: { question, name: '张老师', participantId }, socket: { remoteAddress: '127.0.0.1' } }; }

test('unique partial index and readiness precede accepting requests', async () => {
    const x = load(); await new Promise(setImmediate);
    assert.equal(x.indexes[0].options.unique, true);
    assert.equal(x.indexes[0].options.partialFilterExpression.participantId.$type, 'string');
    assert.deepEqual(x.events, ['connect', 'index', 'listen']);
    assert.equal(x.models.Question.schema.fields.participantId.select, false);
});
test('concurrent duplicates: one accepted, all others conflict; payload hides identity', async () => {
    const x = load(), handler = x.routes.get('POST /api/ask/:code');
    const results = await Promise.all(Array.from({ length: 20 }, async () => { const res = response(); await handler(request(), res); return res; }));
    assert.equal(results.filter(r => r.code === 201).length, 1);
    assert.equal(results.filter(r => r.code === 409).length, 19);
    assert.equal(x.saved.length, 1);
});
test('newline/outer whitespace normalized; other text, identities, and sessions allowed', async () => {
    const x = load(), handler = x.routes.get('POST /api/ask/:code');
    for (const [req, expected] of [
        [request('am', ' A\r\nB '), 201], [request('am', 'A\nB'), 409],
        [request('am', '不同问题'), 201], [request('pm', 'A\nB'), 201],
        [request('am', 'A\nB', '11234567-89ab-4cde-8fab-0123456789ab'), 201],
        [request('am', '   '), 400], [request('am', '问题', 'bad'), 400], [request('missing'), 404]
    ]) { const res = response(); await handler(req, res); assert.equal(res.code, expected); }
});
test('one candidate per participant/date; same names distinct; legacy duplicates collapse; no identity leaked', () => {
    const { context } = load();
    context.rows = [
        { _id: '1', name: '同名', participantId: 'a', text: 'A', createdAt: '2026-10-23T16:30:00Z' },
        { _id: '2', name: '改名', participantId: 'a', text: 'B', createdAt: '2026-10-24T01:00:00Z' },
        { _id: '3', name: '同名', participantId: 'b', text: 'A', createdAt: '2026-10-24T02:00:00Z' },
        { _id: '4', name: '历史老师', text: 'C', createdAt: '2026-10-24T02:00:00Z' },
        { _id: '5', name: '历史老师', text: 'C', createdAt: '2026-10-24T02:00:00Z' },
        { _id: '6', name: '同名', participantId: 'a', text: 'D', createdAt: '2026-10-24T16:00:00Z' }
    ];
    const pool = vm.runInContext('buildLotteryPool(rows)', context);
    assert.equal(pool.length, 4);
    assert.equal(pool.filter(q => q.questionCount === 2).length, 2);
    assert.ok(pool.every(q => !('participantId' in q) && !('questionHash' in q)));
    assert.equal(vm.runInContext("chinaDate('2026-10-23T16:30:00Z')", context), '2026/10/24');
    assert.equal(vm.runInContext('buildLotteryPool([]).length', context), 0);
});
test('all supplied inline scripts parse', () => {
    for (const file of fs.readdirSync(path.join(__dirname, '../public')).filter(f => f.endsWith('.html'))) {
        const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
        for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1], { filename: file });
    }
});

function pageContext(file, fetch) {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            options: [{ text: '全天' }], selectedIndex: 0, value: '', textContent: '', style: {}, disabled: false, listeners: {},
            addEventListener(type, fn) { this.listeners[type] = fn; },
            querySelector() { return element('submit-button'); },
            getContext() { return { clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {}, closePath() {} }; },
            set innerHTML(value) { this.html = value; if (id === 'date-selector') this.value = /value="([^"]+)"/.exec(value)?.[1] || ''; },
            get innerHTML() { return this.html ?? this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
        });
        return elements.get(id);
    }
    const storage = new Map();
    const context = vm.createContext({ document: { getElementById: element, createElement: () => element('escape') },
        window: { location: { pathname: '/session/am/ask', search: '?code=am&date=2026%2F10%2F24' }, innerWidth: 1280, innerHeight: 720 },
        crypto: require('node:crypto').webcrypto, URLSearchParams, console, fetch, setTimeout, clearTimeout, requestAnimationFrame() {},
        localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) } });
    const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(match[1], context);
    return { context, element, storage };
}
test('client suppresses double clicks and shows server duplicate error without redirect', async () => {
    let count = 0, complete;
    const page = pageContext('client.html', () => { count++; return new Promise(resolve => { complete = resolve; }); });
    page.element('question-input').value = '问题';
    const submit = page.element('question-form').listeners.submit;
    const pending = submit({ preventDefault() {} });
    await submit({ preventDefault() {} });
    assert.equal(count, 1);
    assert.equal(page.element('submit-button').disabled, true);
    complete({ status: 409, ok: false, json: async () => ({ code: 'DUPLICATE_QUESTION', message: '请勿重复提交' }) });
    await pending;
    assert.equal(page.element('message').textContent, '请勿重复提交');
    assert.equal(page.element('submit-button').disabled, false);
    assert.ok(page.storage.has('poll_participant_id_v1'));
    assert.equal(page.context.window.location.href, undefined);
});
test('all lottery modes consume shared pool, respect date, and handle empty pool', async () => {
    for (const file of ['lottery-flip.html', 'lottery-ball.html', 'lottery.html']) {
        for (const empty of [false, true]) {
            let url;
            const page = pageContext(file, async input => {
                url = input;
                return { ok: true, json: async () => ({ session: { name: '同一话题' }, dates: ['2026/10/25', '2026/10/24'], questions: empty ? [] : [
                    { _id: '1', name: '甲', text: '问题', createdAt: '2026-10-24T01:00:00Z' },
                    { _id: '2', name: '乙', text: '问题', createdAt: '2026-10-25T01:00:00Z' }
                ] }) };
            });
            await new Promise(setImmediate);
            assert.equal(url, '/api/sessions/am/lottery-pool?period=all');
            assert.equal(vm.runInContext('filteredPool.length', page.context), empty ? 0 : 1, file);
            if (file !== 'lottery-flip.html') assert.equal(page.element('action-btn').disabled, empty);
        }
    }
});

test('period filtering precedes participant grouping; noon and Shanghai midnight boundaries', () => {
    const { context } = load();
    context.rows = [
        { _id: 'morning', participantId: 'a', name: '甲', text: '上午问题', createdAt: '2026-10-24T03:59:59.999Z' },
        { _id: 'noon', participantId: 'a', name: '甲', text: '下午问题', createdAt: '2026-10-24T04:00:00.000Z' },
        { _id: 'evening', participantId: 'b', name: '乙', text: '下午问题', createdAt: '2026-10-24T15:59:59.999Z' },
        { _id: 'midnight', participantId: 'a', name: '甲', text: '次日凌晨', createdAt: '2026-10-24T16:00:00.000Z' }
    ];
    const morning = vm.runInContext("buildLotteryPool(rows, 'am')", context);
    const afternoon = vm.runInContext("buildLotteryPool(rows, 'pm')", context);
    const all = vm.runInContext("buildLotteryPool(rows, 'all')", context);
    assert.deepEqual(Array.from(morning, q => q._id).sort(), ['midnight', 'morning']);
    assert.deepEqual(Array.from(afternoon, q => q._id).sort(), ['evening', 'noon']);
    assert.equal(all.length, 3); // day 1: a,b; day 2: a
    assert.equal(all.find(q => q.questionCount === 2).name, '甲');
    assert.equal(vm.runInContext("chinaPeriod('2026-10-24T04:00:00Z')", context), 'pm');
    assert.equal(vm.runInContext("chinaPeriod('2026-10-24T16:00:00Z')", context), 'am');
});
test('pool API keeps dates with empty period, rejects invalid period, and retains legacy support', async () => {
    const x = load();
    x.models.Question.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => [
        { _id: '1', name: '历史老师', text: '问题', createdAt: '2026-10-24T01:00:00Z' },
        { _id: '2', name: '历史老师', text: '重复问题', createdAt: '2026-10-24T01:00:00Z' }
    ] });
    const handler = x.routes.get('GET /api/sessions/:code/lottery-pool');
    const morning = response();
    await handler({ params: { code: 'topic' }, query: { period: 'am' } }, morning);
    assert.equal(morning.data.questions.length, 1);
    const afternoon = response();
    await handler({ params: { code: 'topic' }, query: { period: 'pm' } }, afternoon);
    assert.equal(afternoon.data.questions.length, 0);
    assert.deepEqual(Array.from(afternoon.data.dates), ['2026/10/24']);
    const invalid = response();
    await handler({ params: { code: 'topic' }, query: { period: 'invalid' } }, invalid);
    assert.equal(invalid.code, 400);
});
test('every lottery mode clears stale pool while switching periods and ignores stale responses', async () => {
    for (const file of ['lottery-flip.html', 'lottery-ball.html', 'lottery.html']) {
        const pending = [];
        const page = pageContext(file, url => new Promise(resolve => pending.push({ url, resolve })));
        const reply = (i, id) => pending[i].resolve({ ok: true, json: async () => ({
            session: { name: '同一话题' }, dates: ['2026/10/24'],
            questions: [{ _id: id, name: id, text: id, createdAt: '2026-10-24T05:00:00Z' }]
        }) });
        reply(0, 'initial'); await new Promise(setImmediate);
        assert.equal(vm.runInContext('filteredPool.length', page.context), 1);
        page.element('period-selector').value = 'am';
        const amLoad = page.element('period-selector').onchange();
        assert.equal(vm.runInContext('filteredPool.length', page.context), 0);
        page.element('period-selector').value = 'pm';
        const pmLoad = page.element('period-selector').onchange();
        assert.ok(pending[2].url.endsWith('period=pm'));
        reply(2, 'afternoon'); await pmLoad;
        reply(1, 'staleMorning'); await amLoad;
        assert.equal(vm.runInContext('filteredPool[0]._id', page.context), 'afternoon', file);
        assert.equal(page.element('date-selector').disabled, false);
    }
});
