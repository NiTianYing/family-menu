// ============================================================
//  后台管理逻辑（admin.js）
//  负责：登录、编辑菜单、看订单、管理菜库、改密码
//  所有需要登录的接口，都会在请求头带上令牌（token）证明身份。
// ============================================================

// 令牌：登录成功后从后端拿到，存在浏览器本地，刷新页面不用重复登录
let token = localStorage.getItem('adminToken') || '';

// 页面打开就绑定各种按钮事件
window.addEventListener('DOMContentLoaded', () => {
  // 如果本地已有令牌，先验证是否还有效（服务器重启令牌会失效）
  if (token) {
    fetch('/api/admin/me', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.ok ? showAdmin() : logout())
      .catch(() => logout());
  }

  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // 标签切换
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('menuSave').addEventListener('click', saveMenu);
  document.getElementById('menuReset').addEventListener('click', resetMenuForm);
  // 菜库（原随机菜库）的新增/修改、清空表单
  document.getElementById('dishSave').addEventListener('click', saveDish);
  document.getElementById('dishReset').addEventListener('click', resetDishForm);
  // 菜库：Excel 导出 / 导入
  document.getElementById('dishExport').addEventListener('click', exportDishes);
  document.getElementById('dishImportBtn').addEventListener('click', () => document.getElementById('dishImportFile').click());
  document.getElementById('dishImportFile').addEventListener('change', importDishes);
  document.getElementById('pwdSave').addEventListener('click', changePwd);
});

// 登录
function doLogin() {
  const pwd = document.getElementById('loginPwd').value;
  const msg = document.getElementById('loginMsg');
  fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        token = data.token;
        localStorage.setItem('adminToken', token);
        showAdmin();
      } else {
        msg.textContent = data.msg || '登录失败';
        msg.style.color = '#e63946';
      }
    });
}

// 显示后台、隐藏登录框
function showAdmin() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('adminView').style.display = 'block';
  loadMenuAdmin();
  loadDishesAdmin();
  loadOrders();
}

// 退出登录
function logout() {
  token = '';
  localStorage.removeItem('adminToken');
  document.getElementById('loginView').style.display = 'flex';
  document.getElementById('adminView').style.display = 'none';
}

// 切换标签页
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['menu', 'dishes', 'orders', 'pwd'].forEach(t => {
    document.getElementById('panel-' + t).style.display = (t === tab) ? 'block' : 'none';
  });
  // 切到对应页时刷新数据
  if (tab === 'menu') loadMenuAdmin();
  if (tab === 'dishes') loadDishesAdmin();
  if (tab === 'orders') loadOrders();
}

