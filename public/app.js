// ============================================================
//  用户前端逻辑（app.js）
//  负责：自动登录、拉菜单/菜库、按分类展示、勾选菜品、随机搭配、提交订单、显示最近一单
//  新模型：
//    - 免密码：页面一打开就自动用默认密码登录（家人无感，直接点菜）
//    - 纯勾选：现有菜默认全部勾选且不可取消；菜库菜自由勾选；下单不要称呼/餐别
//    - 我最近点的：下单后把订单号存在本机浏览器，首页顶部显示这一单
//  所有需要登录的接口都会带上用户令牌。
// ============================================================

// 默认用户密码（仅用于自动登录，家人完全看不到、也不用输）
const DEFAULT_USER_PW = '1';

let userToken = '';                 // 登录后从后端拿到的令牌
let menuData = [];                  // 后端返回的“现有菜”（后台菜单里在售的菜）
let dishData = [];                  // 后端返回的“菜库”全部菜品（带主菜属性）
let lookup = {};                    // 把“菜品id → 菜品信息”合并成一张表，方便订单用
let menuIds = new Set();            // 记录哪些 id 属于“现有菜”（默认锁定勾选）
let selected = new Set();           // 已勾选的菜品 id 集合（含现有菜 + 菜库里额外勾的）
let curCat = '__all__';             // 当前选中的分类：'__all__' 表示“现有菜”，其他是主菜名

// 页面打开就自动登录并进入（家人不用做任何事）
window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  autoLogin().then(() => enterApp())
    .catch(() => {
      document.getElementById('dishList').innerHTML = '<p class="empty">加载失败，请确认服务已启动</p>';
    });
});

// 绑定各种按钮事件（不再有登录/退出按钮）
function bindEvents() {
  document.getElementById('randomOpenBtn').addEventListener('click', () => show('randomSheet'));
  document.getElementById('randomClose').addEventListener('click', () => hide('randomSheet'));
  document.getElementById('randomBtn').addEventListener('click', getRandom);

  document.getElementById('checkoutBtn').addEventListener('click', openCheckout);
  document.getElementById('sheetClose').addEventListener('click', () => hide('orderSheet'));
  document.getElementById('submitOrder').addEventListener('click', submitOrder);
}

// 显示/隐藏弹窗的小工具
function show(id) { document.getElementById(id).style.display = 'flex'; }
function hide(id) { document.getElementById(id).style.display = 'none'; }

// 自动登录：用默认密码拿一个“用户”令牌（不弹框、家人无感）
function autoLogin() {
  return fetch('/api/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_USER_PW })
  })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) throw new Error('自动登录失败');
      userToken = data.token;
      return data;
    });
}

// 统一封装带用户令牌的请求；遇到 401（令牌失效，多半是服务重启了）就自动重新登录再试一次
function apiFetch(url, options = {}) {
  options.headers = Object.assign({ 'Authorization': 'Bearer ' + userToken }, options.headers || {});
  return fetch(url, options).then(r => {
    if (r.status !== 401) return r;
    // 静默重新登录，然后重试刚才的请求
    return autoLogin().then(() => {
      options.headers = Object.assign({}, options.headers, { 'Authorization': 'Bearer ' + userToken });
      return fetch(url, options);
    });
  });
}

// 登录成功，进入点菜界面并加载数据
function enterApp() {
  document.getElementById('appView').style.display = 'block';
  loadData();
  showLastOrder(); // 进入时就看看本机有没有最近一单
}

// ---------------- 加载数据 ----------------
function loadData() {
  // 同时拉“现有菜”和“菜库”，两个都回来再渲染
  Promise.all([
    apiFetch('/api/menu').then(r => r.json()),
    apiFetch('/api/dishes').then(r => r.json())
  ]).then(([menuRes, dishRes]) => {
    menuData = menuRes.menu || [];
    dishData = dishRes.dishes || [];
    // 合并成 id→信息 的查找表
    lookup = {};
    menuIds = new Set();
    // 现有菜：默认全部勾选（锁定，不可取消）
    menuData.forEach(d => { lookup[d.id] = d; menuIds.add(d.id); selected.add(d.id); });
    dishData.forEach(d => lookup[d.id] = d);
    buildSidebar();
    selectCategory('__all__'); // 默认选中“现有菜”
  }).catch(() => {
    document.getElementById('dishList').innerHTML = '<p class="empty">加载失败，请确认服务已启动</p>';
  });
}

