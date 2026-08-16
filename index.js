/**
 * 剧情记忆核心（Story MemoryCore）
 * ------------------------------------------------------------------
 * 一个通用于「任意世界书 / 任意角色卡 / 任意题材」的 SillyTavern 扩展：
 * 把「剧情记忆」搬出 AI 的大脑存进本地，并在每次生成前智能注入回上下文。
 * 解决长对话里的数值丢失、前后文对不上、多线切换错乱。
 *
 * 与原版「鸠占鹊巢·记忆核心（NTR MemoryCore）」相比，本版做了两点：
 *   1) 优化：修掉总结队列卡死、待总结无限增长、去重表误清空等缺陷；
 *   2) 通用化：不再写死角色名单 / 数值字段 / 苦主映射 / NTR 专属提示词，
 *      改为自动识别角色、自动识别数值字段、可配置字段与关联人物，
 *      任何世界书（修仙 / 西幻 / 现代 / NTR……）装上就能用。
 *
 * 结构：
 *   snapshot      —— 数值快照（按人分，覆盖更新，体积固定）
 *   characters    —— 剧情记忆（按人分：每人一条事件窗 + 一段摘要）
 *   globalEvents  —— 全局大事件轴（跨线大事件，保留全局时间顺序）
 *   globalSummary —— 全局总纲
 *   mainlineSummary —— 主线大记忆
 *
 * 注入时：世界观 + 数值快照 + 当前活跃角色的剧情 + 关联角色状态 + 全局大事件/总纲。
 * 所有总结/压缩都调用「主 API」（generateRaw / generateQuietPrompt）。
 * ------------------------------------------------------------------
 */
// 绝对路径 import：无论手动安装（extensions/story-memory）还是 Install Extension
// （extensions/third-party/story-memory）都能正确加载——相对路径会因多一层 third-party 而错位。
import * as ST from '/script.js';
import * as EXT from '/scripts/extensions.js';
import * as SC from '/scripts/slash-commands.js';
import * as WI from '/scripts/world-info.js';

// 运行时解构 + 回退：兼容不同酒馆版本，缺某个 API 不至于整个扩展加载失败
const eventSource = ST.eventSource;
const event_types = ST.event_types;
const saveSettingsDebounced = ST.saveSettingsDebounced;
const generateRaw = ST.generateRaw;
const generateQuietPrompt = ST.generateQuietPrompt;
const extension_settings = EXT.extension_settings;
const getContext = EXT.getContext;
const registerSlashCommand = SC.registerSlashCommand;
const loadWorldInfo = WI.loadWorldInfo;
// 注意：world_names / selected_world_info 是「可变 let」，必须经 WI 命名空间动态读取（live binding），
// 不能在 import 时解构成常量，否则会拿到旧值/空值。

const MODULE = 'story-memory';
const LOG = '[story-memory]';

// 待总结队列上限：防止极端情况下无限增长占用内存
const MAX_PENDING = 1000;

// 从正文状态栏抓数值时，视为「系统/旁白」而排除的名字（避免把旁白当成角色追踪）
const SKIP_NAMES = new Set([
    'system', 'assistant', 'user', 'you', 'narrator', 'me',
    '系统', '旁白', '叙述者', '玩家', '我',
]);

const DEFAULTS = {
    enabled: true,
    queueSize: 5,        // 攒满「queueSize 条玩家 + queueSize 条角色」触发总结
    eventsPerChar: 15,   // 每个角色保留最近几条事件（滚动窗口）
    summaryMaxLen: 500,  // 摘要超过这个字数就重新压缩
    globalMax: 20,       // 全局大事件轴保留条数
    worldview: '',       // 常驻世界观：手动粘贴的补充设定（每次生成前优先注入）
    autoWorldInfo: true, // 自动拉取已启用世界书的「常驻条目」作为世界观注入
    valueFields: [],     // 需要追踪的数值字段（空 = 自动识别正文里出现的所有数值状态）
    charNames: [],       // 手动钉住的角色名单（空 = 自动从对话/卡片识别）
    relations: {},       // 关联人物：{ 角色名: { target, label } }，活跃时额外注入关联对象状态
    pending: [],         // 待总结的消息队列 [{role, text, chatIndex}]
    snapshot: {},        // 数值快照 {人物名: {字段: 数值, note?: 备注}}
    characters: {},      // 剧情记忆 {人物名: {events: [], summary: ''}}
    globalEvents: [],    // 全局大事件轴 [{time, location, characters, event, tags}]
    globalSummary: '',   // 全局总纲
    mainlineSummary: '', // 主线大记忆
    _lastCollected: -1,  // 已收进队列的最高 chat 索引（持久化，防刷新/切卡后重复总结旧消息）
    _failCount: 0,       // 连续总结失败计数（失败重试上限，防死循环）
};

// ---------- 存储（角色卡记忆隔离） ----------

const STORE_VERSION = 2;

// 当前作用域 & 各作用域的「已处理消息去重表」（session 内，不持久化；切卡自动切换）
let currentScopeKey = '';
let processedIds = new Set();
const scopeProcessed = new Map(); // scopeKey -> Set(chatIndex)

/** 当前作用域键：单卡用 char:头像，群聊用 group:群id（头像/群id 比索引稳定，跨刷新不变） */
function getScopeKey() {
    const ctx = getContext();
    if (ctx.groupId) return 'group:' + String(ctx.groupId);
    const ch = (ctx.characterId !== undefined && ctx.characters) ? ctx.characters[ctx.characterId] : null;
    if (ch && ch.avatar) return 'char:' + String(ch.avatar);
    if (ctx.name2) return 'char:' + String(ctx.name2);
    return 'default';
}

/** 切换到当前作用域对应的去重表 */
function syncScope() {
    const key = getScopeKey();
    if (key === currentScopeKey) return;
    currentScopeKey = key;
    let s = scopeProcessed.get(key);
    if (!s) { s = new Set(); scopeProcessed.set(key, s); }
    processedIds = s;
}

/** 作用域键 → 友好显示名（角色名 / 群名） */
function friendlyScopeLabel(key) {
    if (!key) return '默认';
    const ctx = getContext();
    if (key.startsWith('group:')) {
        const id = key.slice(6);
        const g = (ctx.groups || []).find(x => String(x.id) === id);
        return g?.name ? `群聊：${g.name}` : key;
    }
    if (key.startsWith('char:')) {
        const id = key.slice(5);
        const arr = ctx.characters || [];
        const c = arr.find(x => x && x.avatar === id);
        return c?.name ? `角色：${c.name}` : key;
    }
    return key;
}

/** 取作用域的显示名（优先用创建时记住的 label，兜底实时计算） */
function scopeLabel(key) {
    const store = getStore();
    return (store.labels && store.labels[key]) || friendlyScopeLabel(key);
}

/** 顶层存储对象（wrapper）：{ _v, currentScope, scopes:{scopeKey:记忆数据}, labels } */
function getStore() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = { _v: STORE_VERSION, currentScope: '', scopes: {} };
        migrateLegacy();
    }
    const s = extension_settings[MODULE];
    if (!s.scopes || typeof s.scopes !== 'object') {
        wrapFlatStore(s);
    }
    return s;
}

/** 把旧版「扁平单份记忆」打包成 _legacy，等首个作用域创建时并入 */
function wrapFlatStore(s) {
    const flat = {};
    for (const k of Object.keys(DEFAULTS)) if (k in s) flat[k] = s[k];
    for (const k of Object.keys(s)) delete s[k];
    s._v = STORE_VERSION;
    s.currentScope = '';
    s.scopes = {};
    if (Object.keys(flat).length) s._legacy = flat;
}

/** 确保某作用域存在并补齐缺省字段，返回该作用域的「记忆数据」对象 */
function ensureScope(key) {
    const store = getStore();
    let scope = store.scopes[key];
    if (!scope) {
        scope = JSON.parse(JSON.stringify(DEFAULTS));
        store.scopes[key] = scope;
        store.labels = store.labels || {};
        if (!store.labels[key]) store.labels[key] = friendlyScopeLabel(key);
        // 有旧数据待迁移 → 并入首个被创建的作用域（即当前正打开的角色卡）
        if (store._legacy && typeof store._legacy === 'object') {
            for (const [k, v] of Object.entries(store._legacy)) {
                if (k in DEFAULTS) scope[k] = v;
            }
            delete store._legacy;
        }
    } else {
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (!(k in scope)) scope[k] = JSON.parse(JSON.stringify(v));
        }
    }
    return scope;
}

/** 取「当前卡片/群聊」的记忆数据（自动随切卡切换） */
function getMem() {
    syncScope();
    const store = getStore();
    store.currentScope = currentScopeKey;
    return ensureScope(currentScopeKey);
}

/** 取指定作用域的记忆数据（总结中途锁定作用域，避免切卡时写错地方） */
function getMemForScope(key) {
    return ensureScope(key);
}

