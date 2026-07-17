// ============================================================
//  家庭点菜系统 · 后端服务（server.js）
//  作用：把网页发给家人、保存菜单/订单、提供菜库（原随机菜库）
//  特点：只用 Node 自带功能，不需要安装任何额外软件
//  怎么跑：双击“启动.command”，或终端里执行 node server.js
//  打开方式：浏览器访问 http://localhost:3000 （后台是 /admin）
//
//  【功能说明】
//  - 家人免密点菜页 + 后台管理（菜单/菜库/订单），双登录令牌（管理员/用户）互不相通
//  - “菜库”含 100 道常见菜，每道带“主菜”属性（按主要食材分类）
//  - 下单纯勾选（现有菜锁定默认勾选、菜库菜自由勾选），可许愿，后台仅留最新 3 条
//  - 免费云部署（Render / Hugging Face 等任意云平台）：
//    · 端口读 process.env.PORT（平台分配），本地没设就用 3000，绑定 0.0.0.0
//    · 数据目录读 process.env.DATA_DIR（云上可指向持久盘，不配则用 ./data）
//    · 设置 HF_TOKEN + HF_DATASET 即启用“数据集持久化”，菜单/订单自动存到你的 HF 数据集，
//      解决免费云盘“重启清空”问题；本地不配置则纯本地文件存储
// ============================================================

// ---- 1. 引入 Node 自带的工具模块（都不用安装） ----
const http = require('http');       // 创建网页服务器，接收浏览器请求
const fs = require('fs');            // 读写电脑上的文件（菜单、订单都存在文件里）
const path = require('path');        // 处理文件路径，防止越界访问
const crypto = require('crypto');    // 生成随机登录令牌、给密码加密
const { URL } = require('url');      // 把网址拆成路径和参数
const xlsx = require('xlsx');         // 第三方库：生成/读取真正的 Excel(.xlsx) 文件（管理员导出/导入菜库用）

// ---- 2. 基础配置（一般不用改） ----
const PORT = process.env.PORT || 3000;               // 网页端口号（云部署时由平台用 PORT 环境变量指定）
const PUBLIC_DIR = path.join(__dirname, 'public');   // 前端网页文件放这个文件夹
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data'); // 数据文件夹（云部署可指向持久盘，如 /data）
const STORE_FILE = path.join(DATA_DIR, 'store.json');// 所有数据都保存在这个文件里

// —— 以下两个是“云部署数据集持久化”用的（本地不配置就跳过，不影响本地使用）——
const HF_TOKEN = process.env.HF_TOKEN || '';        // Hugging Face 写权限令牌；设置了才启用同步
const HF_DATASET = process.env.HF_DATASET || '';    // 数据集仓库名，格式：用户名/数据集名（如 wangjiaer/family-menu-data）
const HF_API_BASE = process.env.HF_API_BASE || 'https://huggingface.co'; // API 地址（默认官方；自托管或测试时可改）

const DEFAULT_ADMIN_PASSWORD = '123456';             // 首次登录后台的密码（进去后可改）
const DEFAULT_USER_PASSWORD = '1';                   // 家人点菜页的登录密码（你要求的默认 1）

// ---- 3. 几个小工具函数 ----
// 把密码变成一串看不懂的乱码（加密），这样数据文件里不会出现真密码
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
// 生成一个随机 id（给每个菜品、每份订单用，保证不重复）
function genId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---- 4. 登录令牌管理（本次新增“角色”概念） ----
// 以前所有令牌混在一起，现在区分 role：'admin' 是后台管理员，'user' 是点菜的家人
// tokens 这张表记录：令牌字符串 -> 角色。服务器重启会清空，需要重新登录（家庭使用够用）
const tokens = new Map();
// 生成一个带角色的令牌并登记
function genToken(role) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, role);
  return t;
}
// 从请求头里取出令牌
function getToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
// 取出令牌对应的角色（没有或失效就返回 null）
function getRole(req) {
  const t = getToken(req);
  return t ? (tokens.get(t) || null) : null;
}
// 判断是不是“管理员”令牌
function isAdmin(req) { return getRole(req) === 'admin'; }
// 判断是不是“用户（点菜家人）”令牌
function isUser(req) { return getRole(req) === 'user'; }