// 生成左侧分类边栏：顶部“现有菜” + 下面按主菜分组
function buildSidebar() {
  const box = document.getElementById('sidebar');
  // 从菜库里取出所有不重复的主菜，按出现顺序排
  const mains = [];
  dishData.forEach(d => { if (!mains.includes(d.主菜)) mains.push(d.主菜); });

  let html = `<div class="cat-item active" data-cat="__all__">现有菜</div>`;
  mains.forEach(c => {
    html += `<div class="cat-item" data-cat="${c}">${c}</div>`;
  });
  box.innerHTML = html;

  // 给每个分类项绑定点击：切换高亮 + 渲染对应菜品
  box.querySelectorAll('.cat-item').forEach(el => {
    el.addEventListener('click', () => selectCategory(el.dataset.cat));
  });
}

// 切换分类并渲染右侧菜品
function selectCategory(cat) {
  curCat = cat;
  // 边栏高亮
  document.querySelectorAll('.cat-item').forEach(el => {
    el.classList.toggle('active', el.dataset.cat === cat);
  });
  // 标题
  document.getElementById('catTitle').textContent = (cat === '__all__') ? '现有菜' : cat;

  // 决定要展示的菜品列表
  let list;
  if (cat === '__all__') {
    list = menuData; // “现有菜”来自后台菜单
  } else {
    list = dishData.filter(d => d.主菜 === cat); // 其余按主菜筛选
  }
  renderDishes(list);
}

// 渲染右侧菜品列表（纯勾选模式）
function renderDishes(list) {
  const box = document.getElementById('dishList');
  if (list.length === 0) {
    box.innerHTML = '<p class="empty">这个分类还没有菜</p>';
    return;
  }
  const isMenu = (curCat === '__all__');
  box.innerHTML = list.map(d => {
    if (isMenu) {
      // 现有菜：仅显示菜名，默认勾选且不可取消（复选框锁定）
      return `
        <div class="dish locked">
          <label class="dish-check">
            <input type="checkbox" checked disabled>
            <span class="dish-name">${d.name}</span>
          </label>
          <span class="lock-hint">默认</span>
        </div>`;
    } else {
      // 菜库菜：可自由勾选/取消
      const checked = selected.has(d.id) ? 'checked' : '';
      return `
        <div class="dish">
          <label class="dish-check">
            <input type="checkbox" ${checked} onchange="toggleSelect('${d.id}', this.checked)">
            <span class="dish-name">${d.name}</span>
          </label>
        </div>`;
    }
  }).join('');
}

// 勾选/取消某道菜库菜（现有菜是锁定的，不会调用这里）
function toggleSelect(id, checked) {
  if (checked) selected.add(id); else selected.delete(id);
  renderCartBar();
}

// 更新底部购物车栏的数字
function renderCartBar() {
  const n = selected.size;
  document.getElementById('cartCount').textContent = n;
  const btn = document.getElementById('checkoutBtn');
  btn.disabled = (n === 0);
  btn.style.opacity = (n === 0) ? .5 : 1;
}

// 打开“去下单”弹窗，先渲染已选清单（带快速删除 ✕）
function openCheckout() {
  renderSheetCart();
  document.getElementById('orderMsg').textContent = '';
  show('orderSheet');
}

// 渲染弹窗里的已选清单
function renderSheetCart() {
  const box = document.getElementById('sheetCart');
  const ids = [...selected];
  if (ids.length === 0) { box.innerHTML = '<p class="empty">还没选菜</p>'; return; }
  box.innerHTML = ids.map(id => {
    const d = lookup[id];
    if (!d) return '';
    const locked = menuIds.has(id);          // 现有菜是默认勾选的，不能删
    // 只有菜库里额外勾的菜才显示 ✕ 删除按钮
    const x = locked ? '' : `<button class="del-x" onclick="removeSelect('${id}')">✕</button>`;
    return `<div class="cart-line"><span>${d.name}</span>${x}</div>`;
  }).join('') + `<button class="clear-sel" onclick="clearSelection()">清空我的选择</button>`;
}