/** 从旧版「ntr-memory」无缝迁移记忆数据（仅首次运行、且存在旧数据时触发） */
function migrateLegacy() {
    const old = extension_settings['ntr-memory'];
    if (!old) return;
    const store = extension_settings[MODULE];
    try {
        const flat = {};
        for (const k of Object.keys(DEFAULTS)) {
            if (k === 'pending') continue; // 旧待总结队列不迁移，从头开始
            if (k in old) flat[k] = old[k];
        }
        // 旧版 NTR 专属字段/名单，迁移为「偏好字段」和「钉住名单」，升级后依旧无缝
        flat.valueFields = ['好感', '沉沦', '背德', '暴露', '服从', '发现'];
        flat.charNames = [
            '沈清璃', '沈若薇', '沈知夏', '沈知禾', '楚岚', '周若曦', '周小满', '沈知桃',
            '陆国梁', '赵明远', '顾北辰', '顾怀瑾', '周震', '方景行', '程一川', '周野',
        ];
        flat.relations = {
            '沈清璃': { target: '陆国梁', label: '丈夫' },
            '沈若薇': { target: '赵明远', label: '未婚夫' },
            '沈知夏': { target: '顾北辰', label: '男友' },
            '沈知禾': { target: '顾怀瑾', label: '丈夫' },
            '楚岚': { target: '周震', label: '丈夫' },
            '周若曦': { target: '方景行', label: '未婚夫' },
            '周小满': { target: '程一川', label: '青梅竹马' },
            '沈知桃': { target: '周野', label: '男友' },
        };
        if (Object.keys(flat).length) store._legacy = flat;
        delete extension_settings['ntr-memory'];
        persist();
        console.log(LOG, '已从旧版 ntr-memory 迁移记忆数据。');
    } catch (e) {
        console.warn(LOG, '旧数据迁移失败（忽略）：', e);
    }
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { /* 忽略 */ }
}

// 面板实时刷新（节流 + 焦点检测，避免打断用户正在编辑）
let panelRefreshTimer = null;
function refreshPanel() {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('story-memory-settings');
    if (!panel) return;
    const active = document.activeElement;
    if (active && panel.contains(active)) return;
    if (panelRefreshTimer) return;
    panelRefreshTimer = setTimeout(() => {
        panelRefreshTimer = null;
        try { renderSettings(); } catch (e) { /* 忽略 */ }
    }, 600);
}

// ---------- 工具 ----------

/** 从模型输出中稳健地提取 JSON 对象（字符串感知 + BOM 清理 + 多层兜底） */
function extractJson(text) {
    if (!text) return null;
    let t = String(text).replace(/^\uFEFF/, '').trim();

    // 1) 直接解析
    try { return JSON.parse(t); } catch { /* 继续 */ }

    // 2) 去掉 markdown 代码块围栏 ```json ... ```
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        try { return JSON.parse(fence[1].replace(/^\uFEFF/, '').trim()); } catch { /* 继续 */ }
    }

    // 3) 提取第一个 {...} 块（字符串感知：跳过字符串内的花括号与转义）
    const start = t.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 汇总当前所有需要展示/追踪的字段（偏好字段优先，其后按快照中出现顺序，note 固定放最后） */
function getAllFields(mem) {
    const seen = new Set();
    const order = [];
    for (const f of (mem.valueFields || [])) {
        if (f && !seen.has(f)) { seen.add(f); order.push(f); }
    }
    for (const name of Object.keys(mem.snapshot || {})) {
        for (const f of Object.keys(mem.snapshot[name] || {})) {
            if (f.startsWith('_')) continue; // 跳过 _updatedAt 等元数据
            if (!seen.has(f)) { seen.add(f); order.push(f); }
        }
    }
    const nums = order.filter(f => f !== 'note');
    if (seen.has('note')) nums.push('note');
    return nums;
}

function fieldKv(f, val) {
    if (val === undefined || val === null || val === '') return null;
    return f === 'note' ? `备注:${val}` : `${f}=${val}`;
}

function snapshotToText(mem) {
    const fields = getAllFields(mem);
    const lines = [];
    for (const [name, v] of Object.entries(mem.snapshot || {})) {
        const parts = fields.map(f => fieldKv(f, v[f])).filter(Boolean);
        if (parts.length) lines.push(`${name}：${parts.join(' ')}`);
    }
    return lines.join('\n');
}

function eventToLine(e) {
    const before = e.before ? `前情：${e.before}｜` : '';
    return `· ${before}${e.time || '?'} ${e.location || '?'}｜${(e.characters || []).join('、')}｜${e.event || ''}`;
}

// ---------- 角色自动识别 ----------

let _namesCache = { key: '', names: [] };

/**
 * 自动从「对话参与者 + 当前卡片 + 群成员」识别角色名。
 * 刻意不用整个 characters 库（那是全库卡片），只用本会话真正出场的人，避免误匹配。
 */
function autoDiscoverNames() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const groups = ctx.groups || [];
    const cacheKey = `${currentScopeKey}:${chat.length}:${ctx.name2 || ''}:${groups.length}`;
    if (_namesCache.key === cacheKey) return _namesCache.names;

    const set = new Set();
    const user = String(ctx.name1 || '').trim();

    for (const m of chat) {
        if (m && m.name && typeof m.name === 'string') {
            const n = m.name.trim();
            if (n && n !== user && !SKIP_NAMES.has(n.toLowerCase())) set.add(n);
        }
    }
    if (ctx.name2 && String(ctx.name2).trim()) set.add(String(ctx.name2).trim());
    for (const g of groups) {
        for (const mem of (g.members || [])) {
            if (mem && mem.name && String(mem.name).trim()) set.add(String(mem.name).trim());
        }
    }
    // 去掉用户自己 & 系统名
    for (const n of [...set]) {
        if (n === user || SKIP_NAMES.has(n.toLowerCase())) set.delete(n);
    }

    const names = [...set].filter(Boolean);
    _namesCache = { key: cacheKey, names };
    return names;
}

/** 用户（玩家）本人可能的称呼：name1 + 通用「玩家」标签 */
function getUserNames() {
    const ctx = getContext();
    const set = new Set();
    const u = String(ctx.name1 || '').trim();
    if (u && !SKIP_NAMES.has(u.toLowerCase())) set.add(u);
    set.add('玩家');
    return [...set];
}

/** 角色注册表 = 自动识别 ∪ 手动钉住 ∪ 记忆里已有的人物 ∪ 玩家本人 */
function getCharacterRegistry() {
    const set = new Set();
    for (const n of autoDiscoverNames()) set.add(n);
    const mem = getMem();
    for (const n of (mem.charNames || [])) if (n && String(n).trim()) set.add(String(n).trim());
    for (const n of Object.keys(mem.snapshot || {})) set.add(n);
    for (const n of Object.keys(mem.characters || {})) set.add(n);
    for (const n of getUserNames()) set.add(n); // 玩家本人也要抓数值
    return [...set].filter(Boolean);
}

/** 当前活跃角色：最近若干条消息里被提到 / 发言的人物 */
function detectActiveCharacters() {
    const context = getContext();
    const chat = context.chat || [];
    const recent = chat.slice(-8);
    const names = getCharacterRegistry();
    const found = new Set();
    for (const msg of recent) {
        const text = String(msg.mes || '');
        for (const name of names) {
            if (name && text.includes(name)) found.add(name);
        }
        // 最近发言的角色一定算「活跃」
        if (msg && !msg.is_user && msg.name) found.add(String(msg.name));
    }
    return [...found];
}

/** 从已启用世界书的「条目键」扫描候选人名（手动按钮触发，结果并入手动名单） */
async function scanWorldBookNames() {
    const candidates = new Set();
    const heur = /^[\u4e00-\u9fa5]{2,6}$/; // 中文 2~6 字，像人名
    try {
        const names = getActiveWorldNames();
        for (const name of names) {
            const book = await loadWorldInfo(name);
            const entries = Object.values(book?.entries || {});
            for (const e of entries) {
                const keys = Array.isArray(e?.key) ? e.key : [];
                for (const k of keys) {
                    const s = String(k).trim();
                    if (heur.test(s) && !SKIP_NAMES.has(s)) candidates.add(s);
                }
            }
        }
    } catch (e) {
        console.warn(LOG, '扫描世界书人名失败：', e);
    }
    return [...candidates];
}

// ---------- 正文状态栏正则抓数值（通用版） ----------