// ---- 5. 100 道常见菜（家常 + 川湘 混合），这是“菜库”
// 说明：
//   - category：旧的分类标签（荤菜/素菜/汤羹/主食/凉菜），后台查看用
//   - 主菜：本次新增，按“主要食材”分类（猪肉/鸡肉/蔬菜…），前端侧边栏用它分组
const RANDOM_DISHES_100 = [
  { name: '番茄炒蛋', category: '素菜', 主菜: '鸡蛋' },
  { name: '青椒炒肉', category: '荤菜', 主菜: '猪肉' },
  { name: '红烧肉', category: '荤菜', 主菜: '猪肉' },
  { name: '鱼香肉丝', category: '荤菜', 主菜: '猪肉' },
  { name: '宫保鸡丁', category: '荤菜', 主菜: '鸡肉' },
  { name: '麻婆豆腐', category: '荤菜', 主菜: '豆腐' },
  { name: '酸辣土豆丝', category: '素菜', 主菜: '蔬菜' },
  { name: '清炒西兰花', category: '素菜', 主菜: '蔬菜' },
  { name: '蒜蓉空心菜', category: '素菜', 主菜: '蔬菜' },
  { name: '西红柿鸡蛋汤', category: '汤羹', 主菜: '鸡蛋' },
  { name: '紫菜蛋花汤', category: '汤羹', 主菜: '鸡蛋' },
  { name: '冬瓜排骨汤', category: '汤羹', 主菜: '猪肉' },
  { name: '可乐鸡翅', category: '荤菜', 主菜: '鸡肉' },
  { name: '糖醋里脊', category: '荤菜', 主菜: '猪肉' },
  { name: '红烧茄子', category: '素菜', 主菜: '蔬菜' },
  { name: '地三鲜', category: '素菜', 主菜: '蔬菜' },
  { name: '干煸四季豆', category: '荤菜', 主菜: '蔬菜' },
  { name: '清蒸鲈鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '红烧鲤鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '油焖大虾', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '蒜蓉粉丝蒸扇贝', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '口水鸡', category: '荤菜', 主菜: '鸡肉' },
  { name: '夫妻肺片', category: '荤菜', 主菜: '牛肉' },
  { name: '回锅肉', category: '荤菜', 主菜: '猪肉' },
  { name: '水煮肉片', category: '荤菜', 主菜: '猪肉' },
  { name: '辣子鸡', category: '荤菜', 主菜: '鸡肉' },
  { name: '毛血旺', category: '荤菜', 主菜: '猪肉' },
  { name: '酸菜鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '剁椒鱼头', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '辣椒炒肉', category: '荤菜', 主菜: '猪肉' },
  { name: '农家小炒肉', category: '荤菜', 主菜: '猪肉' },
  { name: '东安子鸡', category: '荤菜', 主菜: '鸡肉' },
  { name: '永州血鸭', category: '荤菜', 主菜: '鸭肉' },
  { name: '干锅菜花', category: '荤菜', 主菜: '蔬菜' },
  { name: '手撕包菜', category: '素菜', 主菜: '蔬菜' },
  { name: '蚝油生菜', category: '素菜', 主菜: '蔬菜' },
  { name: '凉拌黄瓜', category: '凉菜', 主菜: '蔬菜' },
  { name: '拍黄瓜', category: '凉菜', 主菜: '蔬菜' },
  { name: '皮蛋豆腐', category: '凉菜', 主菜: '豆腐' },
  { name: '凉拌木耳', category: '凉菜', 主菜: '菌菇' },
  { name: '凉拌海带丝', category: '凉菜', 主菜: '蔬菜' },
  { name: '白切鸡', category: '荤菜', 主菜: '鸡肉' },
  { name: '盐水鸭', category: '荤菜', 主菜: '鸭肉' },
  { name: '红烧鸡块', category: '荤菜', 主菜: '鸡肉' },
  { name: '土豆炖牛肉', category: '荤菜', 主菜: '牛肉' },
  { name: '萝卜炖牛腩', category: '荤菜', 主菜: '牛肉' },
  { name: '番茄牛腩', category: '荤菜', 主菜: '牛肉' },
  { name: '葱爆羊肉', category: '荤菜', 主菜: '羊肉' },
  { name: '孜然羊肉', category: '荤菜', 主菜: '羊肉' },
  { name: '京酱肉丝', category: '荤菜', 主菜: '猪肉' },
  { name: '木须肉', category: '荤菜', 主菜: '猪肉' },
  { name: '荷兰豆炒腊肉', category: '荤菜', 主菜: '猪肉' },
  { name: '芹菜炒香干', category: '素菜', 主菜: '豆腐' },
  { name: '韭菜炒鸡蛋', category: '素菜', 主菜: '鸡蛋' },
  { name: '洋葱炒鸡蛋', category: '素菜', 主菜: '鸡蛋' },
  { name: '西葫芦炒肉', category: '荤菜', 主菜: '猪肉' },
  { name: '杏鲍菇炒肉', category: '荤菜', 主菜: '猪肉' },
  { name: '香菇炒青菜', category: '素菜', 主菜: '蔬菜' },
  { name: '上汤娃娃菜', category: '素菜', 主菜: '蔬菜' },
  { name: '蒜蓉娃娃菜', category: '素菜', 主菜: '蔬菜' },
  { name: '白灼虾', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '清炒虾仁', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '腰果虾仁', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '滑蛋虾仁', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '蟹味菇炒蛋', category: '素菜', 主菜: '鸡蛋' },
  { name: '蒸水蛋', category: '素菜', 主菜: '鸡蛋' },
  { name: '肉末蒸蛋', category: '荤菜', 主菜: '鸡蛋' },
  { name: '红烧豆腐', category: '素菜', 主菜: '豆腐' },
  { name: '家常豆腐', category: '荤菜', 主菜: '豆腐' },
  { name: '铁板豆腐', category: '素菜', 主菜: '豆腐' },
  { name: '煎带鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '红烧带鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '糖醋带鱼', category: '荤菜', 主菜: '鱼虾海鲜' },
  { name: '酱牛肉', category: '荤菜', 主菜: '牛肉' },
  { name: '卤鸡腿', category: '荤菜', 主菜: '鸡肉' },
  { name: '红烧排骨', category: '荤菜', 主菜: '猪肉' },
  { name: '糖醋排骨', category: '荤菜', 主菜: '猪肉' },
  { name: '排骨炖豆角', category: '荤菜', 主菜: '猪肉' },
  { name: '玉米排骨汤', category: '汤羹', 主菜: '猪肉' },
  { name: '莲藕排骨汤', category: '汤羹', 主菜: '猪肉' },
  { name: '鲫鱼豆腐汤', category: '汤羹', 主菜: '鱼虾海鲜' },
  { name: '香菇鸡汤', category: '汤羹', 主菜: '鸡肉' },
  { name: '山药排骨汤', category: '汤羹', 主菜: '猪肉' },
  { name: '银耳莲子羹', category: '汤羹', 主菜: '菌菇' },
  { name: '八宝粥', category: '主食', 主菜: '主食' },
  { name: '小米粥', category: '主食', 主菜: '主食' },
  { name: '皮蛋瘦肉粥', category: '主食', 主菜: '猪肉' },
  { name: '阳春面', category: '主食', 主菜: '主食' },
  { name: '炸酱面', category: '主食', 主菜: '主食' },
  { name: '西红柿打卤面', category: '主食', 主菜: '主食' },
  { name: '蛋炒饭', category: '主食', 主菜: '主食' },
  { name: '扬州炒饭', category: '主食', 主菜: '主食' },
  { name: '酱油炒饭', category: '主食', 主菜: '主食' },
  { name: '葱油饼', category: '主食', 主菜: '主食' },
  { name: '手抓饼', category: '主食', 主菜: '主食' },
  { name: '猪肉白菜饺子', category: '主食', 主菜: '猪肉' },
  { name: '韭菜鸡蛋饺子', category: '主食', 主菜: '鸡蛋' },
  { name: '猪肉大葱包子', category: '主食', 主菜: '猪肉' },
  { name: '馒头', category: '主食', 主菜: '主食' },
  { name: '花卷', category: '主食', 主菜: '主食' }
];

// ---- 6. 生成默认数据（第一次运行时用） ----
function createDefaultStore() {
  // 把 100 道菜变成带 id 的格式存进“菜库”
  const dishes = RANDOM_DISHES_100.map(d => ({
    id: genId(), name: d.name, category: d.category, 主菜: d.主菜
  }));

  // 给“点菜菜单（现有菜）”先放几道示例菜，你进后台可随意增删改
  const sampleMenu = [
    { name: '番茄炒蛋', category: '素菜', price: 12, desc: '家常经典', available: true },
    { name: '红烧肉', category: '荤菜', price: 38, desc: '肥而不腻', available: true },
    { name: '麻婆豆腐', category: '荤菜', price: 16, desc: '麻辣鲜香', available: true },
    { name: '清炒西兰花', category: '素菜', price: 14, desc: '清淡爽口', available: true },
    { name: '可乐鸡翅', category: '荤菜', price: 28, desc: '孩子爱吃', available: true },
    { name: '酸辣土豆丝', category: '素菜', price: 10, desc: '下饭神器', available: true },
    { name: '西红柿鸡蛋汤', category: '汤羹', price: 10, desc: '开胃暖胃', available: true },
    { name: '米饭', category: '主食', price: 2, desc: '一碗', available: true }
  ].map(m => ({ id: genId(), ...m }));

  return {
    menu: sampleMenu,            // 点菜菜单（后台可编辑），对应前端“现有菜”
    dishes: dishes,              // 菜库（100 道，带主菜属性，用于前端分类+随机）
    orders: [],                  // 家人下的订单（含许愿）
    admin: { passwordHash: sha256(DEFAULT_ADMIN_PASSWORD) }, // 后台密码（加密保存）
    user: { passwordHash: sha256(DEFAULT_USER_PASSWORD) }    // 家人点菜页密码（默认 1）
  };
}

// 兼容/兜底：给一份可能很旧的数据做修复，确保字段齐全
// 返回修复后的数据对象；本地加载和云端恢复共用，避免重复代码
function normalizeStore(raw) {
  const s = raw || {};
  let changed = false;

  // —— 兼容旧数据：把老的 randomDishes 改名为 dishes，并给每道菜补上“主菜” ——
  if (Array.isArray(s.randomDishes) && !Array.isArray(s.dishes)) {
    const seedMain = {};
    RANDOM_DISHES_100.forEach(d => { seedMain[d.name] = d.主菜; });
    s.dishes = s.randomDishes.map(d => ({
      id: d.id, name: d.name, category: d.category || '荤菜',
      主菜: seedMain[d.name] || '其他'
    }));
    delete s.randomDishes;
    changed = true;
  }
  // —— 兼容旧数据：没有用户密码就补上（默认 1） ——
  if (!s.user || !s.user.passwordHash) {
    s.user = { passwordHash: sha256(DEFAULT_USER_PASSWORD) };
    changed = true;
  }
  // 旧的 store 可能既没 menu 也没 dishes 也没 orders，做个兜底保护
  if (!Array.isArray(s.menu)) s.menu = [];
  if (!Array.isArray(s.dishes)) s.dishes = [];
  if (!Array.isArray(s.orders)) s.orders = [];

  return { store: s, changed };
}

// 读取数据：本地文件存在就读取，不存在就建一份默认的
function loadStore() {
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      const { store, changed } = normalizeStore(raw);
      if (changed) saveStore(store); // 有改动才回写，避免无谓写入
      return store;
    } catch (e) {
      console.error('数据文件损坏，已用默认数据重建');
    }
  }
  const store = createDefaultStore();
  saveStore(store);
  return store;
}