// 快速删除：从已选里移除某道菜库菜（同时更新右侧列表和底部数字）
function removeSelect(id) {
  selected.delete(id);
  renderCartBar();
  renderDishes(curCat === '__all__' ? menuData : dishData.filter(d => d.主菜 === curCat));
  renderSheetCart();
}

// 清空：只清掉菜库里额外勾的菜，保留默认勾选的现有菜
function clearSelection() {
  [...selected].forEach(id => { if (!menuIds.has(id)) selected.delete(id); });
  renderCartBar();
  renderDishes(curCat === '__all__' ? menuData : dishData.filter(d => d.主菜 === curCat));
  renderSheetCart();
}

// 随机搭配：输入数量，从菜库里随机抽
function getRandom() {
  const count = document.getElementById('randomCount').value || 3;
  apiFetch('/api/random?count=' + count)
    .then(r => r.json())
    .then(data => {
      const box = document.getElementById('randomResult');
      if (!data.dishes || data.dishes.length === 0) { box.innerHTML = '<p class="empty">菜库是空的</p>'; return; }
      box.innerHTML = '<ul class="random-list">' +
        data.dishes.map(d => `<li>🍲 ${d.name} <span class="tag">${d.主菜}</span></li>`).join('') +
        '</ul>';
    })
    .catch(() => { document.getElementById('randomResult').innerHTML = '<p class="empty">加载失败</p>'; });
}

// 提交订单（不需要称呼和餐别，纯勾选）
function submitOrder() {
  const wish = document.getElementById('orderWish').value.trim();
  // 把已勾选的菜整理成订单项（数量固定为 1）
  const items = [...selected].map(id => ({ id, qty: 1 }));
  const msg = document.getElementById('orderMsg');

  // 简单校验
  if (items.length === 0 && !wish) {
    msg.textContent = '请至少选一个菜，或写个许愿'; msg.style.color = '#e63946'; return;
  }

  // 发给后端（带上用户令牌）
  apiFetch('/api/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, wish })
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        msg.style.color = '#2a9d8f';
        msg.textContent = '✅ 下单成功！爸爸/妈妈马上就能看到～';
        // 记下这一单的 id（存在本机浏览器），首页顶部好显示“我最近点的”
        if (data.orderId) localStorage.setItem('lastOrderId', data.orderId);
        // 现有菜是默认常驻的，保留；只清空菜库里额外勾的菜
        [...selected].forEach(id => { if (!menuIds.has(id)) selected.delete(id); });
        document.getElementById('orderWish').value = '';
        renderDishes(curCat === '__all__' ? menuData : dishData.filter(d => d.主菜 === curCat));
        renderCartBar();
        showLastOrder(); // 立刻刷新“我最近点的”
        setTimeout(() => hide('orderSheet'), 900); // 稍后自动关掉弹窗
      } else {
        msg.style.color = '#e63946';
        msg.textContent = '❌ ' + (data.msg || '下单失败');
      }
    })
    .catch(() => { msg.style.color = '#e63946'; msg.textContent = '❌ 网络错误'; });
}

// ---------------- 我最近点的（本机最近一笔订单） ----------------
function showLastOrder() {
  const box = document.getElementById('lastOrderBox');
  const id = localStorage.getItem('lastOrderId');
  if (!id) { box.style.display = 'none'; return; }
  // 用订单 id 去后端把这一单完整拉回来
  apiFetch('/api/order/' + id)
    .then(r => r.json())
    .then(d => {
      if (!d.ok) { box.style.display = 'none'; return; }
      const o = d.order;
      const items = o.items.map(i => i.name + (i.qty > 1 ? (' × ' + i.qty) : '')).join('、') || '（只许了愿）';
      box.innerHTML = `
        <div class="lo-head">
          <span class="lo-title">📋 我最近点的</span>
          <span class="lo-time">${o.time}</span>
          <span class="lo-status ${o.done ? 'done' : ''}">${o.done ? '✅ 已完成' : '🍳 备餐中'}</span>
        </div>
        <div class="lo-items">${items}</div>
        ${o.wish ? `<div class="lo-wish">🌟 许愿：${o.wish}</div>` : ''}`;
      box.style.display = 'block';
    })
    .catch(() => { box.style.display = 'none'; });
}