/** 构建「名字：」定位正则（名字按长度降序，长名优先，避免「沈清」抢在「沈清璃」前面） */
function buildNameRegex(names) {
    const list = [...new Set(names.map(n => String(n).trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    if (!list.length) {
        // 无任何已知名字时，退化为宽松的「2~16 字中英文名：」
        return /([\u4e00-\u9fa5A-Za-z·][\u4e00-\u9fa5A-Za-z·0-9]{1,15})[：:]/g;
    }
    const alt = list.map(escapeRegExp).join('|');
    return new RegExp('(' + alt + ')[：:]', 'g');
}

/** 解析「字段 值 / 字段:值 / 字段=值 / 字段值」等写法（值必须为数字） */
function parseFieldPairs(seg) {
    const out = {};
    if (!seg) return out;

    const apply = (re) => {
        let m;
        while ((m = re.exec(seg))) {
            const key = m[1].trim();
            if (key && !(key in out)) out[key] = Number(m[2]);
        }
    };

    // A：显式分隔符  字段：80 / 字段:80 / 字段=80
    apply(/([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]{0,11})\s*[:：=]\s*(-?\d+(?:\.\d+)?)/g);
    // B：空格分隔    字段 80（字段 ≥2 字）
    apply(/([\u4e00-\u9fa5A-Za-z]{2,8})\s+(-?\d+(?:\.\d+)?)/g);
    // C：紧贴数字    好感80（纯中文字段 ≥2 字）
    apply(/([\u4e00-\u9fa5]{2,6})(-?\d+(?:\.\d+)?)/g);
    // D：紧贴数字    HP500 / ATK120（纯英文字段 ≥2 字）
    apply(/([A-Za-z]{2,8})(-?\d+(?:\.\d+)?)/g);

    return out;
}

/** 从正文末尾的状态栏正则抓精确数值（双源校验的「精确源」） */
function extractStatusBar(text) {
    if (!text) return {};
    const out = {};
    const re = buildNameRegex(getCharacterRegistry());
    re.lastIndex = 0;

    // 先定位所有「名字：」标记
    const markers = [];
    let m;
    while ((m = re.exec(text))) {
        markers.push({ name: m[1], start: m.index, end: re.lastIndex });
    }
    if (!markers.length) return out;

    for (let i = 0; i < markers.length; i++) {
        const seg = markers[i];
        const segEnd = i + 1 < markers.length ? markers[i + 1].start : text.length;
        const rest = text.slice(seg.end, segEnd);
        const chunks = rest.split(/[\n\r｜|]/);
        const fields = parseFieldPairs(chunks[0] || '');
        const note = chunks.slice(1).join(' ').trim();
        if (note) fields.note = note;
        if (Object.keys(fields).length) {
            out[seg.name] = Object.assign(out[seg.name] || {}, fields);
        }
    }
    return out;
}

/** 把状态栏正则抓到的数值写进快照（每轮 AI 回复后调用，精确、及时） */
function applyStatusBar(text) {
    const mem = getMem();
    const vals = extractStatusBar(text);
    let changed = false;
    for (const [name, fields] of Object.entries(vals)) {
        const prev = mem.snapshot[name] || {};
        const next = { ...prev };
        for (const [k, v] of Object.entries(fields)) {
            if (v === undefined || v === null || v === '') continue;
            next[k] = v;
        }
        next._updatedAt = Date.now();
        mem.snapshot[name] = next;
        changed = true;
    }
    if (changed) { persist(); refreshPanel(); }
    return vals;
}

/** 手动抓取最后一条 AI 消息的状态栏数值（刷新快照），返回抓到的字段数 */
function refreshSnapshotFromChat() {
    const context = getContext();
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (msg && !msg.is_user && msg.mes) {
            const vals = applyStatusBar(String(msg.mes));
            try { renderSettings(); } catch (e) { /* 忽略 */ }
            return Object.keys(vals).length;
        }
    }
    try { renderSettings(); } catch (e) { /* 忽略 */ }
    return 0;
}

// ---------- 世界书常驻条目拉取 ----------

let cachedWorldView = { key: '', time: 0, text: '' };

/** 当前启用的世界书名（优先取「已选中/激活」的，其次退化为全部） */
function getActiveWorldNames() {
    const sel = Array.isArray(WI.selected_world_info) ? WI.selected_world_info : [];
    if (sel.length) return sel;
    const all = Array.isArray(WI.world_names) ? WI.world_names : [];
    return all;
}

/** 拉取当前已启用世界书的「常驻条目」内容（带 30 秒缓存 + 按作用域区分，避免切卡串书） */
async function getConstantWorldInfo() {
    const names = getActiveWorldNames();
    const key = `${currentScopeKey}|${names.join(',')}`;
    const now = Date.now();
    if (cachedWorldView.key === key && now - cachedWorldView.time < 30000) return cachedWorldView.text;
    try {
        const parts = [];
        for (const name of names) {
            const book = await loadWorldInfo(name);
            const entries = Object.values(book?.entries || {});
            for (const e of entries) {
                if (e && e.constant && !e.disable && e.content && e.content.trim()) {
                    const label = e.comment?.trim() || (Array.isArray(e.key) ? e.key.join('、') : '');
                    parts.push(label ? `【${label}】\n${e.content.trim()}` : e.content.trim());
                }
            }
        }
        const text = parts.join('\n');
        cachedWorldView = { key, time: now, text };
        return text;
    } catch (e) {
        console.warn(LOG, '拉取世界书常驻条目失败：', e);
        return cachedWorldView.key === key ? cachedWorldView.text : '';
    }
}

// ---------- 结构化提取（调主 API） ----------

function buildExtractPrompt(historyText, snapshotText, names, fields) {
    const nameLine = names.length
        ? names.join('、')
        : '（暂无，请从对话中自行识别人物）';
    const fieldLine = fields.length
        ? fields.join('、')
        : '（自动：提取对话里出现的所有数值状态字段，字段名以正文为准，如 好感/等级/HP/亲密度/财富 等）';
    return [
        '你是剧情记忆归档器。阅读下面这段对话，提取关键信息，输出一个 JSON 对象（不要 markdown 代码块、不要任何解释）。',
        '',
        `【已知人物名单（优先从里面识别，出现新人名也照实记录）】\n${nameLine}`,
        '',
        '注意：「玩家」是用户本人，其状态面板（修为/等级/HP/属性/资源 等）同样要提取到 values 里，不要漏掉。',
        '',
        `【需要追踪的数值字段（只提取对话中明确出现的；列表为空则自动提取所有数值状态）】\n${fieldLine}`,
        '',
        `【当前已有数值快照（增量更新：本次没提到的人物/数值保持原值，不要编造）】\n${snapshotText || '（暂无）'}`,
        '',
        '【待归档的对话】',
        historyText,
        '',
        '【输出 JSON 格式】',
        '{',
        '  "tags": ["关键词1", "关键词2"],',
        '  "before": "本段事件发生前，剧情处于什么状态、是怎么发展到这一步的（前情/起因，一句话）",',
        '  "characters": ["所有出场人物名"],',
        '  "mainCharacters": ["本段剧情的主要互动对象（核心人物，通常 1-2 人；若同时与多人互动则都写上）"],',
        '  "values": {',
        '    "人物名": { "字段名": 数字或null, ... }',
        '  },',
        '  "time": "时间（如：第二天晚上 / 无明确时间则写 null）",',
        '  "location": "地点（如：别墅厨房 / 大学教室）",',
        '  "event": "一句话概括本段关键事件（谁对谁做了什么、谁发现了什么，要具体）",',
        '  "mainline": "本段对话对主线的宏观推进（主要目标/关键关系变化/重大转折/潜在冲突，一句话；若只是日常、无主线推进则填 null）"',
        '}',
        '',
        '规则：只提取对话中明确出现的信息，没出现的一律填 null 或省略；before 必须写清发生前的剧情状态；mainCharacters 必须从出场人物里选；event 必须具体；values 的字段名必须与正文一致。输出必须是单行合法 JSON（字符串值内不要换行、不要 markdown 代码块、不要任何解释）。',
    ].join('\n');
}

async function callMainApi(prompt, systemPrompt, responseLength) {
    const sys = systemPrompt || '你是剧情记忆归档器，只输出要求的文本，不要任何额外解释。';
    // 注意：不传 responseLength（max_tokens）——若模型带 reasoning（如 deepseek-reasoner），
    // 限制 max_tokens 过小会让 reasoning 占满、content 为空，导致「No message generated」。
    // 优先 generateRaw（不带聊天上下文，干净）；失败或空则回退 generateQuietPrompt（带上下文）。
    if (typeof generateRaw === 'function') {
        try {
            const r = await generateRaw({ prompt, systemPrompt: sys });
            const txt = (typeof r === 'string' ? r : '').trim();
            if (txt) {
                console.debug(LOG, 'generateRaw 总结成功，长度', txt.length);
                return txt;
            }
            console.warn(LOG, 'generateRaw 返回空，回退 generateQuietPrompt');
        } catch (e) {
            console.warn(LOG, 'generateRaw 失败，回退 generateQuietPrompt：', e);
        }
    }
    if (typeof generateQuietPrompt === 'function') {
        try {
            const r = await generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true });
            const txt = (typeof r === 'string' ? r : '').trim();
            if (txt) {
                console.debug(LOG, 'generateQuietPrompt 总结成功，长度', txt.length);
                return txt;
            }
            console.warn(LOG, 'generateQuietPrompt 也返回空');
        } catch (e) {
            console.error(LOG, 'generateQuietPrompt 失败：', e);
        }
    } else {
        console.warn(LOG, '当前酒馆版本不支持 generateRaw / generateQuietPrompt，总结功能停用');
    }
    return '';
}

// ---------- 总结流程 ----------

let summarizing = false;

function capPending(mem) {
    if (mem.pending.length > MAX_PENDING) {
        mem.pending.splice(0, mem.pending.length - MAX_PENDING);
    }
}

function pushMessage(messageId) {
    const mem = getMem();
    if (!mem.enabled) return false;
    const context = getContext();
    const msg = context.chat?.[messageId];
    if (!msg || !msg.mes) return false;
    if (processedIds.has(messageId)) return false;
    if (msg.extra?.type === 'narrator' || msg.extra?.type === 'memory') return false;
    processedIds.add(messageId);

    const role = msg.is_user ? '玩家' : '角色';
    mem.pending.push({ role, text: String(msg.mes), chatIndex: messageId });
    capPending(mem);
    if (messageId > (mem._lastCollected ?? -1)) mem._lastCollected = messageId;

    // AI 消息：从正文状态栏正则抓精确数值（每轮即时更新快照，双源校验的精确源）
    if (!msg.is_user) {
        try { applyStatusBar(String(msg.mes)); } catch (e) { /* 忽略 */ }
    }
    return !msg.is_user;
}