// 保存数据到文件（这是“本地兜底”存储）
function saveStore(s) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2), 'utf8');
  syncToHub(); // 云部署时顺便同步到数据集（本地没配 HF 环境变量就不联网）
}

// ================= 云部署数据集持久化（Hugging Face） =================
// 思路：免费版 Space 的本地磁盘重启会清空，所以把 store.json 自动存到
// 你的 Hugging Face 数据集里。只要设置了 HF_TOKEN + HF_DATASET 两个环境变量就启用，
// 本地（没设置）完全不受影响。
let startupDone = false; // 启动时还没从数据集恢复完，先别上传，避免用默认值覆盖云端真实数据

// 从数据集拉取最新 store.json（启动时恢复数据，防止覆盖云端已存的内容）
async function loadFromHub() {
  if (!HF_TOKEN || !HF_DATASET) { startupDone = true; return; } // 没配置就不联网
  const url = `${HF_API_BASE}/datasets/${HF_DATASET}/resolve/main/store.json`;
  try {
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${HF_TOKEN}` } });
    if (resp.status === 404) {
      // 数据集里还没有 store.json（首次运行），先创建默认数据，稍后保存时会上传
      console.log('[Hub] 数据集还没有 store.json（首次运行），将创建默认数据并上传');
      startupDone = true;
      syncToHub(); // 上传默认数据到数据集
      return;
    }
    if (!resp.ok) { console.error('[Hub] 拉取数据失败，状态码', resp.status); startupDone = true; return; }
    const remote = JSON.parse(await resp.text());
    const { store: s } = normalizeStore(remote); // 走一遍兼容迁移
    store = s;                  // 用云端数据覆盖当前内存里的数据
    saveStoreLocal(store);      // 写回本地一份（容器内兜底）
    console.log('[Hub] 已从数据集恢复数据（菜单/菜库/订单）');
    startupDone = true;
  } catch (e) {
    console.error('[Hub] 拉取数据异常：', e.message);
    startupDone = true;
  }
}

// 防抖上传：saveStore 频繁调用时，800ms 内只真正上传一次，且用最新数据
let hubSyncTimer = null;
function syncToHub() {
  if (!HF_TOKEN || !HF_DATASET) return; // 本地模式不联网
  if (!startupDone) return;             // 启动时还没恢复完，先不上传，避免覆盖云端真实数据
  if (hubSyncTimer) return;             // 已有待发任务，跳过（稍后用最新数据再传）
  hubSyncTimer = setTimeout(async () => {
    hubSyncTimer = null;
    try {
      // 把当前整个 store 序列化成 base64，作为提交内容
      const content = Buffer.from(JSON.stringify(store, null, 2), 'utf8').toString('base64');
      const url = `${HF_API_BASE}/api/datasets/${HF_DATASET}/commit/main`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 说明：Hugging Face 提交接口要求必填 summary（提交说明，字符串），
          // 旧版接口用 summary 当提交信息；新版用 commit_message。两者都带上，
          // 兼容不同版本的 HF 接口，避免报 400“expected string, received undefined → at value.summary”
          summary: '自动同步 store.json',
          commit_message: '自动同步 store.json',
          operations: [{ operation: 'upload', path: 'store.json', content }]
        })
      });
      if (!resp.ok) {
        const txt = await resp.text();
        console.error('[Hub] 上传失败，状态码', resp.status, txt.slice(0, 200));
      } else {
        console.log('[Hub] 已同步 store.json 到数据集');
      }
    } catch (e) {
      console.error('[Hub] 上传异常：', e.message);
    }
  }, 800);
}

// 只写本地文件、不触发上传（供 loadFromHub 回写用，避免回写又触发上传形成循环）
function saveStoreLocal(s) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// 真正的数据对象（整个程序共用这一份）
let store = loadStore();

// ---- 7. 给浏览器返回 JSON 数据的小工具 ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 读取 POST 请求里浏览器发来的 JSON 内容
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---- 8. 处理所有 /api 开头的接口请求 ----
function handleApi(req, res, parsed, method) {
  const p = parsed.pathname;

  // ============ 公开接口（不需要登录） ============

  // 【登录】家人点菜页登录，密码对了发“用户”令牌
  if (p === '/api/user/login' && method === 'POST') {
    return readBody(req).then(body => {
      const pw = body.password || '';
      if (store.user && sha256(pw) === store.user.passwordHash) {
        const token = genToken('user');
        return sendJson(res, 200, { ok: true, token });
      }
      return sendJson(res, 401, { ok: false, msg: '密码错误' });
    });
  }

  // 【登录】后台管理员登录，密码对了发“管理员”令牌
  if (p === '/api/admin/login' && method === 'POST') {
    return readBody(req).then(body => {
      const pw = body.password || '';
      if (store.admin && sha256(pw) === store.admin.passwordHash) {
        const token = genToken('admin');
        return sendJson(res, 200, { ok: true, token });
      }
      return sendJson(res, 401, { ok: false, msg: '密码错误' });
    });
  }

  // ============ 以下接口：家人点菜页（需要“用户”令牌） ============
  if (p === '/api/menu' && method === 'GET') {
    if (!isUser(req)) return sendJson(res, 401, { ok: false, msg: '请先登录' });
    // 只返回在售的菜，给前端“现有菜”分类用
    const list = store.menu
      .filter(m => m.available !== false)
      .map(m => ({ id: m.id, name: m.name, category: m.category, price: m.price, desc: m.desc }));
    return sendJson(res, 200, { ok: true, menu: list });
  }

  // 【用户】拉取整个菜库（按主菜分类用）。返回 id/名称/主菜/分类
  if (p === '/api/dishes' && method === 'GET') {
    if (!isUser(req)) return sendJson(res, 401, { ok: false, msg: '请先登录' });
    const list = store.dishes.map(d => ({ id: d.id, name: d.name, 主菜: d.主菜, category: d.category }));
    return sendJson(res, 200, { ok: true, dishes: list });
  }

  // 【用户】随机菜单：?count=数量，从菜库里随机抽几道
  if (p === '/api/random' && method === 'GET') {
    if (!isUser(req)) return sendJson(res, 401, { ok: false, msg: '请先登录' });
    let count = parseInt(parsed.searchParams.get('count') || '3', 10);
    if (isNaN(count) || count < 1) count = 3;
    if (count > store.dishes.length) count = store.dishes.length;
    // 洗牌算法：把菜库顺序打乱，取前 count 个，保证不重复
    const pool = store.dishes.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, count).map(d => ({ id: d.id, name: d.name, 主菜: d.主菜 }));
    return sendJson(res, 200, { ok: true, dishes: picked });
  }

  // 【用户】提交订单（家人在前端点完菜后提交）
  // 新模型：纯勾选，不需要数量和称呼/餐别；
  // 订单里始终是“现有菜”(默认勾选、锁定) + 家人额外勾选的菜库菜
  if (p === '/api/order' && method === 'POST') {
    if (!isUser(req)) return sendJson(res, 401, { ok: false, msg: '请先登录' });
    return readBody(req).then(body => {
      const wish = (body.wish || '').trim();
      const items = Array.isArray(body.items) ? body.items : [];

      if (items.length === 0 && !wish) {
        return sendJson(res, 400, { ok: false, msg: '请至少选一个菜，或写个许愿' });
      }

      // 把菜品 id 换成“名称+价格”存进订单，防止以后菜单改了订单看不懂
      // 注意：菜品可能来自“现有菜”(menu) 或“菜库”(dishes)，两个地方都找一下
      const allSource = store.menu.concat(store.dishes);
      const orderItems = items.map(it => {
        const m = allSource.find(x => x.id === it.id);
        const price = (m && typeof m.price === 'number') ? m.price : 0;
        return { id: it.id, name: m ? m.name : '已下架菜品', qty: it.qty || 1, price };
      });

      const order = {
        id: genId(),
        name: '',   // 新模型不再收集称呼
        meal: '',   // 新模型不再收集餐别
        items: orderItems, wish,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        done: false
      };
      store.orders.unshift(order); // 新订单放最前面
      // 防止数据越积越多：只保留最新的 3 条订单
      if (store.orders.length > 3) store.orders = store.orders.slice(0, 3);
      saveStore(store);
      return sendJson(res, 200, { ok: true, orderId: order.id });
    }).catch(() => sendJson(res, 400, { ok: false, msg: '数据格式错误' }));
  }

  // 【用户】按订单 id 查某一单（前端“我最近点的”用）
  let oid = p.match(/^\/api\/order\/([a-f0-9]+)$/);
  if (oid && method === 'GET') {
    if (!isUser(req)) return sendJson(res, 401, { ok: false, msg: '请先登录' });
    const ord = store.orders.find(x => x.id === oid[1]);
    if (!ord) return sendJson(res, 404, { ok: false, msg: '订单不存在' });
    return sendJson(res, 200, { ok: true, order: ord });
  }

  // ============ 以下接口：后台管理（需要“管理员”令牌） ============

  // 验证管理员令牌是否有效（前端用来判断要不要显示后台）
  if (p === '/api/admin/me' && method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return sendJson(res, 200, { ok: true });
  }

  // 【后台】菜单：查看全部（含下架的）
  if (p === '/api/admin/menu' && method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return sendJson(res, 200, { ok: true, menu: store.menu });
  }
  // 【后台】菜单：新增或修改（有 id 就是改，没 id 就是加）
  if (p === '/api/admin/menu' && method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return readBody(req).then(body => {
      if (body.id) {
        const m = store.menu.find(x => x.id === body.id);
        if (m) {
          m.name = body.name; m.category = body.category;
          m.price = body.price; m.desc = body.desc;
          m.available = body.available !== false;
        }
      } else {
        store.menu.push({
          id: genId(), name: body.name, category: body.category,
          price: body.price, desc: body.desc, available: body.available !== false
        });
      }
      saveStore(store);
      return sendJson(res, 200, { ok: true });
    });
  }
  // 【后台】菜单：删除某个菜（路径里带 id）
  let m = p.match(/^\/api\/admin\/menu\/([a-f0-9]+)$/);
  if (m && method === 'DELETE') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    store.menu = store.menu.filter(x => x.id !== m[1]);
    saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  // —— 菜库（原随机菜库） ——
  // 【后台】菜库：查看全部
  if (p === '/api/admin/dishes' && method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return sendJson(res, 200, { ok: true, dishes: store.dishes });
  }
  // 【后台】菜库：新增一道菜（带主菜属性）
  if (p === '/api/admin/dishes' && method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return readBody(req).then(body => {
      const name = (body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, msg: '请填写菜名' });
      store.dishes.push({
        id: genId(),
        name,
        category: body.category || '荤菜',
        主菜: body.主菜 || '其他'
      });
      saveStore(store);
      return sendJson(res, 200, { ok: true });
    });
  }
  // 【后台】菜库：修改一道菜（改名称 / 主菜 / 分类）
  let pe = p.match(/^\/api\/admin\/dishes\/([a-f0-9]+)$/);
  if (pe && method === 'PUT') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return readBody(req).then(body => {
      const d = store.dishes.find(x => x.id === pe[1]);
      if (d) {
        if (body.name) d.name = (body.name || '').trim();
        if (body.主菜) d.主菜 = body.主菜;
        if (body.category) d.category = body.category;
        saveStore(store);
      }
      return sendJson(res, 200, { ok: true });
    });
  }
  // 【后台】菜库：删除一道菜
  if (pe && method === 'DELETE') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    store.dishes = store.dishes.filter(x => x.id !== pe[1]);
    saveStore(store);
    return sendJson(res, 200, { ok: true });
  }
  // 【后台】菜库：导出为真正 Excel(.xlsx) 文件，浏览器会下载
  if (p === '/api/admin/dishes/export' && method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    // 把每道菜整理成 Excel 的一行
    const rows = store.dishes.map(d => ({ 菜名: d.name, 分类: d.category || '', 主菜: d.主菜 || '' }));
    const ws = xlsx.utils.json_to_sheet(rows);          // 由数组生成工作表
    const wb = xlsx.utils.book_new();                   // 新建工作簿
    xlsx.utils.book_append_sheet(wb, ws, '菜库');        // 把工作表放进工作簿
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }); // 写成 xlsx 二进制
    const fname = encodeURIComponent('菜库.xlsx'); // 中文文件名需按 RFC5987 编码，否则 HTTP 头报错
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dishes.xlsx"; filename*=UTF-8''${fname}`,
      'Content-Length': buf.length
    });
    return res.end(buf);
  }
  // 【后台】菜库：导入 Excel(.xlsx)，上传后按“菜名”新增或更新
  if (p === '/api/admin/dishes/import' && method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return readBody(req).then(body => {
      const base64 = body.file || '';
      const replace = body.replace === true;            // 为 true 表示“清空现有菜库再整张替换”
      if (!base64) return sendJson(res, 400, { ok: false, msg: '没有收到文件' });
      let buf;
      try { buf = Buffer.from(base64, 'base64'); } catch (e) { return sendJson(res, 400, { ok: false, msg: '文件格式错误' }); }
      const wb = xlsx.read(buf, { type: 'buffer' });    // 读取 Excel
      const ws = wb.Sheets[wb.SheetNames[0]];           // 取第一个工作表
      const rows = xlsx.utils.sheet_to_json(ws);        // 转成数组
      const incoming = rows.map(r => ({
        name: (r['菜名'] || r['菜名 '] || '').toString().trim(),
        分类: (r['分类'] || '').toString().trim(),
        主菜: (r['主菜'] || '').toString().trim()
      })).filter(r => r.name);                          // 去掉没写菜名的空行
      if (incoming.length === 0) return sendJson(res, 400, { ok: false, msg: 'Excel 里没有有效的菜（需要“菜名”列）' });

      let added = 0, updated = 0;
      if (replace) {
        // 整张替换：先清空，再把 Excel 里的菜全部加进去
        store.dishes = incoming.map(r => ({ id: genId(), name: r.name, category: r.分类 || '荤菜', 主菜: r.主菜 || '其他' }));
        added = incoming.length;
      } else {
        // 合并模式（默认）：按菜名更新已有，菜名不存在则新增
        const byName = {};
        store.dishes.forEach(d => { byName[d.name] = d; });
        incoming.forEach(r => {
          if (byName[r.name]) {                          // 已存在 → 更新分类/主菜
            byName[r.name].category = r.分类 || byName[r.name].category;
            byName[r.name].主菜 = r.主菜 || byName[r.name].主菜;
            updated++;
          } else {                                        // 不存在 → 新增
            const d = { id: genId(), name: r.name, category: r.分类 || '荤菜', 主菜: r.主菜 || '其他' };
            store.dishes.push(d); byName[r.name] = d; added++;
          }
        });
      }
      saveStore(store);
      // 上传成功后立刻同步到数据集（若已开启持久化）
      if (HF_TOKEN && HF_DATASET) syncToHub();
      return sendJson(res, 200, { ok: true, added, updated, total: store.dishes.length });
    }).catch(() => sendJson(res, 400, { ok: false, msg: '文件读取失败' }));
  }

  // 【后台】订单：查看全部
  if (p === '/api/admin/orders' && method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return sendJson(res, 200, { ok: true, orders: store.orders });
  }
  // 【后台】订单：标记完成 / 取消完成
  let o = p.match(/^\/api\/admin\/order\/([a-f0-9]+)\/done$/);
  if (o && method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    const ord = store.orders.find(x => x.id === o[1]);
    if (ord) { ord.done = !ord.done; saveStore(store); }
    return sendJson(res, 200, { ok: true });
  }

  // 【后台】修改密码
  if (p === '/api/admin/password' && method === 'POST') {
    if (!isAdmin(req)) return sendJson(res, 401, { ok: false, msg: '请先登录后台' });
    return readBody(req).then(body => {
      if (sha256(body.old) !== store.admin.passwordHash) {
        return sendJson(res, 400, { ok: false, msg: '原密码错误' });
      }
      store.admin.passwordHash = sha256(body.new);
      saveStore(store);
      return sendJson(res, 200, { ok: true });
    });
  }

  // 没匹配到任何接口
  return sendJson(res, 404, { ok: false, msg: '接口不存在' });
}