// 生成带令牌的请求头（登录后才能调用的接口都要用）
function authHeader() {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// ---------- 菜单管理 ----------
function loadMenuAdmin() {
  fetch('/api/admin/menu', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(data => {
      const box = document.getElementById('menuTable');
      if (data.menu.length === 0) { box.innerHTML = '<p class="empty">还没有菜</p>'; return; }
      box.innerHTML = data.menu.map(m => `
        <div class="row">
          <div>
            <b>${m.name}</b> <span class="tag">${m.category}</span>
            ${m.available === false ? '<span class="off">已下架</span>' : ''}
            ${m.price ? ' ¥' + m.price : ''}
            ${m.desc ? ' · ' + m.desc : ''}
          </div>
          <div>
            <button onclick="editMenu('${m.id}')">编辑</button>
            <button class="danger" onclick="delMenu('${m.id}')">删除</button>
          </div>
        </div>`).join('');
    });
}

// 把某道菜填进表单，方便修改
function editMenu(id) {
  fetch('/api/admin/menu', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(data => {
      const m = data.menu.find(x => x.id === id);
      if (!m) return;
      document.getElementById('menuId').value = m.id;
      document.getElementById('menuName').value = m.name;
      document.getElementById('menuCat').value = m.category;
      document.getElementById('menuPrice').value = m.price || '';
      document.getElementById('menuDesc').value = m.desc || '';
      document.getElementById('menuAvail').checked = m.available !== false;
      window.scrollTo(0, 0);
    });
}

// 删除菜单
function delMenu(id) {
  if (!confirm('确定删除这道菜？')) return;
  fetch('/api/admin/menu/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(() => loadMenuAdmin());
}

// 保存菜单（有 id 是修改，没有是新增）
function saveMenu() {
  const id = document.getElementById('menuId').value;
  const body = {
    name: document.getElementById('menuName').value.trim(),
    category: document.getElementById('menuCat').value,
    price: parseFloat(document.getElementById('menuPrice').value) || 0,
    desc: document.getElementById('menuDesc').value.trim(),
    available: document.getElementById('menuAvail').checked
  };
  if (!body.name) { alert('请填菜名'); return; }
  if (id) body.id = id;
  fetch('/api/admin/menu', { method: 'POST', headers: authHeader(), body: JSON.stringify(body) })
    .then(r => r.json())
    .then(() => { resetMenuForm(); loadMenuAdmin(); });
}

// 清空菜单表单
function resetMenuForm() {
  document.getElementById('menuId').value = '';
  document.getElementById('menuName').value = '';
  document.getElementById('menuPrice').value = '';
  document.getElementById('menuDesc').value = '';
  document.getElementById('menuAvail').checked = true;
}

// ---------- 菜库管理（原随机菜库，新增“主菜”属性） ----------
function loadDishesAdmin() {
  fetch('/api/admin/dishes', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(data => {
      document.getElementById('dishTotal').textContent = data.dishes.length;
      const box = document.getElementById('dishTable');
      box.innerHTML = data.dishes.map(d => `
        <div class="row">
          <div>${d.name} <span class="tag main">${d.主菜 || '其他'}</span> <span class="tag">${d.category}</span></div>
          <div>
            <button onclick="editDish('${d.id}')">编辑</button>
            <button class="danger" onclick="delDish('${d.id}')">删除</button>
          </div>
        </div>`).join('');
    });
}

// 把某道菜填进表单，方便修改（包括主菜）
function editDish(id) {
  fetch('/api/admin/dishes', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(data => {
      const d = data.dishes.find(x => x.id === id);
      if (!d) return;
      document.getElementById('dishId').value = d.id;
      document.getElementById('dishName').value = d.name;
      document.getElementById('dishMain').value = d.主菜 || '';
      document.getElementById('dishCat').value = d.category;
      window.scrollTo(0, document.getElementById('dishName').offsetTop);
    });
}

// 保存菜库里的菜（有 id 是修改，没有是新增）
function saveDish() {
  const id = document.getElementById('dishId').value;
  const body = {
    name: document.getElementById('dishName').value.trim(),
    主菜: document.getElementById('dishMain').value.trim() || '其他',
    category: document.getElementById('dishCat').value
  };
  if (!body.name) { alert('请填菜名'); return; }
  const method = id ? 'PUT' : 'POST';
  const url = id ? ('/api/admin/dishes/' + id) : '/api/admin/dishes';
  if (id) body.id = id;
  fetch(url, { method, headers: authHeader(), body: JSON.stringify(body) })
    .then(r => r.json())
    .then(() => { resetDishForm(); loadDishesAdmin(); });
}

// 清空菜库表单
function resetDishForm() {
  document.getElementById('dishId').value = '';
  document.getElementById('dishName').value = '';
  document.getElementById('dishMain').value = '';
  document.getElementById('dishCat').value = '荤菜';
}

// 删除菜库里的菜
function delDish(id) {
  if (!confirm('确定删除？')) return;
  fetch('/api/admin/dishes/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(() => loadDishesAdmin());
}

// 导出菜库为 Excel：直接触发浏览器下载
function exportDishes() {
  const msg = document.getElementById('excelMsg');
  msg.style.color = '#2a9d8f';
  msg.textContent = '正在导出…';
  fetch('/api/admin/dishes/export', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => {
      if (!r.ok) throw new Error('导出失败');
      return r.blob(); // 把返回的文件内容变成 blob
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '菜库.xlsx'; // 下载文件名（浏览器里会显示）
      a.click();
      URL.revokeObjectURL(url);
      msg.textContent = '✅ 已下载 菜库.xlsx';
    })
    .catch(() => { msg.style.color = '#e63946'; msg.textContent = '❌ 导出失败'; });
}

// 导入 Excel：读取选中的文件，转成 base64 发给后端
function importDishes(e) {
  const file = e.target.files[0];
  const msg = document.getElementById('excelMsg');
  if (!file) return;
  const replace = document.getElementById('dishReplace').checked; // 是否整张替换
  msg.style.color = '#2a9d8f';
  msg.textContent = '正在导入…';
  const reader = new FileReader();
  reader.onload = () => {
    // reader.result 是 base64 字符串（形如 data:application/...;base64,xxxx）
    const base64 = reader.result.split(',')[1];
    fetch('/api/admin/dishes/import', {
      method: 'POST',
      headers: authHeader(),
      body: JSON.stringify({ file: base64, replace })
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          msg.style.color = '#2a9d8f';
          msg.textContent = `✅ 导入完成：新增 ${data.added} 道，更新 ${data.updated} 道，共 ${data.total} 道`;
          loadDishesAdmin(); // 刷新列表
        } else {
          msg.style.color = '#e63946';
          msg.textContent = '❌ ' + (data.msg || '导入失败');
        }
      })
      .catch(() => { msg.style.color = '#e63946'; msg.textContent = '❌ 导入失败'; });
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // 清空，保证同一文件能再次选择
}

// ---------- 订单查看 ----------
function loadOrders() {
  fetch('/api/admin/orders', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(data => {
      const box = document.getElementById('orderTable');
      if (data.orders.length === 0) { box.innerHTML = '<p class="empty">还没有订单</p>'; return; }
      box.innerHTML = data.orders.map(o => `
        <div class="order ${o.done ? 'done' : ''}">
          <div class="order-head">
            <span>${o.name ? '<b>' + o.name + '</b> · ' : ''}${o.meal ? o.meal + ' · ' : ''}${o.time}${!o.name && !o.meal ? '（未留名）' : ''}</span>
            <button onclick="toggleDone('${o.id}')">${o.done ? '↩ 取消' : '✅ 完成'}</button>
          </div>
          <div class="order-items">
            ${o.items.map(i => i.name + (i.qty > 1 ? ' × ' + i.qty : '')).join('、') || '（只许了愿）'}
          </div>
          ${o.wish ? `<div class="order-wish">🌟 许愿：${o.wish}</div>` : ''}
        </div>`).join('');
    });
}

// 标记订单完成 / 取消完成
function toggleDone(id) {
  fetch('/api/admin/order/' + id + '/done', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(() => loadOrders());
}

// ---------- 修改密码 ----------
function changePwd() {
  const oldP = document.getElementById('oldPwd').value;
  const newP = document.getElementById('newPwd').value;
  const msg = document.getElementById('pwdMsg');
  if (!oldP || !newP) { msg.textContent = '请填原密码和新密码'; msg.style.color = '#e63946'; return; }
  fetch('/api/admin/password', {
    method: 'POST', headers: authHeader(),
    body: JSON.stringify({ old: oldP, new: newP })
  })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        msg.style.color = '#2a9d8f';
        msg.textContent = '✅ 密码已修改，下次用新密码登录';
        document.getElementById('oldPwd').value = '';
        document.getElementById('newPwd').value = '';
      } else {
        msg.style.color = '#e63946';
        msg.textContent = '❌ ' + (data.msg || '修改失败');
      }
    });
}