/** 主动扫描 chat，把还没记录的消息补进队列（拦截器兜底，不依赖事件触发） */
function collectPendingFromChat() {
    const mem = getMem();
    if (!mem.enabled) return;
    const context = getContext();
    const chat = context.chat || [];

    // 清理已不存在的索引（删消息后 chat 变短）
    for (const id of processedIds) {
        if (id >= chat.length) processedIds.delete(id);
    }
    // 删消息导致 chat 变短时，同步把水位往回缩，避免下次扫描错位
    if ((mem._lastCollected ?? -1) >= chat.length) {
        mem._lastCollected = chat.length - 1;
    }

    // 已入队但内容变了（swipe 刷消息）→ 以最新内容为准，覆盖旧版本
    for (const p of mem.pending) {
        if (p.chatIndex != null && chat[p.chatIndex] && String(chat[p.chatIndex].mes) !== p.text) {
            p.text = String(chat[p.chatIndex].mes);
        }
    }

    // 从「已收集水位 + 1」开始扫，避免刷新/切卡后把整段旧聊天重新总结一遍
    let collected = 0;
    const startIdx = Math.max(0, (mem._lastCollected ?? -1) + 1);
    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || !msg.mes) continue;
        if (processedIds.has(i)) continue;
        if (msg.extra?.type === 'narrator' || msg.extra?.type === 'memory') continue;
        processedIds.add(i);
        const role = msg.is_user ? '玩家' : '角色';
        mem.pending.push({ role, text: String(msg.mes), chatIndex: i });
        capPending(mem);
        collected++;
        if (!msg.is_user) {
            try { applyStatusBar(String(msg.mes)); } catch (e) { /* 忽略 */ }
        }
    }
    if (chat.length) mem._lastCollected = chat.length - 1;

    // swipe 后，最后一条 AI 消息变了 → 重新抓最新数值（覆盖中间版本的脏数据）
    const lastMsg = chat[chat.length - 1];
    if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
        try { applyStatusBar(String(lastMsg.mes)); } catch (e) { /* 忽略 */ }
    }

    if (collected > 0) {
        console.log(LOG, `拦截器补收 ${collected} 条，pending=${mem.pending.length}`);
        checkSummarize();
    }
}

/**
 * 触发判定改为「按消息总数」而非「严格两边各攒满」，避免玩家连发 / 角色不回复时队列卡死。
 * 至少需要 1 条角色消息才开始总结（保证有可提取的正文数值）。
 */
function checkSummarize() {
    const scopeKey = currentScopeKey; // 锁定当前卡，避免 600ms 延迟期间切卡导致总结错位
    const mem = getMemForScope(scopeKey);
    if (summarizing) return;
    const total = mem.pending.length;
    const aiCount = mem.pending.filter(m => m.role === '角色').length;
    if (total >= mem.queueSize * 2 && aiCount >= 1) {
        console.log(LOG, `已攒满 ${total} 条消息，触发自动总结`);
        setTimeout(() => { scheduleSummarize(scopeKey).catch(() => {}); }, 600);
    }
}

async function scheduleSummarize(scopeKey) {
    const mem = getMemForScope(scopeKey || currentScopeKey);
    if (summarizing) return;
    const total = mem.pending.length;
    const aiCount = mem.pending.filter(m => m.role === '角色').length;
    if (total < mem.queueSize * 2 || aiCount < 1) return;

    summarizing = true;
    try {
        // 按时间顺序取出 queueSize 条玩家 + queueSize 条角色（≈ queueSize 轮完整对话）
        const batch = [];
        let u = 0, a = 0;
        const rest = [];
        for (const m of mem.pending) {
            if (m.role === '玩家' && u < mem.queueSize) { batch.push(m); u++; }
            else if (m.role === '角色' && a < mem.queueSize) { batch.push(m); a++; }
            else rest.push(m);
        }
        if (!batch.length) { mem.pending = rest; return; }

        const ok = await summarizeBatch(batch, scopeKey);
        if (ok) {
            mem.pending = rest;
            mem._failCount = 0;
        } else {
            // 失败：把本批放回队首重试，但连续失败 3 次就丢弃本批，避免死循环 + 无限烧 token
            mem._failCount = (mem._failCount || 0) + 1;
            if (mem._failCount >= 3) {
                mem.pending = rest;
                mem._failCount = 0;
                console.warn(LOG, '连续 3 次总结失败，已丢弃本批消息以免死循环。');
            } else {
                mem.pending = batch.concat(rest);
                console.warn(LOG, `总结失败，将重试（第 ${mem._failCount}/2 次）。`);
            }
        }
        persist();
    } finally {
        summarizing = false;
        checkSummarize();
    }
}

/** 手动总结最近 n 条消息（n 条玩家 + n 条角色），返回实际总结的条数 */
async function manualSummarize(n) {
    const scopeKey = currentScopeKey;
    const context = getContext();
    const chat = context.chat || [];
    const msgs = [];
    let userCount = 0, aiCount = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || !msg.mes) continue;
        if (msg.extra?.type === 'narrator' || msg.extra?.type === 'memory') continue;
        const isUser = msg.is_user;
        if (isUser && userCount >= n) continue;
        if (!isUser && aiCount >= n) continue;
        msgs.unshift({ role: isUser ? '玩家' : '角色', text: String(msg.mes) });
        if (isUser) userCount++; else aiCount++;
        if (userCount >= n && aiCount >= n) break;
    }
    if (!msgs.length) return 0;
    const ok = await summarizeBatch(msgs, scopeKey);
    return ok ? msgs.length : 0;
}

async function summarizeBatch(batch, scopeKey) {
    const mem = getMemForScope(scopeKey || currentScopeKey);
    const historyText = batch.map((m, i) => `${i + 1}. [${m.role}] ${m.text}`).join('\n');
    const snapshotText = snapshotToText(mem);

    const result = await callMainApi(
        buildExtractPrompt(historyText, snapshotText, getCharacterRegistry(), getAllFields(mem)),
        '你是剧情记忆归档器，只输出 JSON，不要任何解释。',
        600,
    );
    if (!result) return false;

    const event = extractJson(result);
    if (!event) {
        console.warn(LOG, '无法解析总结 JSON，跳过本次，原始输出：\n', String(result).slice(0, 300));
        return false;
    }

    // 1) 数值快照覆盖更新（通用：接受任意数值字段 + 可选 note 文本）
    if (event.values && typeof event.values === 'object') {
        for (const [name, vals] of Object.entries(event.values)) {
            if (!vals || typeof vals !== 'object') continue;
            const prev = mem.snapshot[name] || {};
            const next = { ...prev };
            for (const [f, v] of Object.entries(vals)) {
                if (v === undefined || v === null) continue;
                if (f === 'note') {
                    if (typeof v === 'string' && v.trim()) next[f] = v.trim();
                    continue;
                }
                const n = typeof v === 'number' ? v
                    : (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : NaN);
                if (isFinite(n)) next[f] = n;
            }
            next._updatedAt = Date.now();
            mem.snapshot[name] = next;
        }
    }

    // 2) 组装事件对象
    const ev = {
        before: event.before || '',
        time: event.time || '',
        location: event.location || '',
        characters: Array.isArray(event.characters) ? event.characters : [],
        event: event.event || '',
        tags: Array.isArray(event.tags) ? event.tags : [],
    };

    // 3) 归档到「主互动对象」名下（多人 = 共有记忆，每人各存一份）
    //    玩家本人只存数值（snapshot），不建「玩家的记忆」事件档，避免注入冗余
    const userSet = new Set(getUserNames());
    const rawMains = Array.isArray(event.mainCharacters) && event.mainCharacters.length
        ? event.mainCharacters
        : ev.characters;
    const mains = rawMains.filter(name => name && !userSet.has(name));
    const archived = new Set();
    for (const name of mains) {
        if (!name || archived.has(name)) continue;
        archived.add(name);
        if (!mem.characters[name]) mem.characters[name] = { events: [], summary: '' };
        mem.characters[name].events.push({ ...ev });
        if (mem.characters[name].events.length > mem.eventsPerChar) {
            const overflow = mem.characters[name].events.splice(0, mem.characters[name].events.length - mem.eventsPerChar);
            await rollCharSummary(mem, name, overflow);
        }
    }

    // 4) 全局大事件轴（所有事件都进，精简保留）
    mem.globalEvents.push({ ...ev });
    if (mem.globalEvents.length > mem.globalMax) {
        const overflow = mem.globalEvents.splice(0, mem.globalEvents.length - mem.globalMax);
        await rollGlobalSummary(mem, overflow);
    }

    // 5) 主线大记忆：本段对主线的宏观推进 → 滚动压缩成连贯主线
    if (typeof event.mainline === 'string' && event.mainline.trim()) {
        await rollMainline(mem, event.mainline.trim());
    }

    persist();
    refreshPanel();
    return true;
}