// ---- 9. 发送网页文件（前端页面） ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  // 默认首页是 index.html；/admin 指向后台页面
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel === '/admin') rel = '/admin.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  // 安全检查：只允许访问 public 目录里的文件，防止读到系统其他文件
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('页面不存在'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- 10. 启动服务器 ----
const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  if (parsed.pathname.startsWith('/api/')) {
    handleApi(req, res, parsed, req.method); // 接口请求
  } else {
    serveStatic(req, res, parsed.pathname);  // 网页请求
  }
});

// 启动时先尝试从数据集恢复数据（仅当配置了 HF 环境变量），恢复完再开始监听端口
(async () => {
  await loadFromHub();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 家庭点菜系统已启动`);
    console.log(`   监听端口：${PORT}（云部署时由平台分配，并绑定 0.0.0.0）`);
    console.log(`   家人点菜页：http://localhost:${PORT}（免密直接进入）`);
    console.log(`   后台管理页：http://localhost:${PORT}/admin（登录密码：${DEFAULT_ADMIN_PASSWORD}）`);
    if (HF_TOKEN && HF_DATASET) {
      console.log(`   🔄 已启用数据集持久化：数据集「${HF_DATASET}」（菜单/订单重启不丢）`);
    } else {
      console.log(`   💾 本地模式：数据存在 ${STORE_FILE}`);
    }
  });
})();