/** 把主线推进片段追加进主线大记忆（超长再压缩成连贯主线） */
async function rollMainline(mem, piece) {
    mem.mainlineSummary = mem.mainlineSummary ? `${mem.mainlineSummary}\n${piece}` : piece;
    if (mem.mainlineSummary.length > mem.summaryMaxLen) {
        const old = mem.mainlineSummary;
        try {
            const merged = await callMainApi(
                `请把下面的主线总结压缩成一段连贯的宏观主线（400 字以内，保留主要目标、关键关系变化、重大转折、潜在冲突）：\n${old}`,
                '你是剧情主线压缩器，只输出主线正文，不要解释。',
                450,
            );
            if (merged) mem.mainlineSummary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

/** 把某角色滚出的事件压成一段摘要，追加到该角色 summary（超长再压缩） */
async function rollCharSummary(mem, name, events) {
    const text = events.map(eventToLine).join('\n');
    let piece = '';
    try {
        piece = await callMainApi(
            `请把下面这些剧情事件压缩成一段连贯摘要（150 字以内，按时间顺序，保留人物关系和关键数值/状态变化）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文，不要解释。',
            250,
        );
    } catch (e) { /* 忽略 */ }
    if (!piece) piece = text.slice(0, 150);

    const ch = mem.characters[name];
    if (!ch) return;
    ch.summary = ch.summary ? `${ch.summary}\n${piece}` : piece;

    if (ch.summary.length > mem.summaryMaxLen) {
        const old = ch.summary;
        try {
            const merged = await callMainApi(
                `请把下面这位角色的历史摘要压缩成一段（400 字以内，保留人物关系与关键转折）：\n${old}`,
                '你是剧情记忆压缩器，只输出摘要正文。',
                450,
            );
            if (merged) ch.summary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

/** 把滚出的全局大事件压进全局总纲 */
async function rollGlobalSummary(mem, events) {
    const text = events.map(eventToLine).join('\n');
    let piece = '';
    try {
        piece = await callMainApi(
            `请把下面这些全局大事件压缩成一段总纲（200 字以内，按时间顺序，保留跨线重大转折与冲突节点）：\n${text}`,
            '你是剧情记忆压缩器，只输出摘要正文。',
            300,
        );
    } catch (e) { /* 忽略 */ }
    if (!piece) piece = text.slice(0, 200);
    mem.globalSummary = mem.globalSummary ? `${mem.globalSummary}\n${piece}` : piece;
    if (mem.globalSummary.length > mem.summaryMaxLen) {
        const old = mem.globalSummary;
        try {
            const merged = await callMainApi(
                `请把下面的全局总纲压缩成一段（400 字以内，保留核心人物关系和重大转折）：\n${old}`,
                '你是剧情记忆压缩器，只输出摘要正文。',
                450,
            );
            if (merged) mem.globalSummary = merged;
        } catch (e) { /* 保留原样 */ }
    }
}

// ---------- 生成前注入 ----------

function buildInjection(mem, autoWorldView = '') {
    const parts = [];

    // 常驻世界观永远最先注入（手动粘贴的 + 自动拉取的世界书常驻条目）
    const wv = [mem.worldview?.trim(), autoWorldView].filter(Boolean).join('\n');
    if (wv) {
        parts.push(`【世界观·常驻】\n${wv}`);
    }

    // 主线大记忆（宏观主线，始终注入）
    if (mem.mainlineSummary) {
        parts.push(`【主线大记忆】\n${mem.mainlineSummary}`);
    }

    // 数值快照（全量，按人）——注入时强调"以此为基准"，让 AI 输出状态栏数值更严谨
    const snapText = snapshotToText(mem);
    if (snapText) {
        parts.push(`【数值快照】\n${snapText}\n（以上是当前确定的数值，你正文末尾状态栏的数值必须严格以此为基准、加上本轮变动得出，禁止凭空改动或跳回旧值。）`);
    }

    // 当前活跃角色的剧情记忆（和谁互动只注入谁）
    const active = detectActiveCharacters();
    for (const name of active) {
        const ch = mem.characters[name];
        if (!ch) continue;
        const evText = ch.events.slice(-mem.eventsPerChar).map(eventToLine).join('\n');
        const lines = [];
        if (evText) lines.push(`· 近期：\n${evText}`);
        if (ch.summary) lines.push(`· 摘要：\n${ch.summary}`);
        if (lines.length) parts.push(`【${name}的记忆】\n${lines.join('\n')}`);
    }

    // 关联人物注入（通用：活跃角色 → 其关联对象的状态，如 宿敌/伴侣/盟友……）
    const fields = getAllFields(mem);
    for (const name of active) {
        const rel = mem.relations?.[name];
        if (!rel || !rel.target) continue;
        const target = mem.snapshot[rel.target];
        if (!target) continue;
        const kvs = [];
        for (const f of fields) {
            const kv = fieldKv(f, target[f]);
            if (kv) kvs.push(kv);
        }
        if (kvs.length) {
            const label = rel.label ? `（${rel.label}）` : '';
            parts.push(`【关联角色·${rel.target}${label}】\n${kvs.join(' ')}`);
        }
    }

    // 全局大事件轴 + 总纲（精简，保留跨线视角）
    if (mem.globalEvents.length) {
        const g = mem.globalEvents.slice(-10).map(eventToLine).join('\n');
        parts.push(`【全局大事件】\n${g}`);
    }
    if (mem.globalSummary) {
        parts.push(`【全局总纲】\n${mem.globalSummary}`);
    }

    if (!parts.length) return '';

    return `[以下是由记忆插件自动注入的剧情进度参考，供你保持数值与前后文一致；不要在正文里复述这些标签，也不要输出这段内容本身。]\n\n${parts.join('\n\n')}`;
}

/**
 * 提示词拦截器：生成请求发出前，把记忆注入到 chat 末尾。
 * 挂到 globalThis 上（runGenerationInterceptors 通过 globalThis[key] 调用）。
 */
async function storyMemoryInterceptor(chat, contextSize, abort, type) {
    const mem = getMem();
    if (!mem.enabled) return;
    if (type === 'quiet' || type === 'summarize') return;

    // 主动收集未入队的消息（拦截器兜底：每次主对话生成前一定执行，不依赖事件）
    collectPendingFromChat();

    // 自动拉取已启用世界书的常驻条目（作为世界观注入）
    let autoWV = '';
    if (mem.autoWorldInfo && typeof loadWorldInfo === 'function') {
        autoWV = await getConstantWorldInfo();
    }

    const injection = buildInjection(mem, autoWV);
    if (!injection) return;
    chat.push({
        name: '系统记忆',
        is_user: false,
        is_system: true,
        mes: injection,
        extra: { type: 'narrator', memory: true },
        send_date: Date.now(),
    });
}
globalThis.storyMemoryInterceptor = storyMemoryInterceptor;

// ---------- 斜杠命令 ----------

/**
 * 兼容不同酒馆版本的斜杠命令回调参数。
 * 新版 SillyTavern 回调签名是 (namedArgs, unnamedText)，原始参数在第二个位置；
 * 老版可能直接传字符串。这里统一取出「未命名的原始文本」。
 */
function normalizeArgs(args, value) {
    const raw = value !== undefined ? value : args;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.map(String).join(' ');
    if (raw && typeof raw === 'object' && typeof raw.value === 'string') return raw.value;
    return '';
}

function registerCommands() {
    if (typeof registerSlashCommand !== 'function') {
        console.warn(LOG, '当前版本无 registerSlashCommand，斜杠命令不可用（不影响记忆功能）');
        return;
    }
    registerSlashCommand(
        'mem',
        () => {
            const mem = getMem();
            const userCount = mem.pending.filter(m => m.role === '玩家').length;
            const aiCount = mem.pending.filter(m => m.role === '角色').length;
            const lines = [
                '【记忆核心状态】',
                `记忆范围：${scopeLabel(currentScopeKey)}`,
                `状态：${mem.enabled ? '运行中' : '已暂停'}`,
                `待总结：玩家 ${userCount} 条 / 角色 ${aiCount} 条（攒满约 ${mem.queueSize} 轮触发）`,
                `数值快照人物：${Object.keys(mem.snapshot).length} 人`,
                `剧情记忆人物：${Object.keys(mem.characters).length} 人`,
                `全局大事件：${mem.globalEvents.length}/${mem.globalMax} 条`,
                `当前活跃：${detectActiveCharacters().join('、') || '（无）'}`,
            ];
            if (Object.keys(mem.snapshot).length) {
                lines.push('', '—— 数值快照 ——');
                lines.push(snapshotToText(mem));
            }
            return lines.join('\n');
        },
        [],
        '查看记忆核心状态与当前数值快照',
    );

    registerSlashCommand(
        'mem-set',
        (args, value) => {
            const mem = getMem();
            const text = normalizeArgs(args, value);
            const parts = text.trim().split(/\s+/);
            if (parts.length < 3) {
                return `[mem-set 用法] /mem-set 人物 字段 值\n例如：/mem-set 沈清璃 好感 80`;
            }
            const name = parts[0];
            const field = parts[1];
            const rest = parts.slice(2).join(' ');
            mem.snapshot[name] = mem.snapshot[name] || {};
            if (field === 'note') {
                mem.snapshot[name][field] = rest;
            } else {
                const val = Number(parts[2]);
                if (Number.isNaN(val)) return '[mem-set] 数值必须是数字。';
                mem.snapshot[name][field] = val;
            }
            persist();
            return `[mem-set] 已设置 ${name} 的 ${field}=${field === 'note' ? rest : parts[2]}`;
        },
        [],
        '手动修改数值快照：/mem-set 人物 字段 值',
    );

    registerSlashCommand(
        'mem-rm',
        (args, value) => {
            const mem = getMem();
            const text = normalizeArgs(args, value);
            const name = text.trim();
            if (!name) return '[mem-rm 用法] /mem-rm 人物';
            let done = false;
            if (mem.snapshot[name]) { delete mem.snapshot[name]; done = true; }
            if (mem.characters[name]) { delete mem.characters[name]; done = true; }
            if (done) { persist(); return `[mem-rm] 已删除 ${name} 的记忆。`; }
            return `[mem-rm] 记忆里没有「${name}」。`;
        },
        [],
        '删除某人的记忆（快照+剧情）：/mem-rm 人物',
    );

    registerSlashCommand(
        'mem-sum',
        (args, value) => {
            const text = normalizeArgs(args, value);
            const n = parseInt(text.trim()) || 3;
            const count = Math.min(Math.max(n, 1), 20);
            manualSummarize(count);
            return `[记忆核心] 正在手动总结最近 ${count} 条消息，稍后用 /mem 查看结果。`;
        },
        [],
        '手动总结最近 N 条消息：/mem-sum [N]（默认 3，范围 1-20）',
    );

    registerSlashCommand(
        'mem-clear',
        () => {
            clearScopeMem(currentScopeKey);
            return `[记忆核心] 已清空「${scopeLabel(currentScopeKey)}」的全部记忆。`;
        },
        [],
        '清空当前角色卡/群聊的全部记忆',
    );

    registerSlashCommand(
        'mem-clear-all',
        () => {
            clearAllScopes();
            return '[记忆核心] 已清空所有角色卡/群聊的全部记忆。';
        },
        [],
        '清空所有角色卡/群聊的记忆',
    );

    registerSlashCommand(
        'mem-scopes',
        () => {
            const store = getStore();
            const keys = Object.keys(store.scopes || {});
            if (!keys.length) return '[记忆核心] 还没有任何角色卡的记忆。';
            const lines = ['【已保存记忆的角色卡/群聊】'];
            for (const key of keys) {
                const m = store.scopes[key];
                const mark = key === currentScopeKey ? '▶ ' : '  ';
                lines.push(`${mark}${scopeLabel(key)}：人物 ${Object.keys(m.snapshot || {}).length}/${Object.keys(m.characters || {}).length}，事件 ${(m.globalEvents || []).length}`);
            }
            return lines.join('\n');
        },
        [],
        '列出所有角色卡/群聊的记忆',
    );

    registerSlashCommand(
        'mem-export',
        () => {
            const json = exportScope(currentScopeKey);
            return `[记忆核心] 导出「${scopeLabel(currentScopeKey)}」的数据（复制下面这段到「导入记忆」粘贴即可）：\n\`\`\`json\n${json}\n\`\`\``;
        },
        [],
        '导出当前角色卡的记忆为 JSON（复制后可用面板「导入记忆」恢复）',
    );
}

/** 清空某作用域的记忆数据（保留配置字段），并清空该作用域的已处理去重表 */
function clearScopeMem(scopeKey) {
    const mem = getMemForScope(scopeKey);
    mem.pending = [];
    mem.snapshot = {};
    mem.characters = {};
    mem.globalEvents = [];
    mem.globalSummary = '';
    mem.mainlineSummary = '';
    mem._lastCollected = -1;
    mem._failCount = 0;
    const ps = scopeProcessed.get(scopeKey);
    if (ps) ps.clear();
    persist();
}

/** 清空所有作用域的记忆数据 */
function clearAllScopes() {
    const store = getStore();
    for (const key of Object.keys(store.scopes || {})) {
        const m = store.scopes[key];
        m.pending = [];
        m.snapshot = {};
        m.characters = {};
        m.globalEvents = [];
        m.globalSummary = '';
        m.mainlineSummary = '';
        m._lastCollected = -1;
        m._failCount = 0;
    }
    scopeProcessed.clear();
    currentScopeKey = '';
    processedIds = new Set();
    persist();
}

// ---------- 设置面板（可视化改记忆 / 调参数） ----------

function buildSettingsHtml() {
    return `
    <div id="story-memory-settings" class="smem-panel">
        <h3>剧情记忆核心 · Story MemoryCore</h3>
        <div class="smem-row"><label><input type="checkbox" id="smem-enabled"> 启用记忆注入（当前卡）</label></div>
        <div class="smem-label">记忆隔离：每个角色卡 / 群聊各自独立一份记忆，切换时自动切换。</div>
        <div id="smem-scope-indicator" style="color:#f0f0fa;margin-bottom:4px"></div>
        <div id="smem-scopes"></div>
        <hr>

        <div class="smem-manual-box">
            <div class="smem-label">手动总结（测试用，立即出结果）：</div>
            <div class="smem-row">
                总结最近 <input type="number" id="smem-manual-n" min="1" max="20" value="3"> 条消息
                <button id="smem-manual-sum">立即总结</button>
            </div>
        </div>

        <hr>
        <div class="smem-row">总结楼层（攒满约「此值 × 2」条消息自动总结一次）：<input type="number" id="smem-queue" min="2" max="50"></div>
        <div class="smem-row">每人事件窗保留条数：<input type="number" id="smem-events" min="5" max="100"></div>
        <div class="smem-row">全局大事件保留条数：<input type="number" id="smem-globalmax" min="5" max="100"></div>
        <hr>
        <div class="smem-row"><label><input type="checkbox" id="smem-autowi"> 自动拉取已启用世界书的「常驻条目」作为世界观注入</label></div>
        <div class="smem-label">常驻世界观·手动补充（每次生成前优先注入，历史被截断也不丢基础设定）：</div>
        <textarea id="smem-worldview" rows="3" style="width:100%" placeholder="可留空；也可补充世界书里没有的设定"></textarea>
        <hr>
        <div class="smem-label">需要追踪的数值字段（一行一个 / 用顿号或逗号分隔；留空 = 自动识别正文里出现的所有数值状态）：</div>
        <textarea id="smem-fields" rows="2" style="width:100%" placeholder="例如：好感、沉沦、等级、HP、亲密度"></textarea>
        <div class="smem-label">钉住的角色名单（一行一个；留空 = 自动从对话/卡片识别）：</div>
        <textarea id="smem-names" rows="3" style="width:100%" placeholder="例如：&#10;沈清璃&#10;陆国梁"></textarea>
        <div class="smem-row" style="margin-top:4px"><button id="smem-scan-names">🔍 从世界书扫描人名并加入名单</button></div>
        <div class="smem-label">关联人物（可选，一行一个，格式：角色A -&gt; 角色B（关系说明）；A 活跃时额外注入 B 的状态）：</div>
        <textarea id="smem-relations" rows="2" style="width:100%" placeholder="例如：&#10;沈清璃 -&gt; 陆国梁（丈夫）"></textarea>
        <hr>
        <div class="smem-label">数值快照（可直接改，改完自动生效）：</div>
        <div id="smem-snapshot"></div>
        <div class="smem-row" style="margin-top:4px">
            <button id="smem-refresh-snap">🔄 抓取最新数值</button>
            <button id="smem-addperson">＋ 新增人物</button>
        </div>
        <hr>
        <div class="smem-label">剧情记忆（按人分，点名字展开，可删单条事件）：</div>
        <div id="smem-characters"></div>
        <hr>
        <div class="smem-label">全局大事件轴（点标题展开）：</div>
        <div id="smem-globalevents"></div>
        <div class="smem-label">主线大记忆（宏观主线，可编辑）：</div>
        <textarea id="smem-mainline" rows="3" style="width:100%"></textarea>
        <div class="smem-label">全局总纲：</div>
        <textarea id="smem-globalsummary" rows="2" style="width:100%"></textarea>
        <hr>
        <div class="smem-row">
            <button id="smem-export">导出本卡</button>
            <button id="smem-export-all">导出全部卡</button>
            <button id="smem-import">导入记忆</button>
            <button id="smem-clear" class="smem-danger">清空本卡记忆</button>
            <button id="smem-clear-all" class="smem-danger">清空所有卡记忆</button>
        </div>
    </div>`;
}

function renderSnapshot(mem) {
    const container = document.getElementById('smem-snapshot');
    if (!container) return;
    const names = Object.keys(mem.snapshot);
    const fields = getAllFields(mem);
    if (!names.length) {
        container.innerHTML = '<div class="smem-muted">（暂无，总结后自动出现）</div>';
        return;
    }
    let html = '<table class="smem-table"><tr><th>人物</th>';
    for (const f of fields) html += `<th>${escapeHtml(f === 'note' ? '备注' : f)}</th>`;
    html += '<th></th></tr>';
    for (const name of names) {
        html += `<tr><td>${escapeHtml(name)}</td>`;
        for (const f of fields) {
            const v = mem.snapshot[name][f] ?? '';
            if (f === 'note') {
                html += `<td><input type="text" class="smem-val smem-note" data-name="${escapeHtml(name)}" data-field="note" value="${escapeHtml(v)}" style="width:130px"></td>`;
            } else {
                html += `<td><input type="number" class="smem-val" data-name="${escapeHtml(name)}" data-field="${escapeHtml(f)}" value="${v}" style="width:56px"></td>`;
            }
        }
        html += `<td><button class="smem-del" data-name="${escapeHtml(name)}">删</button></td></tr>`;
    }
    html += '</table>';
    container.innerHTML = html;

    container.querySelectorAll('.smem-val').forEach(inp => {
        inp.addEventListener('change', () => {
            const m = getMem();
            const name = inp.dataset.name;
            const field = inp.dataset.field;
            if (!m.snapshot[name]) return;
            if (field === 'note') {
                m.snapshot[name][field] = inp.value;
            } else {
                const v = Number(inp.value);
                if (Number.isNaN(v)) return;
                m.snapshot[name][field] = v;
            }
            persist();
        });
    });
    container.querySelectorAll('.smem-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            delete m.snapshot[btn.dataset.name];
            persist();
            renderSettings();
        });
    });
}

function renderCharacters(mem) {
    const container = document.getElementById('smem-characters');
    if (!container) return;
    const names = Object.keys(mem.characters);
    if (!names.length) {
        container.innerHTML = '<div class="smem-muted">（暂无，总结后自动出现）</div>';
        return;
    }
    let html = '';
    for (const name of names) {
        const ch = mem.characters[name];
        html += `<div class="smem-char-block">`;
        html += `<div class="smem-char-title" data-name="${escapeHtml(name)}"><span class="smem-arrow">▸</span> ${escapeHtml(name)}（事件 ${ch.events.length} 条）</div>`;
        html += `<div class="smem-char-body" style="display:none;margin-top:4px">`;
        if (!ch.events.length) {
            html += `<div class="smem-muted">（暂无事件）</div>`;
        } else {
            ch.events.forEach((e, i) => {
                html += `<div class="smem-item">${escapeHtml(eventToLine(e))} <button class="smem-cev-del" data-name="${escapeHtml(name)}" data-index="${i}">删</button></div>`;
            });
        }
        html += `<textarea class="smem-char-summary" data-name="${escapeHtml(name)}" rows="2" style="width:100%;margin-top:4px" placeholder="该角色的摘要（可编辑）">${escapeHtml(ch.summary || '')}</textarea>`;
        html += `</div>`;
        html += `</div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.smem-char-title').forEach(title => {
        title.addEventListener('click', () => {
            const body = title.nextElementSibling;
            const arrow = title.querySelector('.smem-arrow');
            if (!body) return;
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            if (arrow) arrow.textContent = hidden ? '▾' : '▸';
        });
    });

    container.querySelectorAll('.smem-cev-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const ch = m.characters[btn.dataset.name];
            const i = Number(btn.dataset.index);
            if (ch && !Number.isNaN(i)) { ch.events.splice(i, 1); persist(); renderSettings(); }
        });
    });

    container.querySelectorAll('.smem-char-summary').forEach(ta => {
        ta.addEventListener('change', () => {
            const m = getMem();
            const ch = m.characters[ta.dataset.name];
            if (ch) { ch.summary = ta.value; persist(); }
        });
    });
}

function renderGlobalEvents(mem) {
    const container = document.getElementById('smem-globalevents');
    if (!container) return;
    const count = mem.globalEvents.length;
    let html = `<div class="smem-char-block">`;
    html += `<div class="smem-char-title" id="smem-globalevents-title"><span class="smem-arrow" id="smem-globalevents-arrow">▸</span> 全局大事件轴（${count} 条）</div>`;
    html += `<div id="smem-globalevents-body" style="display:none;margin-top:4px">`;
    if (!count) {
        html += `<div class="smem-item">（暂无）</div>`;
    } else {
        mem.globalEvents.forEach((e, i) => {
            html += `<div class="smem-item">${escapeHtml(eventToLine(e))} <button class="smem-gev-del" data-index="${i}">删</button></div>`;
        });
    }
    html += `</div></div>`;
    container.innerHTML = html;

    document.getElementById('smem-globalevents-title').addEventListener('click', () => {
        const body = document.getElementById('smem-globalevents-body');
        const arrow = document.getElementById('smem-globalevents-arrow');
        if (!body || !arrow) return;
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        arrow.textContent = hidden ? '▾' : '▸';
    });

    container.querySelectorAll('.smem-gev-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const m = getMem();
            const i = Number(btn.dataset.index);
            if (!Number.isNaN(i)) { m.globalEvents.splice(i, 1); persist(); renderSettings(); }
        });
    });
}

function serializeRelations(rel) {
    return Object.entries(rel || {}).map(([name, r]) => `${name} -> ${r.target}${r.label ? '（' + r.label + '）' : ''}`).join('\n');
}

function parseRelations(text) {
    const rel = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const m = t.match(/^\s*(.+?)\s*(?:->|→|=>|>)\s*(.+?)\s*(?:[（(]\s*(.*?)\s*[)）])?\s*$/);
        if (!m) continue;
        const name = m[1].trim();
        const target = m[2].trim();
        const label = (m[3] || '').trim();
        if (name && target) rel[name] = { target, label };
    }
    return rel;
}

function renderSettings() {
    const mem = getMem();
    const $enabled = document.getElementById('smem-enabled');
    if (!$enabled) return;
    $enabled.checked = mem.enabled;
    document.getElementById('smem-autowi').checked = mem.autoWorldInfo !== false;
    document.getElementById('smem-queue').value = mem.queueSize;
    document.getElementById('smem-events').value = mem.eventsPerChar;
    document.getElementById('smem-globalmax').value = mem.globalMax;
    document.getElementById('smem-worldview').value = mem.worldview;
    document.getElementById('smem-fields').value = (mem.valueFields || []).join('、');
    document.getElementById('smem-names').value = (mem.charNames || []).join('\n');
    document.getElementById('smem-relations').value = serializeRelations(mem.relations);
    document.getElementById('smem-mainline').value = mem.mainlineSummary;
    document.getElementById('smem-globalsummary').value = mem.globalSummary;
    const indicator = document.getElementById('smem-scope-indicator');
    if (indicator) indicator.textContent = `▶ 当前记忆范围：${scopeLabel(currentScopeKey)}`;
    renderScopes();
    renderSnapshot(mem);
    renderCharacters(mem);
    renderGlobalEvents(mem);
}

/** 渲染「记忆隔离」作用域列表（各角色卡/群聊的记忆概览 + 删除） */
function renderScopes() {
    const container = document.getElementById('smem-scopes');
    if (!container) return;
    const store = getStore();
    const keys = Object.keys(store.scopes || {});
    if (!keys.length) {
        container.innerHTML = '<div class="smem-muted">（暂无记忆，对话并自动总结后会自动按角色卡建档）</div>';
        return;
    }
    let html = '';
    for (const key of keys) {
        const m = store.scopes[key];
        const isCur = key === currentScopeKey;
        const stats = `人物${Object.keys(m.snapshot || {}).length}/${Object.keys(m.characters || {}).length} · 事件${(m.globalEvents || []).length}`;
        html += `<div class="smem-item" style="display:flex;align-items:center;gap:6px;justify-content:space-between;margin-bottom:2px">
            <span>${isCur ? '▶ ' : ''}${escapeHtml(scopeLabel(key))} <span style="color:#777">（${stats}）</span></span>
            <button class="smem-scope-del" data-key="${escapeHtml(key)}">删</button>
        </div>`;
    }
    container.innerHTML = html;
    container.querySelectorAll('.smem-scope-del').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm(`删除「${scopeLabel(btn.dataset.key)}」的全部记忆？此操作不可恢复。`)) return;
            const key = btn.dataset.key;
            delete store.scopes[key];
            if (store.labels) delete store.labels[key];
            const ps = scopeProcessed.get(key);
            if (ps) { ps.clear(); scopeProcessed.delete(key); }
            persist();
            renderSettings();
        });
    });
}

function bindSettingsEvents() {
    document.getElementById('smem-enabled').addEventListener('change', e => {
        getMem().enabled = e.target.checked;
        persist();
    });
    document.getElementById('smem-autowi').addEventListener('change', e => {
        getMem().autoWorldInfo = e.target.checked;
        persist();
    });
    const bindNum = (id, key) => {
        document.getElementById(id).addEventListener('change', e => {
            const v = Math.max(1, Number(e.target.value) || 1);
            getMem()[key] = v;
            persist();
        });
    };
    bindNum('smem-queue', 'queueSize');
    bindNum('smem-events', 'eventsPerChar');
    bindNum('smem-globalmax', 'globalMax');

    document.getElementById('smem-manual-sum').addEventListener('click', () => {
        const n = Math.min(Math.max(Number(document.getElementById('smem-manual-n').value) || 3, 1), 20);
        manualSummarize(n).then(done => {
            if (done > 0) {
                toastr?.success?.(`已总结最近 ${done} 条消息`);
                renderSettings();
            } else {
                toastr?.warning?.('没有可总结的消息');
            }
        });
    });

    document.getElementById('smem-worldview').addEventListener('change', e => {
        getMem().worldview = e.target.value;
        persist();
    });
    document.getElementById('smem-fields').addEventListener('change', e => {
        getMem().valueFields = e.target.value.split(/[\s,，、\n]+/).map(s => s.trim()).filter(Boolean);
        persist();
        renderSettings();
    });
    document.getElementById('smem-names').addEventListener('change', e => {
        getMem().charNames = e.target.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        persist();
    });
    document.getElementById('smem-relations').addEventListener('change', e => {
        getMem().relations = parseRelations(e.target.value);
        persist();
    });
    document.getElementById('smem-scan-names').addEventListener('click', async () => {
        const candidates = await scanWorldBookNames();
        const mem = getMem();
        const existing = new Set(mem.charNames || []);
        for (const c of candidates) existing.add(c);
        mem.charNames = [...existing];
        persist();
        renderSettings();
        toastr?.success?.(`已从世界书扫描到 ${candidates.length} 个候选人名并加入名单`);
    });
    document.getElementById('smem-mainline').addEventListener('change', e => {
        getMem().mainlineSummary = e.target.value;
        persist();
    });
    document.getElementById('smem-globalsummary').addEventListener('change', e => {
        getMem().globalSummary = e.target.value;
        persist();
    });
    document.getElementById('smem-addperson').addEventListener('click', () => {
        const name = prompt('人物名：');
        if (!name || !name.trim()) return;
        const mem = getMem();
        const n = name.trim();
        if (!mem.snapshot[n]) mem.snapshot[n] = {};
        if (!mem.characters[n]) mem.characters[n] = { events: [], summary: '' };
        persist();
        renderSettings();
    });
    document.getElementById('smem-refresh-snap').addEventListener('click', () => {
        const n = refreshSnapshotFromChat();
        toastr?.success?.(`已抓取最后一条消息的数值（${n} 个字段）`);
    });
    document.getElementById('smem-clear').addEventListener('click', () => {
        if (!confirm(`确定清空「${scopeLabel(currentScopeKey)}」的全部记忆？`)) return;
        clearScopeMem(currentScopeKey);
        renderSettings();
    });
    document.getElementById('smem-clear-all').addEventListener('click', () => {
        if (!confirm('确定清空【所有角色卡/群聊】的全部记忆？此操作不可恢复。')) return;
        clearAllScopes();
        renderSettings();
    });
    document.getElementById('smem-export').addEventListener('click', () => {
        const json = exportScope(currentScopeKey);
        try { navigator.clipboard?.writeText(json); toastr?.success?.('记忆已复制到剪贴板'); } catch (e) { /* 忽略 */ }
        showTextDialog(`导出「${scopeLabel(currentScopeKey)}」（已尝试复制，也可手动全选复制）：`, json);
    });
    document.getElementById('smem-export-all').addEventListener('click', () => {
        const json = exportAllScopes();
        try { navigator.clipboard?.writeText(json); toastr?.success?.('全部卡记忆已复制到剪贴板'); } catch (e) { /* 忽略 */ }
        showTextDialog('导出全部角色卡记忆（已尝试复制，也可手动全选复制）：', json);
    });
    document.getElementById('smem-import').addEventListener('click', showImportDialog);
}

/** 导出单个作用域（当前角色卡）的记忆 */
function exportScope(scopeKey) {
    const mem = getMemForScope(scopeKey);
    const data = {
        _export: 'story-memory',
        _version: 2,
        _time: new Date().toISOString(),
        scope: scopeKey,
        scopeLabel: scopeLabel(scopeKey),
        snapshot: mem.snapshot,
        characters: mem.characters,
        globalEvents: mem.globalEvents,
        globalSummary: mem.globalSummary,
        mainlineSummary: mem.mainlineSummary,
        worldview: mem.worldview,
        valueFields: mem.valueFields,
        charNames: mem.charNames,
        relations: mem.relations,
    };
    return JSON.stringify(data, null, 2);
}

/** 导出所有作用域的记忆 */
function exportAllScopes() {
    const store = getStore();
    return JSON.stringify({
        _export: 'story-memory-all',
        _version: 2,
        _time: new Date().toISOString(),
        scopes: store.scopes,
        labels: store.labels,
    }, null, 2);
}

function importMemory(jsonText) {
    let data;
    try { data = JSON.parse(jsonText); } catch { return false; }

    // 全量导入（含所有角色卡）
    if (data && data._export === 'story-memory-all' && data.scopes && typeof data.scopes === 'object') {
        const store = getStore();
        store.scopes = data.scopes;
        store.labels = data.labels || {};
        scopeProcessed.clear();
        currentScopeKey = '';
        processedIds = new Set();
        persist();
        return true;
    }

    // 单作用域导入（含旧版 ntr-memory / v1 story-memory 导出）
    const isScope = data && (data._export === 'story-memory' || data._export === 'ntr-memory' || data.snapshot || data.characters);
    if (!isScope) return false;
    const mem = getMem();
    if (data.snapshot && typeof data.snapshot === 'object') mem.snapshot = data.snapshot;
    if (data.characters && typeof data.characters === 'object') mem.characters = data.characters;
    if (Array.isArray(data.globalEvents)) mem.globalEvents = data.globalEvents;
    if (typeof data.globalSummary === 'string') mem.globalSummary = data.globalSummary;
    if (typeof data.mainlineSummary === 'string') mem.mainlineSummary = data.mainlineSummary;
    if (typeof data.worldview === 'string') mem.worldview = data.worldview;
    if (Array.isArray(data.valueFields)) mem.valueFields = data.valueFields;
    if (Array.isArray(data.charNames)) mem.charNames = data.charNames;
    if (data.relations && typeof data.relations === 'object') mem.relations = data.relations;
    persist();
    return true;
}

function showTextDialog(title, text) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
        <div style="background:#1e1e1e;padding:16px;border-radius:8px;width:85%;max-width:640px">
            <div style="margin-bottom:8px;color:#eee;font-weight:bold">${escapeHtml(title)}</div>
            <textarea readonly style="width:100%;height:240px;background:#111;color:#ddd;border:1px solid #444">${escapeHtml(text)}</textarea>
            <div style="margin-top:8px;text-align:right"><button class="smem-modal-close">关闭</button></div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.smem-modal-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function showImportDialog() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
        <div style="background:#1e1e1e;padding:16px;border-radius:8px;width:85%;max-width:640px">
            <div style="margin-bottom:8px;color:#eee;font-weight:bold">粘贴导出的记忆 JSON：</div>
            <textarea id="smem-import-text" style="width:100%;height:240px;background:#111;color:#ddd;border:1px solid #444"></textarea>
            <div style="margin-top:8px;text-align:right">
                <button class="smem-modal-close">取消</button>
                <button id="smem-import-ok">导入</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.smem-modal-close').onclick = () => modal.remove();
    modal.querySelector('#smem-import-ok').onclick = () => {
        const text = modal.querySelector('#smem-import-text').value;
        modal.remove();
        try {
            if (importMemory(text)) {
                renderSettings();
                toastr?.success?.('记忆导入成功');
            } else {
                toastr?.error?.('导入失败：数据格式不对');
            }
        } catch (e) {
            toastr?.error?.('导入失败：JSON 解析错误');
        }
    };
}

function mountSettings() {
    const container = document.getElementById('extensions_settings');
    if (!container) return;
    if (document.getElementById('story-memory-settings')) return;
    container.insertAdjacentHTML('beforeend', buildSettingsHtml());
    bindSettingsEvents();
    renderSettings();
    console.log(LOG, '设置面板已挂载到扩展设置区。');
}

// ---------- 启动 ----------

let initialized = false;

function init() {
    if (initialized) return;
    initialized = true;
    getMem();
    if (typeof eventSource?.on === 'function' && event_types) {
        eventSource.on(event_types.MESSAGE_SENT, (messageId) => {
            pushMessage(messageId); // 玩家消息进队列
        });
        // 双保险：MESSAGE_RECEIVED（非流式）+ GENERATION_ENDED（流式/非流式都覆盖），processedIds 去重保证不重复
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
            const isAI = pushMessage(messageId);
            if (isAI) checkSummarize();
        });
        eventSource.on(event_types.GENERATION_ENDED, (chatLength) => {
            const len = (typeof chatLength === 'number' && chatLength > 0) ? chatLength : (getContext().chat?.length || 0);
            const idx = len - 1;
            if (idx < 0) return;
            const isAI = pushMessage(idx);
            if (isAI) checkSummarize();
        });
        // 切换角色卡/群聊时，面板自动切到对应作用域的数据
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try { renderSettings(); } catch (e) { /* 忽略 */ }
        });
    }
    try { registerCommands(); } catch (e) { console.warn(LOG, '命令注册失败：', e); }
    try { mountSettings(); } catch (e) { console.warn(LOG, '设置面板挂载失败：', e); }
    const evOK = typeof eventSource?.on === 'function' && event_types;
    console.log(LOG, `剧情记忆核心已启动。事件监听：${evOK ? '已注册' : '未注册'}（MESSAGE_SENT=${event_types?.MESSAGE_SENT} GENERATION_ENDED=${event_types?.GENERATION_ENDED}）`);
}

if (document.readyState === 'complete') {
    init();
} else {
    window.addEventListener('load', init);
}
try {
    eventSource.on(event_types.APP_READY, init);
} catch (e) { /* 忽略 */ }
