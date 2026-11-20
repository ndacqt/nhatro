/* Quản lý nhà trọ – giao diện (vanilla JS) */
'use strict';

const S = { settings: {}, rooms: [], images: [], bills: [], extras: [], expenses: [] };
const UI = { building: null, buildings: [], tab: 'dashboard', period: null, billRoom: null, salesRoom: null, roomFilter: 'all', salesFilter: null };
const STATUSES = ['Đang thuê', 'Sắp trống', 'Trống'];
const GROUPS = ['Nhà', 'Điện', 'Nước', 'Dịch vụ', 'Xe', 'Khác'];
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');

/* ---------------- utils ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? 0 : +v;
const money = v => Math.round(n0(v)).toLocaleString('vi-VN');
const moneyD = v => money(v) + 'đ';
const shortMoney = v => {
  v = n0(v);
  if (v >= 1e6) return (Math.round(v / 1e5) / 10).toLocaleString('vi-VN') + ' triệu';
  if (v >= 1e3) return Math.round(v / 1e3).toLocaleString('vi-VN') + 'k';
  return money(v) + 'đ';
};
const parseNum = s => {
  if (s === null || s === undefined) return null;
  s = String(s).trim();
  if (s === '') return null;
  const neg = s.startsWith('-');
  const d = s.replace(/[^\d]/g, '');
  return d === '' ? null : (neg ? -1 : 1) * Number(d);
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = s => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : s; };
const pY = p => Math.floor(p / 100), pM = p => p % 100;
const pLabel = p => `T${pM(p)}/${pY(p)}`;
const pAdd = (p, k) => { let y = pY(p), m = pM(p) + k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y * 100 + m; };
const pToInput = p => `${pY(p)}-${String(pM(p)).padStart(2, '0')}`;
const pFromInput = s => { const [y, m] = s.split('-'); return +y * 100 + +m; };
const pNow = () => { const d = new Date(); return d.getFullYear() * 100 + d.getMonth() + 1; };
const noAccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
const phoneNorm = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 9 && d[0] !== '0') d = '0' + d; if (d.startsWith('84') && d.length === 11) d = '0' + d.slice(2); return d; };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
async function api(method, url, body, raw, quiet) {
  const opt = { method, headers: UI.building ? { 'X-Building': UI.building } : {} };
  if (raw) { opt.body = raw.data; opt.headers['Content-Type'] = raw.type; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opt);
  if (r.status === 401) { showLogin('Phiên đăng nhập hết hạn – đăng nhập lại'); throw new Error('auth'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (!quiet) toast('Lỗi: ' + (j.error || r.status), 4000);
    const err = new Error(j.error || r.status); err.data = j; throw err;
  }
  return j;
}
function openModal(html, onMount) {
  $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
  onMount && onMount($('#modalBody'));
  const f = $('#modalBody input:not([type=hidden]),#modalBody select'); f && f.focus();
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
$('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal(); });

function formData(root) {
  const o = {};
  $$('[name]', root).forEach(el => {
    if (el.type === 'checkbox') o[el.name] = el.checked ? 1 : 0;
    else if (el.dataset.num !== undefined) o[el.name] = parseNum(el.value);
    else o[el.name] = el.value;
  });
  return o;
}
function field(label, name, value, opt = {}) {
  const cls = 'field' + (opt.wide ? ' wide' : '');
  const v = value ?? '';
  if (opt.options) {
    return `<div class="${cls}"><label>${label}</label><select name="${name}">${opt.options.map(o => {
      const [val, lab] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(val)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(lab)}</option>`;
    }).join('')}</select></div>`;
  }
  if (opt.area) return `<div class="${cls}"><label>${label}</label><textarea name="${name}" rows="${opt.rows || 4}" placeholder="${esc(opt.ph || '')}">${esc(v)}</textarea></div>`;
  const isNum = opt.num;
  const shown = isNum && v !== '' && v !== null ? money(v) : v;
  return `<div class="${cls}"><label>${label}</label><input name="${name}" ${isNum ? 'data-num inputmode="numeric"' : ''} type="${opt.type || 'text'}" value="${esc(shown)}" placeholder="${esc(opt.ph || '')}"></div>`;
}

/* ---------------- calculations ---------------- */
const billsOf = p => S.bills.filter(b => b.period === p);
const roomByCode = c => S.rooms.find(r => r.code === c);
const imagesOf = rid => S.images.filter(i => i.room_id === rid).sort((a, b) => a.sort - b.sort || a.id - b.id);
const imgUrl = im => `/img/${encodeURIComponent(UI.building)}/${encodeURIComponent(im.filename)}`;
const bq = () => 'b=' + encodeURIComponent(UI.building);
const extraSum = (p, code) => S.extras.filter(e => e.period === p && e.room_code === code).reduce((s, e) => s + n0(e.amount), 0);
function calc(b) {
  const hasIdx = b.old_idx !== null && b.new_idx !== null && b.old_idx !== undefined && b.new_idx !== undefined;
  const kwh = hasIdx ? n0(b.new_idx) - n0(b.old_idx) : n0(b.manual_kwh);
  const elec = kwh * n0(b.elec_price);
  const water = n0(b.people) * n0(b.water_price);
  const parking = n0(b.vehicles) * n0(b.parking_price);
  const extra = extraSum(b.period, b.room_code);
  const total = elec + water + n0(b.rent) + n0(b.service_fee) + parking + extra;
  return { kwh, elec, water, parking, extra, total, missing: !hasIdx && !n0(b.manual_kwh) };
}
const catOf = name => (S.settings.expense_categories || []).find(c => c.name === name);
const groupOf = name => (catOf(name) || {}).group || 'Khác';
function expAmount(e) {
  if (!e.estimated) return n0(e.amount);
  const bs = billsOf(e.period);
  if (e.auto === 'KWH') return Math.round(bs.reduce((s, b) => s + calc(b).kwh, 0) * n0(S.settings.elec_cost));
  if (e.auto === 'NGUOI') return Math.round(bs.reduce((s, b) => s + n0(b.people), 0) * n0(S.settings.water_cost));
  return n0(e.amount);
}
function report(p) {
  const bs = billsOf(p).map(b => ({ b, c: calc(b) }));
  const thu = { 'Nhà': 0, 'Điện': 0, 'Nước': 0, 'Dịch vụ': 0, 'Xe': 0, 'Thu thêm': 0 };
  let paid = 0, unpaid = 0, nPaid = 0, missing = 0;
  bs.forEach(({ b, c }) => {
    thu['Nhà'] += n0(b.rent); thu['Điện'] += c.elec; thu['Nước'] += c.water; thu['Dịch vụ'] += n0(b.service_fee);
    thu['Xe'] += c.parking; thu['Thu thêm'] += c.extra;
    if (b.paid) { paid += c.total; nPaid++; } else unpaid += c.total;
    if (c.missing) missing++;
  });
  const chi = Object.fromEntries(GROUPS.map(g => [g, 0]));
  let estimated = 0;
  S.expenses.filter(e => e.period === p).forEach(e => { chi[groupOf(e.category)] = (chi[groupOf(e.category)] || 0) + expAmount(e); if (e.estimated) estimated++; });
  const tThu = Object.values(thu).reduce((a, b) => a + b, 0), tChi = Object.values(chi).reduce((a, b) => a + b, 0);
  const kwh = bs.reduce((s, x) => s + x.c.kwh, 0);
  return { thu, chi, tThu, tChi, lai: tThu - tChi, paid, unpaid, nPaid, n: bs.length, missing, estimated, kwh };
}

/* ---------------- VietQR ---------------- */
function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function vietqrPayload(bin, acc, amount, info) {
  const mai = tlv('00', 'A000000727') + tlv('01', tlv('00', bin) + tlv('01', acc)) + tlv('02', 'QRIBFTTA');
  const amt = Math.max(0, Math.round(n0(amount)));
  let s = tlv('00', '01') + tlv('01', amt ? '12' : '11') + tlv('38', mai) + tlv('53', '704');
  if (amt) s += tlv('54', String(amt));
  s += tlv('58', 'VN');
  if (info) s += tlv('62', tlv('08', info.slice(0, 50)));
  s += '6304';
  return s + crc16(s);
}
function qrDataUrl(text, cell = 5) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  return q.createDataURL(cell, 2);
}
const bankReady = () => S.settings.bank_bin && S.settings.account_no;
const transferInfo = b => noAccent(`${S.settings.house_name || ''} ${b.room_code.replace(/\./g, '')} T${pM(b.period)} ${pY(b.period)}`).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function billQr(b) {
  if (!bankReady()) return '';
  return qrDataUrl(vietqrPayload(S.settings.bank_bin, String(S.settings.account_no).replace(/\s/g, ''), calc(b).total, transferInfo(b)));
}
function qrWebLink(b) {
  if (!bankReady()) return '';
  return `https://img.vietqr.io/image/${S.settings.bank_bin}-${String(S.settings.account_no).replace(/\s/g, '')}-compact2.png?amount=${Math.round(calc(b).total)}&addInfo=${encodeURIComponent(transferInfo(b))}&accountName=${encodeURIComponent(S.settings.account_name || '')}`;
}

/* ---------------- loading & navigation ---------------- */
async function loadBuildings() {
  UI.buildings = await api('GET', '/api/buildings');
  if (!UI.buildings.find(b => b.code === UI.building)) UI.building = UI.buildings[0]?.code || null;
  const tag = { admin: '', manager: ' · quản lý', viewer: ' · chỉ xem' };
  $('#building').innerHTML = UI.buildings.map(b => `<option value="${esc(b.code)}" ${b.code === UI.building ? 'selected' : ''}>${esc(b.name)}${b.name !== b.code ? ' (' + esc(b.code) + ')' : ''}${tag[b.role] || ''}</option>`).join('')
    + '<option value="__new">+ Thêm tòa nhà…</option>';
}
async function load() {
  Object.assign(S, await api('GET', '/api/all'));
  document.title = (S.settings.house_name || 'Nhà trọ') + ' – Quản lý';
}
const latestPeriod = () => Math.max(0, ...S.bills.map(b => b.period));
async function switchBuilding(code) {
  UI.building = code;
  try { localStorage.setItem('building', code); } catch (_) {}
  UI.billRoom = UI.salesRoom = null; UI.salesFilter = null; UI.others = null;
  await load();
  setPeriod(latestPeriod() || pNow());
}
$('#building').addEventListener('change', e => {
  if (e.target.value === '__new') { e.target.value = UI.building; return A.newBuilding(); }
  switchBuilding(e.target.value);
});
function newBuildingForm() {
  openModal(`<h2>Thêm tòa nhà</h2><p class="muted">Mỗi tòa có dữ liệu, cài đặt và ảnh riêng. Sau khi tạo có thể nhập dữ liệu từ file Excel ở tab Cài đặt.</p>
  <div class="form" id="nb" style="margin-top:12px">${field('Mã tòa (vd S03)', 'code', '')}${field('Tên hiển thị', 'name', '')}${field('Địa chỉ', 'address', '')}${field('SĐT liên hệ', 'phone', '')}</div>
  <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="doNewBuilding">Tạo</button></div>`);
}
function setPeriod(p) { UI.period = p; $('#period').value = pToInput(p); render(); }
$('#period').addEventListener('change', e => e.target.value && setPeriod(pFromInput(e.target.value)));
$('#prevP').onclick = () => setPeriod(pAdd(UI.period, -1));
$('#nextP').onclick = () => setPeriod(pAdd(UI.period, 1));
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (b) goTab(b.dataset.tab);
});
function goTab(t) {
  UI.tab = t;
  $$('#tabs button[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
  const sec = $(`#tabs button[data-tab="${t}"]`)?.classList.contains('sec');
  $('#tabs .more-btn').classList.toggle('active', !!sec);
  try { localStorage.setItem('tab', t); } catch (_) {}
  render();
}

function render() {
  const fn = { dashboard: vDashboard, monthly: vMonthly, bill: vBill, rooms: vRooms, sales: vSales, expenses: vExpenses, extras: vExtras, settings: vSettings }[UI.tab];
  fn();
  const b = curB();
  if (b.role && b.role !== 'admin') {
    const sc = b.scope || {};
    view.insertAdjacentHTML('afterbegin', `<div class="role-note">🔒 Bạn là <b>${esc(ME.meta.role_label[b.role] || b.role)}</b> của tòa ${esc(UI.building)}${b.caps.length ? '' : ' – chỉ xem, không sửa được'}.${sc.from_period ? ` Được chia sẻ ${esc(scopeLabel(sc))} (từ ${pLabel(sc.from_period)}).` : ''} Mục bị khóa là mục bạn không có quyền.</div>`);
  }
  window.scrollTo({ top: 0 });
}

/* delegated actions */
const A = {};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const f = A[el.dataset.act]; if (f) { e.preventDefault(); f(el, e); }
});
A.close = closeModal;
A.moreMenu = () => openModal(`<h2>Khác</h2><div class="grid" style="margin-top:12px;gap:8px">
  ${[['sales', 'Gửi Sales', 'Tin đăng, ảnh phòng trống cho sales'], ['expenses', 'Chi phí', 'Chi tiền nhà, điện, nước, sửa chữa'], ['extras', 'Thu thêm', 'Giặt sấy, phí trễ hạn, giảm trừ'], ['settings', 'Cài đặt', 'Ngân hàng, đơn giá, mẫu tin, thành viên'], ['__account', 'Tài khoản', `${ME.user.name} – đổi mật khẩu, đăng xuất`]]
    .map(([t, l, d]) => `<button class="btn" style="justify-content:flex-start;padding:12px;flex-direction:column;align-items:flex-start;gap:2px" data-act="moreGo" data-t="${t}"><b>${l}</b><span class="muted" style="font-size:12px">${esc(d)}</span></button>`).join('')}
  </div><div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
A.moreGo = el => { closeModal(); el.dataset.t === '__account' ? A.account() : goTab(el.dataset.t); };

/* ================= TÀI KHOẢN & PHÂN QUYỀN ================= */
const ME = { user: null, meta: null };
const curB = () => UI.buildings.find(b => b.code === UI.building) || { caps: [], role: 'viewer' };
const can = c => curB().caps.includes(c);
/* Bảng quy tắc duy nhất: phần tử nào cần quyền gì.
   "a|b" = cần 1 trong các quyền; "a b" = cần đủ các quyền. Không đủ quyền: ô nhập bị khóa, nút bị ẩn.
   (Server kiểm tra lại mọi thao tác – bảng này chỉ để giao diện gọn, không phải lớp bảo mật.) */
const CAP_RULES = [
  ['[data-act=createPeriod],[data-act=addBillRow],[data-act=delBill]', 'bills'],
  ['input[data-f=new_idx],input[data-f=manual_kwh],[data-act=meterPhoto],[data-act=meterSeq]', 'readings'],
  ['[data-act=idcardScan],[data-act=newContract],[data-act=delContract],#cf [name],#cSave', 'rooms'],
  ['#sf [name^=landlord],#sf [name=contract_place],#sf [name=remind_days],#sf [name^=auto_publish]', 'settings'],
  ['[data-act=syncTenants],[data-act=sendSetupQr],[data-act=rotateRoomQr]', 'rooms'],
  ['[data-act=leaseRemind],[data-act=leaseRenew],[data-act=leaseLeaving],[data-act=shareSalesRoom],[data-act=tenantQr],[data-act=tenantEnd]', 'rooms'],
  ['[data-act=publishBill],[data-act=confirmClaim]', 'payments'],
  ['input[data-f=paid],[data-act=togglePaid]', 'payments'],
  ['#bf [name=new_idx],#bf [name=manual_kwh],#bf [name=note]', 'readings'],
  ['#bf [name=paid_date]', 'payments'],
  ['#bf [name=old_idx],#bf [name=people],#bf [name=rent],#bf [name=service_fee],#bf [name=vehicles],#bf [name=elec_price],#bf [name=water_price],#bf [name=parking_price]', 'bills'],
  ['[data-act=saveBill]', 'bills|readings|payments'],
  ['[data-act=editRoom]:not([data-id]),#dz,[data-act=coverImg],[data-act=delImg]', 'rooms'],
  ['#rf2 [name=price],#rf2 [name=service_fee],#rf2 [name=deposit]', 'prices'],
  ['#rf2 [name]:not([name=price]):not([name=service_fee]):not([name=deposit])', 'rooms'],
  ['[data-act=saveRoom]', 'rooms|prices'],
  ['[data-act=delRoom]', 'settings'],
  ['[data-act=editExp]:not([data-id]),#ef [name],[data-act=saveExp],[data-act=delRow][data-t=expenses]', 'expenses'],
  ['[data-act=editExtra]:not([data-id]),#xf [name],[data-act=saveExtra],[data-act=delRow][data-t=extras]', 'extras'],
  ['#sf [name=bank_name],#sf [name=account_no],#sf [name=account_name]', 'bank'],
  ['#sf [name=elec_price],#sf [name=water_price],#sf [name=service_fee],#sf [name=parking_price],#sf [name=elec_cost],#sf [name=water_cost]', 'prices'],
  ['#sf [name=house_name],#sf [name=address],#sf [name=phone],#sf [name=due_day],#sf textarea,#sf [name^=sales],#catT input,#catT select,[data-act=addCat],[data-act=delCat]', 'settings'],
  ['[data-act=saveSettings]', 'settings|bank|prices'],
  ['a[href^="/api/backup"]', 'settings'],
  ['[data-act=importExcel]', 'readings payments bills prices rooms extras expenses bank settings members'],
  ['[data-act=addMember],.member-row select,.member-row input,[data-act=saveMember],[data-act=delMember]', 'members'],
  ['#mCreate,#mAdd,#shareAdd,[data-act=unshareSales]', 'members'],
  ['#listingSel', 'rooms'],
];
function allowed(rule) {
  return rule.includes('|') ? rule.split('|').some(can) : rule.split(' ').every(can);
}
function applyCaps(root) {
  if (!UI.building || !root.querySelectorAll) return;
  for (const [sel, rule] of CAP_RULES) {
    if (allowed(rule)) continue;
    const els = [...root.querySelectorAll(sel)]; if (root.matches && root.matches(sel)) els.push(root);
    els.forEach(el => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) { el.disabled = true; el.title = 'Bạn không có quyền sửa mục này'; }
      else el.style.display = 'none';
    });
  }
}
new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && applyCaps(n))))
  .observe(document.body, { childList: true, subtree: true });

/* mã QR phòng đang chờ (khách quét bill trước khi đăng nhập) */
const pendingClaim = () => { try { return sessionStorage.getItem('roomclaim'); } catch (_) { return null; } };
let CLAIM_INFO = null;
function showLogin(msg, mode = 'login') {
  closeModal();
  document.body.classList.add('locked');
  const reg = mode === 'register';
  const regKind = CLAIM_INFO ? 'tenant' : 'owner';
  view.innerHTML = `<div class="login card" style="text-align:left">
  <div style="text-align:center"><div class="logo" style="display:inline-grid;width:48px;height:48px;font-size:26px;border-radius:12px">⌂</div>
  <h2 style="margin-top:10px">${CLAIM_INFO ? 'Hóa đơn phòng ' + esc(CLAIM_INFO.room) : 'Quản lý nhà trọ'}</h2>
  ${CLAIM_INFO ? `<p class="muted" style="margin-top:4px">${esc(CLAIM_INFO.house)}${CLAIM_INFO.address ? ' – ' + esc(CLAIM_INFO.address) : ''}</p>` : ''}</div>
  <div class="seg" style="margin:14px 0"><button class="${reg ? '' : 'on'}" data-act="authMode" data-m="login">Đăng nhập</button><button class="${reg ? 'on' : ''}" data-act="authMode" data-m="register">Đăng ký</button></div>
  ${msg ? `<p class="${/sai|không|lỗi|đã có|tối thiểu|hết hạn/i.test(msg) ? 'pill danger' : 'muted'}" style="display:block;white-space:normal;padding:8px 10px;margin-bottom:10px">${esc(msg)}</p>` : ''}
  <form id="authF" class="grid" style="gap:10px">
    <div class="field"><label>Số điện thoại</label><input name="username" type="tel" inputmode="tel" autocomplete="tel" placeholder="vd: 0912345678" required${reg ? ' pattern="[0-9 .+]{9,15}"' : ''}></div>
    ${reg ? `<div class="field"><label>Bạn là</label><div class="seg" id="kindSeg">${[['tenant', '🧾 Khách thuê'], ['owner', '🏠 Chủ trọ'], ['sales', '🤝 Sales']]
        .map(([k, l]) => `<button type="button" class="${k === regKind ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
      <input type="hidden" name="kind" value="${regKind}"></div>
      <div class="field"><label>Họ tên</label><input name="name" autocomplete="name" placeholder="vd: Nguyễn Văn An"></div>` : ''}
    <div class="field"><label>Mật khẩu${reg ? ' (tối thiểu 6 ký tự)' : ''}</label><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required></div>
    ${reg ? '<div class="field"><label>Nhập lại mật khẩu</label><input name="password2" type="password" autocomplete="new-password" required></div>' : ''}
    <button class="btn primary" style="justify-content:center;padding:12px" type="submit">${reg ? 'Tạo tài khoản' : 'Đăng nhập'}</button>
  </form>
  <p class="muted" style="font-size:12px;margin-top:12px">${CLAIM_INFO ? 'Đăng nhập (nếu đã có tài khoản) hoặc Đăng ký bằng số điện thoại – sau đó bạn xem được lịch sử hóa đơn của phòng này.'
    : reg ? 'Số điện thoại là tên đăng nhập. <b>Khách thuê</b>: xem hóa đơn phòng mình – quét mã QR in trên bill hoặc chủ trọ gửi. <b>Chủ trọ</b>: quản lý tòa nhà. <b>Sales</b>: tìm phòng trống chủ trọ mở cho bạn.'
    : 'Chưa có tài khoản? Chọn Đăng ký. Khách thuê: quét mã QR trên bill để vào xem hóa đơn.'}</p></div>`;
  $('#authF [name=username]').focus();
  $$('#kindSeg button').forEach(btn => btn.onclick = () => {
    $$('#kindSeg button').forEach(x => x.classList.toggle('on', x === btn));
    $('#authF [name=kind]').value = btn.dataset.k;
  });
  $('#authF').onsubmit = async e => {
    e.preventDefault();
    const d = formData($('#authF'));
    if (reg && d.password !== d.password2) return showLogin('Mật khẩu nhập lại không khớp', 'register');
    if (reg && pendingClaim()) d.room_token = pendingClaim();  // cho phép kích hoạt tài khoản chủ đã tạo sẵn theo SĐT
    const r = await fetch(reg ? '/api/register' : '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return showLogin(j.error || 'Lỗi', mode);
    location.reload();
  };
}
A.authMode = el => showLogin('', el.dataset.m);
A.account = () => {
  const b = curB();
  openModal(`<h2>Tài khoản</h2>
  <div class="card" style="margin-top:12px"><b>${esc(ME.user.name)}</b> <span class="muted">@${esc(ME.user.username)}</span>
  <span class="pill muted">${{ owner: 'Chủ trọ', staff: 'Nhân viên', sales: 'Sales', tenant: 'Khách thuê' }[ME.user.kind] || ''}</span>
  ${UI.building ? `<div class="muted" style="margin-top:4px">Tòa ${esc(UI.building)}: <b>${esc(ME.meta.role_label[b.role] || b.role)}</b></div>` : ''}
  ${ME.user.kind === 'sales' ? '<div class="muted" style="margin-top:4px">Gửi SĐT của bạn cho chủ trọ để được thêm vào Danh bạ Sales và nhận phòng.</div>' : ''}
  ${ME.user.kind !== 'tenant' && ME.meta.my_rooms ? '<button class="btn sm" data-act="myBills" style="margin-top:8px">🧾 Hóa đơn phòng tôi thuê</button>' : ''}</div>
  <h3 class="section-title">Đổi mật khẩu</h3>
  <div class="form" id="pwf">${field('Mật khẩu hiện tại', 'old', '', { type: 'password' })}${field('Mật khẩu mới', 'new', '', { type: 'password' })}
  <div class="field" style="justify-content:flex-end"><button class="btn" data-act="changePw">Đổi mật khẩu</button></div></div>
  <div class="foot"><button class="btn danger" data-act="logout" style="margin-right:auto">Đăng xuất</button><button class="btn" data-act="phoneAccess">📱 Mở trên điện thoại</button><button class="btn" data-act="close">Đóng</button></div>`);
};
A.changePw = async () => { await api('POST', '/api/change-password', formData($('#pwf'))); toast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.', 4000); closeModal(); };
A.logout = async () => { await api('POST', '/api/logout'); location.reload(); };
A.phoneAccess = () => {
  const url = ME.meta.urls[0];
  openModal(`<h2>Mở app trên điện thoại</h2>
  ${ME.meta.lan && url ? `<div class="phone-qr" style="margin-top:14px"><img src="${qrDataUrl(url, 6)}" alt="QR">
    <div><p>Điện thoại bắt cùng <b>Wi-Fi</b> với máy tính này, mở Camera quét mã hoặc gõ địa chỉ:</p>
    <p style="font-size:18px"><b>${esc(url)}</b></p>
    <p class="muted" style="font-size:13px">Đăng nhập bằng tài khoản của bạn (nhớ 30 ngày). Menu trình duyệt → <i>Thêm vào màn hình chính</i> để mở như app.</p></div></div>`
    : `<div class="card" style="margin-top:14px;background:var(--warn-soft);border-color:var(--warn)">App đang chạy chế độ <b>chỉ máy tính này</b>. Tắt cửa sổ đen của app rồi chạy <b>run-dienthoai.bat</b> (trong thư mục app) để điện thoại vào được.</div>`}
  <div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
};

/* ---- thành viên của tòa (trong Cài đặt) ---- */
async function renderMembers() {
  const box = $('#membersBox'); if (!box) return;
  const list = await api('GET', '/api/members');
  const caps = ME.meta.caps, RL = ME.meta.role_label;
  box.innerHTML = `<div class="head"><div><h3>Thành viên & phân quyền – tòa ${esc(UI.building)}</h3><p>Tạo tài khoản cho quản lý / nhân viên ngay tại đây, hoặc thêm người đã có tài khoản. Chỉ người có quyền “Chia sẻ & phân quyền” mới sửa được. (Sales không thêm ở đây – chia sẻ phòng cho Sales ở tab Gửi Sales.)</p></div></div>
  <div class="card" style="background:var(--surface-2);margin-bottom:12px" id="mCreate"><b>Thêm thành viên theo số điện thoại</b>
  <div class="form" style="margin-top:8px">${field('Số điện thoại (tên đăng nhập)', 'username', '', { type: 'tel', ph: 'vd: 0912345678' })}${field('Họ tên', 'name', '')}${field('Mật khẩu ban đầu', 'password', '', { type: 'password', ph: 'bỏ trống nếu SĐT đã có tài khoản' })}${field('Vai trò', 'role', 'manager', { options: Object.entries(RL) })}
  <div class="field" style="justify-content:flex-end"><button class="btn primary" data-act="createMember">+ Thêm vào tòa</button></div></div>
  <p class="muted" style="font-size:12px;margin:6px 0 0">SĐT đã có tài khoản thì chỉ cần thêm vào tòa (không cần mật khẩu). SĐT mới: gửi SĐT + mật khẩu ban đầu cho người đó; họ tự đổi mật khẩu trong mục Tài khoản.</p></div>
  <div class="table-wrap"><table><thead><tr><th>Thành viên</th><th>Vai trò</th>${caps.map(([k, l]) => `<th title="${esc(l)}" style="white-space:normal;min-width:70px;font-size:11px">${esc(l.split(' (')[0])}</th>`).join('')}<th></th></tr></thead><tbody>
  ${list.map(m => `<tr class="member-row" data-uid="${m.user_id}"><td><b>${esc(m.name)}</b><br><span class="muted">@${esc(m.username)}${m.user_id === ME.user.id ? ' (bạn)' : ''}</span></td>
    <td><select class="cell-input" style="width:130px;text-align:left" data-k="role">${Object.entries(RL).map(([k, l]) => `<option value="${k}" ${k === m.role ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${m.custom ? '<br><span class="pill warn" style="margin-top:4px">tùy chỉnh</span>' : ''}</td>
    ${caps.map(([k]) => `<td style="text-align:center"><input type="checkbox" class="check" data-cap-k="${k}" ${m.caps.includes(k) ? 'checked' : ''} ${m.role === 'admin' ? 'disabled' : ''}></td>`).join('')}
    <td><div class="actions"><button class="btn sm" data-act="saveMember">Lưu</button><button class="btn sm danger" data-act="delMember">${m.user_id === ME.user.id ? 'Rời tòa' : 'Xóa'}</button></div></td></tr>`).join('')}
  </tbody></table></div>
  <p class="muted" style="font-size:12px;margin-top:8px">Mặc định – <b>Chủ trọ</b>: toàn quyền. <b>Quản lý</b>: nhập chỉ số, thu tiền, phòng/khách/ảnh, thu thêm, chi phí (không sửa giá, bill, STK, cài đặt). <b>Chỉ xem</b>: không sửa gì. Đổi vai trò sẽ đặt lại quyền theo mặc định; tích/bỏ tích từng ô rồi Lưu để tùy chỉnh.</p>`;
  $$('.member-row select[data-k=role]', box).forEach(sel => sel.onchange = () => {
    const def = ME.meta.roles[sel.value]; const tr = sel.closest('tr');
    $$('[data-cap-k]', tr).forEach(cb => { cb.checked = def.includes(cb.dataset.capK); cb.disabled = sel.value === 'admin' || !can('members'); });
  });
}
A.createMember = async () => {
  const d = formData($('#mCreate'));
  await api('POST', '/api/members/create', d);
  toast(`Đã thêm ${d.username} vào tòa ${UI.building}. Nếu là tài khoản mới: gửi SĐT + mật khẩu cho người đó.`, 5000); renderMembers();
};
A.addMember = async () => { const d = formData($('#mAdd')); await api('POST', '/api/members', d); toast('Đã thêm ' + d.username); renderMembers(); };
A.saveMember = async el => {
  const tr = el.closest('tr'), role = $('[data-k=role]', tr).value;
  const caps = $$('[data-cap-k]', tr).filter(c => c.checked).map(c => c.dataset.capK);
  await api('PUT', '/api/members/' + tr.dataset.uid, { role, caps }); toast('Đã lưu quyền'); await loadBuildings(); renderMembers();
};
A.delMember = async el => {
  const tr = el.closest('tr'), me = +tr.dataset.uid === ME.user.id;
  if (!confirm(me ? `Rời khỏi tòa ${UI.building}? Bạn sẽ không xem được tòa này nữa.` : 'Xóa thành viên này khỏi tòa?')) return;
  await api('DELETE', '/api/members/' + tr.dataset.uid);
  if (me) return location.reload();
  renderMembers();
};
A.newBuilding = newBuildingForm;
A.doNewBuilding = async () => {
  const d = formData($('#nb')); d.code = d.code.trim().toUpperCase();
  await api('POST', '/api/buildings', d); closeModal();
  UI.building = d.code; await loadBuildings(); await switchBuilding(d.code); goTab('settings');
  toast(`Đã tạo tòa ${d.code}. Điền cài đặt hoặc nhập từ Excel.`, 4000);
};
A.goTab = el => goTab(el.dataset.t);

/* ================= DASHBOARD ================= */
/* so sánh: % thay đổi; invert = tăng là xấu (chi phí, điện) */
function dlt(cur, prev, invert) {
  if (!prev) return cur ? '<span class="delta flat">mới</span>' : '';
  const pct = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(pct) < 0.5) return '<span class="delta flat">=</span>';
  const good = invert ? pct < 0 : pct > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%</span>`;
}
const vs = (cur, prev, invert) => prev ? `${dlt(cur, prev, invert)} so với ${pLabel(pAdd(UI.period, -1))}` : `<span class="muted">chưa có ${pLabel(pAdd(UI.period, -1))}</span>`;
/* chạy report() trên dữ liệu của tòa khác (tạm thay S) */
function withData(D, fn) { const saved = { ...S }; Object.assign(S, D); try { return fn(); } finally { Object.assign(S, saved); } }
async function renderBuildingCompare(p) {
  const box = $('#bldCompare'); if (!box) return;
  UI.others = UI.others || {};
  await Promise.all(UI.buildings.filter(b => b.code !== UI.building && !UI.others[b.code]).map(async b => {
    UI.others[b.code] = await (await fetch('/api/all?b=' + encodeURIComponent(b.code))).json();
  }));
  if (UI.period !== p || !$('#bldCompare')) return;
  const list = UI.buildings.map(b => ({ b, r: b.code === UI.building ? report(p) : withData(UI.others[b.code], () => report(p)), r0: b.code === UI.building ? report(pAdd(p, -1)) : withData(UI.others[b.code], () => report(pAdd(p, -1))) }));
  const sum = k => list.reduce((s, x) => s + x.r[k], 0);
  box.innerHTML = `<h3 style="margin-bottom:10px">So sánh các tòa nhà – ${pLabel(p)}</h3>
  <div class="table-wrap"><table><thead><tr><th>Tòa</th><th class="num">Phòng</th><th class="num">Tổng thu</th><th class="num">Chưa thu</th><th class="num">Tổng chi</th><th class="num">Lãi</th><th class="num">Biên</th></tr></thead><tbody>
  ${list.map(({ b, r, r0 }) => !r.n && !r.tChi ? `<tr><td><a href="#" data-act="switchB" data-b="${esc(b.code)}"><b>${esc(b.name)}</b></a></td><td colspan="6" class="muted">Chưa có dữ liệu ${pLabel(p)}</td></tr>` : `<tr style="${b.code === UI.building ? 'background:var(--accent-soft)' : ''}"><td><a href="#" data-act="switchB" data-b="${esc(b.code)}"><b>${esc(b.name)}</b></a></td><td class="num">${r.n}</td><td class="num">${money(r.tThu)}<br>${dlt(r.tThu, r0.tThu)}</td><td class="num" style="color:${r.unpaid ? 'var(--danger)' : 'inherit'}">${money(r.unpaid)}</td><td class="num">${money(r.tChi)}<br>${dlt(r.tChi, r0.tChi, true)}</td><td class="num"><b>${money(r.lai)}</b><br>${dlt(r.lai, r0.lai)}</td><td class="num">${r.tThu ? Math.round(r.lai / r.tThu * 100) : 0}%</td></tr>`).join('')}
  </tbody>${list.length > 1 ? `<tfoot><tr><td>Tất cả</td><td class="num">${sum('n')}</td><td class="num">${money(sum('tThu'))}</td><td class="num">${money(sum('unpaid'))}</td><td class="num">${money(sum('tChi'))}</td><td class="num">${money(sum('lai'))}</td><td class="num">${sum('tThu') ? Math.round(sum('lai') / sum('tThu') * 100) : 0}%</td></tr></tfoot>` : ''}</table></div>
  <p class="muted" style="margin:8px 0 0;font-size:12px">% dưới số liệu = so với ${pLabel(pAdd(p, -1))}. Bấm tên tòa để chuyển.</p>`;
}
A.switchB = async el => { $('#building').value = el.dataset.b; await switchBuilding(el.dataset.b); };

function vDashboard() {
  const p = UI.period, r = report(p), pp = pAdd(p, -1), pr = report(pp);
  setTimeout(() => renderBuildingCompare(p));
  const latest = latestPeriod();
  const vacant = S.rooms.filter(x => x.status !== 'Đang thuê');
  const months = Array.from({ length: 12 }, (_, i) => pAdd(p, i - 11));
  const reps = months.map(m => ({ m, ...report(m) }));
  const maxV = Math.max(1, ...reps.map(x => Math.max(x.tThu, x.tChi)));
  const warn = [];
  if (!r.n) warn.push(`<div class="card" style="border-color:var(--warn);background:var(--warn-soft)"><b>Chưa có dữ liệu kỳ ${pLabel(p)}.</b> ${p > latest ? 'Tạo kỳ mới để tự thêm dòng cho mọi phòng đang thuê, lấy chỉ số cũ, giá phòng và chi phí cố định.' : ''} <button class="btn primary sm" data-act="createPeriod" data-p="${p}">Tạo kỳ ${pLabel(p)}</button></div>`);
  if (r.missing) warn.push(`<div class="card" style="border-color:var(--warn)"><b>${r.missing} phòng chưa nhập chỉ số điện</b> kỳ này. <button class="btn sm" data-act="goTab" data-t="monthly">Nhập ngay</button></div>`);
  if (r.estimated) warn.push(`<div class="card"><b>${r.estimated} khoản chi còn tạm tính</b> (điện/nước). Có hóa đơn thật thì nhập ở tab Chi phí. <button class="btn sm" data-act="goTab" data-t="expenses">Mở</button></div>`);
  const due = leaseDue();
  if (due.length) warn.push(`<div class="card" style="border-color:var(--warn)"><div class="head" style="margin-bottom:4px"><h3>📅 ${due.length} hợp đồng sắp hết hạn (trong ${n0(S.settings.remind_days) || 30} ngày)</h3></div>${due.slice(0, 5).map(n => leaseItemHTML(n)).join('')}${due.length > 5 ? `<button class="btn sm" data-act="openBell" style="margin-top:6px">Xem tất cả ${due.length}</button>` : ''}</div>`);
  if (!bankReady()) warn.push(`<div class="card"><b>Chưa có thông tin ngân hàng</b> – bill sẽ không có mã QR. <button class="btn sm" data-act="goTab" data-t="settings">Cài đặt</button></div>`);
  const rowsThu = ['Nhà', 'Điện', 'Nước', 'Dịch vụ', 'Xe', 'Thu thêm', 'Khác'];
  view.innerHTML = `
  <div class="head"><div><h2>Tổng quan ${pLabel(p)}</h2><p>${r.n} phòng có bill • ${S.rooms.filter(x => x.status === 'Đang thuê').length} đang thuê • ${vacant.length} trống / sắp trống</p></div>
  <div class="actions"><a class="btn" href="/api/export.xlsx?${bq()}" title="Tổng hợp, thu tháng, chi phí, thu thêm, phòng, hợp đồng">⬇ Excel tòa này</a>${UI.buildings.length > 1 ? '<a class="btn" href="/api/export.xlsx?all=1">⬇ Excel tất cả tòa</a>' : ''}<button class="btn" data-act="createPeriod" data-p="${pAdd(Math.max(latest, pAdd(pNow(), -1)), 1)}">+ Tạo kỳ mới</button></div></div>
  <div class="grid" style="margin-bottom:14px">${warn.join('')}</div>
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Tổng thu</div><div class="value">${money(r.tThu)}</div><div class="sub">${vs(r.tThu, pr.tThu)}</div></div>
    <div class="card kpi"><div class="label">Đã thu</div><div class="value" style="color:var(--ok)">${money(r.paid)}</div><div class="sub">${r.nPaid}/${r.n} phòng</div></div>
    <div class="card kpi"><div class="label">Chưa thu</div><div class="value" style="color:${r.unpaid ? 'var(--danger)' : 'inherit'}">${money(r.unpaid)}</div><div class="sub">${r.n - r.nPaid} phòng</div></div>
    <div class="card kpi"><div class="label">Tổng chi</div><div class="value">${money(r.tChi)}</div><div class="sub">${vs(r.tChi, pr.tChi, true)}${r.estimated ? ' • ' + r.estimated + ' tạm tính' : ''}</div></div>
    <div class="card kpi"><div class="label">Lãi</div><div class="value" style="color:${r.lai >= 0 ? 'var(--accent)' : 'var(--danger)'}">${money(r.lai)}</div><div class="sub">${vs(r.lai, pr.lai)} • biên ${r.tThu ? Math.round(r.lai / r.tThu * 100) : 0}%</div></div>
    <div class="card kpi"><div class="label">Điện tiêu thụ</div><div class="value">${money(r.kwh)} <span style="font-size:13px;font-weight:400">kWh</span></div><div class="sub">${vs(r.kwh, pr.kwh, true)} • ${r.n} phòng ${pr.n !== r.n && pr.n ? `(${pLabel(pp)}: ${pr.n})` : ''}</div></div>
  </div>
  <div class="card" style="margin-top:14px"><div class="head"><h3>So sánh ${pLabel(p)} với ${pLabel(pp)}</h3>${pr.n || pr.tChi ? '' : `<span class="muted">Chưa có dữ liệu ${pLabel(pp)}</span>`}</div>
    <div class="table-wrap"><table><thead><tr><th>Khoản</th><th class="num">Thu ${pLabel(pp)}</th><th class="num">Thu ${pLabel(p)}</th><th class="num">±</th><th class="num">Chi ${pLabel(pp)}</th><th class="num">Chi ${pLabel(p)}</th><th class="num">±</th><th class="num">Còn lại ${pLabel(pp)}</th><th class="num">Còn lại ${pLabel(p)}</th></tr></thead><tbody>
    ${rowsThu.map(k => {
      const t = r.thu[k] || 0, c = r.chi[k] || 0, t0 = pr.thu[k] || 0, c0 = pr.chi[k] || 0;
      return (t || c || t0 || c0) ? `<tr><td>${k}</td><td class="num muted">${money(t0)}</td><td class="num">${money(t)}</td><td class="num">${dlt(t, t0)}</td><td class="num muted">${money(c0)}</td><td class="num">${money(c)}</td><td class="num">${dlt(c, c0, true)}</td><td class="num muted">${money(t0 - c0)}</td><td class="num" style="color:${t - c < 0 ? 'var(--danger)' : 'inherit'}"><b>${money(t - c)}</b></td></tr>` : '';
    }).join('')}
    </tbody><tfoot><tr><td>TỔNG</td><td class="num">${money(pr.tThu)}</td><td class="num">${money(r.tThu)}</td><td class="num">${dlt(r.tThu, pr.tThu)}</td><td class="num">${money(pr.tChi)}</td><td class="num">${money(r.tChi)}</td><td class="num">${dlt(r.tChi, pr.tChi, true)}</td><td class="num">${money(pr.lai)}</td><td class="num">${money(r.lai)}</td></tr></tfoot></table></div>
    <p class="muted" style="margin:10px 0 0;font-size:12px">Giá vốn điện thực tế: ${r.kwh ? money(r.chi['Điện'] / r.kwh) : 0} đ/kWh${pr.kwh ? ` (${pLabel(pp)}: ${money(pr.chi['Điện'] / pr.kwh)})` : ''} • Thu khách: ${money(S.settings.elec_price)} đ/kWh</p>
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="card" id="bldCompare"><h3>So sánh các tòa nhà – ${pLabel(p)}</h3><p class="muted">Đang tải…</p></div>
    <div class="card"><div class="head" style="margin-bottom:0"><h3>12 tháng gần nhất</h3><div class="legend"><span><i style="background:var(--accent)"></i>Thu</span><span><i style="background:var(--warn)"></i>Chi</span></div></div>
      <div class="bars">${reps.map(x => `<div class="bar-col" title="${pLabel(x.m)}: thu ${money(x.tThu)} • chi ${money(x.tChi)} • lãi ${money(x.lai)}"><div class="bar-stack"><div class="bar in" style="height:${x.tThu / maxV * 150}px"></div><div class="bar out" style="height:${x.tChi / maxV * 150}px"></div></div><span>${pM(x.m)}/${String(pY(x.m)).slice(2)}</span></div>`).join('')}</div>
    </div>
  </div>
  <h3 class="section-title">Xu hướng 12 tháng</h3>
  <div class="table-wrap"><table><thead><tr><th>Kỳ</th><th class="num">Tiền phòng</th><th class="num">Điện</th><th class="num">Nước</th><th class="num">Dịch vụ</th><th class="num">Xe</th><th class="num">Thu thêm</th><th class="num">TỔNG THU</th><th class="num">Đã thu</th><th class="num">Chưa thu</th><th class="num">TỔNG CHI</th><th class="num">LÃI</th><th class="num">Biên</th></tr></thead><tbody>
  ${reps.filter(x => x.tThu || x.tChi).reverse().map(x => `<tr><td><a href="#" data-act="pickPeriod" data-p="${x.m}">${pLabel(x.m)}</a></td><td class="num">${money(x.thu['Nhà'])}</td><td class="num">${money(x.thu['Điện'])}</td><td class="num">${money(x.thu['Nước'])}</td><td class="num">${money(x.thu['Dịch vụ'])}</td><td class="num">${money(x.thu['Xe'])}</td><td class="num">${money(x.thu['Thu thêm'])}</td><td class="num"><b>${money(x.tThu)}</b></td><td class="num">${money(x.paid)}</td><td class="num">${money(x.unpaid)}</td><td class="num">${money(x.tChi)}</td><td class="num"><b>${money(x.lai)}</b></td><td class="num">${x.tThu ? Math.round(x.lai / x.tThu * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="13" class="empty">Chưa có dữ liệu</td></tr>'}
  </tbody></table></div>`;
}
A.pickPeriod = el => setPeriod(+el.dataset.p);
A.createPeriod = el => {
  const p = +el.dataset.p || UI.period;
  openModal(`<h2>Tạo kỳ thu mới</h2>
  <p class="muted">Tự thêm dòng cho mọi phòng <b>Đang thuê / Sắp trống</b> (lấy chỉ số cũ từ kỳ trước, giá phòng, số người, số xe, phí DV từ danh sách Phòng) và thêm chi phí cố định + điện/nước tạm tính. Phòng đã có trong kỳ sẽ bỏ qua.</p>
  <div class="form">${`<div class="field"><label>Kỳ</label><input type="month" id="newP" value="${pToInput(p)}"></div>`}</div>
  <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="doCreatePeriod">Tạo kỳ</button></div>`);
};
A.doCreatePeriod = async () => {
  const p = pFromInput($('#newP').value);
  const r = await api('POST', '/api/create-period/' + p);
  closeModal(); await load();
  toast(`Kỳ ${pLabel(p)}: thêm ${r.bills} phòng, ${r.expenses} khoản chi`);
  UI.tab = 'monthly'; goTab('monthly'); setPeriod(p);
};

/* ================= THU THÁNG ================= */
function vMonthly() {
  const p = UI.period;
  const bs = billsOf(p).sort((a, b) => (roomByCode(a.room_code)?.sort ?? 999) - (roomByCode(b.room_code)?.sort ?? 999) || a.room_code.localeCompare(b.room_code));
  if (!bs.length) {
    view.innerHTML = `<div class="head"><div><h2>Thu tháng ${pLabel(p)}</h2></div></div>
    <div class="card empty"><p>Chưa có dòng thu nào cho kỳ ${pLabel(p)}.</p><button class="btn primary" data-act="createPeriod" data-p="${p}">Tạo kỳ ${pLabel(p)}</button></div>`;
    return;
  }
  view.innerHTML = `<div class="head"><div><h2>Thu tháng ${pLabel(p)}</h2><p>Nhập cột vàng <b>CHỈ SỐ MỚI</b> (Enter để xuống phòng tiếp).<span class="hm"> Phòng không có đồng hồ riêng thì nhập <b>kWh tay</b>.</span><span class="m-only"> Bấm mã phòng để sửa chi tiết.</span></p></div>
  <div class="actions"><button class="btn primary" data-act="meterSeq">📷 Chụp điện lần lượt</button><button class="btn" data-act="createPeriod" data-p="${p}">Bổ sung phòng mới thuê</button><button class="btn" data-act="addBillRow">+ Thêm dòng</button><button class="btn" data-act="goTab" data-t="bill">Xem / gửi bill ›</button></div></div>
  <div class="table-wrap"><table id="mtable"><thead><tr>
    <th>Phòng</th><th class="hm">Khách</th><th class="num hm">Cũ</th><th class="num">CHỈ SỐ MỚI</th><th class="num hm">kWh tay</th><th class="num">kWh</th><th class="num hm">kWh ${pLabel(pAdd(p, -1))}</th><th class="num hm">Tiền điện</th>
    <th class="num hm">Người</th><th class="num hm">Tiền nước</th><th class="num hm">Tiền phòng</th><th class="num hm">Phí DV</th><th class="num hm">Xe</th><th class="num hm">Thu thêm</th><th class="num">TỔNG</th><th>Thu</th><th class="hm"></th></tr></thead>
  <tbody>${bs.map(b => mRow(b)).join('')}</tbody><tfoot><tr id="mfoot"></tr></tfoot></table></div>`;
  mFoot();
  const tb = $('#mtable');
  tb.addEventListener('change', async e => {
    const inp = e.target; const tr = inp.closest('tr[data-id]'); if (!tr) return;
    const b = S.bills.find(x => x.id === +tr.dataset.id);
    let patch;
    if (inp.dataset.f === 'paid') patch = { paid: inp.checked ? 1 : 0, paid_date: inp.checked ? today() : '' };
    else patch = { [inp.dataset.f]: parseNum(inp.value) };
    Object.assign(b, patch); mUpdateRow(tr, b); mFoot();
    await api('PUT', '/api/bills/' + b.id, patch);
  });
  tb.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.dataset.f) return;
    e.preventDefault();
    const list = $$(`input[data-f="${e.target.dataset.f}"]`, tb); const i = list.indexOf(e.target);
    e.target.blur(); (list[i + 1] || list[i]).focus(); list[i + 1] && list[i + 1].select();
  });
}
function mRow(b) {
  const c = calc(b), r = roomByCode(b.room_code);
  const bad = b.old_idx !== null && b.new_idx !== null && n0(b.new_idx) < n0(b.old_idx);
  return `<tr data-id="${b.id}">
    <td><a href="#" data-act="editBill" data-id="${b.id}" title="Sửa chi tiết"><b>${esc(b.room_code)}</b></a><div class="m-only muted" style="font-size:11px">cũ ${b.old_idx ?? '—'}</div></td><td class="muted hm">${esc(r?.tenant || '')}</td>
    <td class="num hm">${b.old_idx ?? ''}</td>
    <td class="num" style="white-space:nowrap"><input class="cell-input" data-f="new_idx" value="${b.new_idx ?? ''}" inputmode="numeric" enterkeyhint="next" style="${bad ? 'outline:2px solid var(--danger)' : ''}"><button class="meter-btn" data-act="meterPhoto" data-id="${b.id}" title="Chụp đồng hồ – AI đọc số">📷</button>${b.meter_photo ? `<button class="meter-btn" data-act="viewMeterPhoto" data-f="${esc(b.meter_photo)}" title="Xem ảnh đồng hồ đã chụp">🖼</button>` : ''}</td>
    <td class="num hm"><input class="cell-input" data-f="manual_kwh" value="${b.manual_kwh ?? ''}" inputmode="numeric" style="width:70px"></td>
    <td class="num" data-c="kwh">${c.missing ? '<span class="pill warn">chưa</span>' : money(c.kwh)}</td>
    <td class="num hm" data-c="prev">${prevKwhCell(b, c)}</td>
    <td class="num hm" data-c="elec">${money(c.elec)}</td>
    <td class="num hm">${b.people}</td><td class="num hm">${money(c.water)}</td><td class="num hm">${money(b.rent)}</td><td class="num hm">${money(b.service_fee)}</td>
    <td class="num hm">${b.vehicles}${c.parking ? ' · ' + money(c.parking) : ''}</td><td class="num hm">${c.extra ? money(c.extra) : ''}</td>
    <td class="num" data-c="total"><b>${money(c.total)}</b></td>
    <td><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="check" data-f="paid" ${b.paid ? 'checked' : ''}><span class="muted hm" data-c="pdate" style="font-size:12px">${fmtDate(b.paid_date)}</span>${b.tenant_paid_at && !b.paid ? '<span class="pill warn" title="Khách bấm “Tôi đã chuyển khoản” trong app – kiểm tra rồi tích">báo đã CK</span>' : ''}${b.published_at ? '<span title="Đã gửi bill qua app">📱</span>' : ''}</label></td>
    <td class="hm"><div class="actions"><button class="btn sm" data-act="editBill" data-id="${b.id}">Sửa</button><button class="btn sm" data-act="openBill" data-code="${esc(b.room_code)}">Bill</button></div></td></tr>`;
}
function prevKwhCell(b, c) {
  const pb = S.bills.find(x => x.period === pAdd(b.period, -1) && x.room_code === b.room_code);
  if (!pb) return '<span class="muted">—</span>';
  const k0 = calc(pb).kwh;
  // điện tăng/giảm > 40% so với tháng trước -> tô cảnh báo để kiểm tra lại số đọc
  const odd = !c.missing && k0 && Math.abs(c.kwh - k0) / k0 > 0.4;
  return `<span class="muted">${money(k0)}</span>${c.missing ? '' : dlt(c.kwh, k0, true)}${odd ? ' <span class="pill warn" title="Chênh lệch lớn so với tháng trước – kiểm tra số đọc">!</span>' : ''}`;
}
function mUpdateRow(tr, b) {
  const c = calc(b);
  $('[data-c=prev]', tr).innerHTML = prevKwhCell(b, c);
  $('[data-c=kwh]', tr).innerHTML = c.missing ? '<span class="pill warn">chưa</span>' : money(c.kwh);
  $('[data-c=elec]', tr).textContent = money(c.elec);
  $('[data-c=total]', tr).innerHTML = `<b>${money(c.total)}</b>`;
  $('[data-c=pdate]', tr).textContent = fmtDate(b.paid_date);
  const ni = $('input[data-f=new_idx]', tr);
  ni.style.outline = (b.old_idx !== null && b.new_idx !== null && n0(b.new_idx) < n0(b.old_idx)) ? '2px solid var(--danger)' : '';
}
function mFoot() {
  const bs = billsOf(UI.period); const t = k => bs.reduce((s, b) => s + calc(b)[k], 0);
  const paid = bs.filter(b => b.paid).length;
  const prevK = billsOf(pAdd(UI.period, -1)).reduce((s, b) => s + calc(b).kwh, 0);
  const H = 'class="num hm"';
  $('#mfoot').innerHTML = `<td>Tổng</td><td class="hm">${bs.length} phòng</td><td class="hm"></td><td></td><td class="hm"></td><td class="num">${money(t('kwh'))}</td><td ${H}>${prevK ? money(prevK) + dlt(t('kwh'), prevK, true) : ''}</td><td ${H}>${money(t('elec'))}</td><td ${H}>${bs.reduce((s, b) => s + n0(b.people), 0)}</td><td ${H}>${money(t('water'))}</td><td ${H}>${money(bs.reduce((s, b) => s + n0(b.rent), 0))}</td><td ${H}>${money(bs.reduce((s, b) => s + n0(b.service_fee), 0))}</td><td ${H}>${money(t('parking'))}</td><td ${H}>${money(t('extra'))}</td><td class="num">${money(t('total'))}</td><td>${paid}/${bs.length}</td><td class="hm"></td>`;
}
A.openBill = el => { UI.billRoom = el.dataset.code; goTab('bill'); };
A.editBill = el => {
  const b = S.bills.find(x => x.id === +el.dataset.id);
  openModal(`<h2>Sửa dòng thu ${esc(b.room_code)} – ${pLabel(b.period)}</h2>
  <div class="form" id="bf" style="margin-top:14px">
    ${field('Chỉ số cũ', 'old_idx', b.old_idx, { num: 1 })}${field('Chỉ số mới', 'new_idx', b.new_idx, { num: 1 })}${field('kWh nhập tay (không có đồng hồ)', 'manual_kwh', b.manual_kwh, { num: 1 })}
    ${field('Số người', 'people', b.people, { num: 1 })}${field('Tiền phòng', 'rent', b.rent, { num: 1 })}${field('Phí dịch vụ', 'service_fee', b.service_fee, { num: 1 })}
    ${field('Số xe', 'vehicles', b.vehicles, { num: 1 })}${field('Đơn giá điện (đ/kWh)', 'elec_price', b.elec_price, { num: 1 })}${field('Đơn giá nước (đ/người)', 'water_price', b.water_price, { num: 1 })}
    ${field('Giá giữ xe (đ/xe)', 'parking_price', b.parking_price, { num: 1 })}${field('Ngày thu', 'paid_date', b.paid_date, { type: 'date' })}
    ${field('Ghi chú', 'note', b.note, { wide: 1 })}
  </div>
  <div class="foot"><button class="btn danger" data-act="delBill" data-id="${b.id}" style="margin-right:auto">Xóa dòng</button><button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="saveBill" data-id="${b.id}">Lưu</button></div>`);
};
A.saveBill = async el => {
  const d = formData($('#bf')); ['people', 'vehicles', 'rent', 'service_fee', 'elec_price', 'water_price', 'parking_price'].forEach(k => d[k] = d[k] ?? 0);
  if (d.paid_date) d.paid = 1;
  const r = await api('PUT', '/api/bills/' + el.dataset.id, d);
  Object.assign(S.bills.find(x => x.id === r.id), r); closeModal(); render();
};
A.delBill = async el => {
  if (!confirm('Xóa dòng thu này?')) return;
  await api('DELETE', '/api/bills/' + el.dataset.id); S.bills = S.bills.filter(x => x.id !== +el.dataset.id); closeModal(); render();
};
A.addBillRow = () => {
  const have = new Set(billsOf(UI.period).map(b => b.room_code));
  const opts = S.rooms.filter(r => !have.has(r.code)).map(r => [r.code, `${r.code} – ${r.status}${r.tenant ? ' – ' + r.tenant : ''}`]);
  if (!opts.length) return toast('Tất cả phòng đã có trong kỳ này');
  openModal(`<h2>Thêm dòng thu ${pLabel(UI.period)}</h2><div class="form" id="af" style="margin-top:14px">${field('Phòng', 'room_code', opts[0][0], { options: opts })}</div>
  <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="doAddBill">Thêm</button></div>`);
};
A.doAddBill = async () => {
  const code = $('#af [name=room_code]').value, r = roomByCode(code), s = S.settings;
  const prev = S.bills.filter(b => b.room_code === code && b.period < UI.period).sort((a, b) => b.period - a.period)[0];
  const row = await api('POST', '/api/bills', {
    period: UI.period, room_code: code, old_idx: prev ? (prev.new_idx ?? prev.old_idx) : null, people: r.people, rent: r.price,
    service_fee: r.service_fee, vehicles: r.vehicles, elec_price: s.elec_price, water_price: s.water_price, parking_price: s.parking_price
  });
  S.bills.push(row); closeModal(); render();
};

/* ================= BILL ================= */
function billHTML(b) {
  const s = S.settings, c = calc(b), r = roomByCode(b.room_code) || {};
  const due = new Date(pY(b.period), pM(b.period), n0(s.due_day) || 5);
  const qr = billQr(b);
  const ex = S.extras.filter(e => e.period === b.period && e.room_code === b.room_code);
  const hasIdx = b.old_idx !== null && b.new_idx !== null;
  return `<div class="bill-paper">
    <div class="bh"><div class="n">${esc(s.house_name)}</div><div class="a">${esc(s.address)}${s.phone ? ' • ĐT: ' + esc(s.phone) : ''}</div>
    <div class="tt">PHIẾU THANH TOÁN TIỀN PHÒNG</div><div>Kỳ: Tháng ${pM(b.period)}/${pY(b.period)}</div></div>
    <div class="meta"><div>Phòng: <b>${esc(b.room_code)}</b></div><div>Khách thuê: <b>${esc(r.tenant || '')}</b></div><div>Ngày lập: ${fmtDate(today())}</div><div>Hạn thanh toán: <b>${fmtDate(`${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`)}</b></div></div>
    <table><thead><tr><th>Khoản</th><th class="num hm">Cũ</th><th class="num hm">Mới</th><th class="num">SL</th><th class="num">Đơn giá</th><th class="num">Thành tiền</th></tr></thead><tbody>
      <tr><td>Tiền phòng</td><td class="hm"></td><td class="hm"></td><td class="num">1</td><td class="num">${money(b.rent)}</td><td class="num">${money(b.rent)}</td></tr>
      <tr><td>Tiền điện (kWh)${hasIdx ? `<div class="m-only" style="font-size:11px;color:#555">${b.old_idx} → ${b.new_idx}</div>` : ''}</td><td class="num hm">${hasIdx ? b.old_idx : ''}</td><td class="num hm">${hasIdx ? b.new_idx : ''}</td><td class="num">${money(c.kwh)}</td><td class="num">${money(b.elec_price)}</td><td class="num">${money(c.elec)}</td></tr>
      <tr><td>Tiền nước (người)</td><td class="hm"></td><td class="hm"></td><td class="num">${b.people}</td><td class="num">${money(b.water_price)}</td><td class="num">${money(c.water)}</td></tr>
      <tr><td>Phí dịch vụ</td><td class="hm"></td><td class="hm"></td><td class="num">1</td><td class="num">${money(b.service_fee)}</td><td class="num">${money(b.service_fee)}</td></tr>
      ${n0(b.vehicles) && n0(b.parking_price) ? `<tr><td>Gửi xe (chiếc)</td><td class="hm"></td><td class="hm"></td><td class="num">${b.vehicles}</td><td class="num">${money(b.parking_price)}</td><td class="num">${money(c.parking)}</td></tr>` : ''}
      ${ex.map(e => `<tr><td>${esc(e.type || 'Thu thêm')}${e.content ? ' – ' + esc(e.content) : ''}</td><td class="hm"></td><td class="hm"></td><td></td><td></td><td class="num">${money(e.amount)}</td></tr>`).join('')}
    </tbody></table>
    <div class="total"><span>TỔNG CẦN THANH TOÁN</span><span>${moneyD(c.total)}</span></div>
    ${b.paid ? `<div style="text-align:center;margin:6px 0 10px"><span class="paid-stamp">ĐÃ THANH TOÁN ${fmtDate(b.paid_date)}</span></div>` : ''}
    <div class="pay"><div>
      ${bankReady() ? `<div><b>QUÉT MÃ ĐỂ THANH TOÁN</b></div><div>Ngân hàng: <b>${esc(s.bank_name)}</b></div><div>Số tài khoản: <b>${esc(s.account_no)}</b></div><div>Chủ tài khoản: <b>${esc(s.account_name)}</b></div><div>Nội dung CK: <b>${esc(transferInfo(b))}</b></div>` : '<div class="muted">(Nhập ngân hàng & số TK ở Cài đặt để có mã QR)</div>'}
    </div>${qr ? `<img src="${qr}" alt="QR">` : ''}</div>
    <div class="note">Quét mã QR bằng app ngân hàng – số tiền và nội dung đã điền sẵn. Cảm ơn quý khách!</div>
    ${r.access_token ? `<div class="bill-app"><img src="${qrDataUrl(roomQrUrl(r.access_token), 3)}" alt="QR app">
      <div><b>📱 Xem lịch sử hóa đơn phòng ${esc(b.room_code)} trên app</b><br>Quét mã này bằng camera điện thoại, đăng nhập / đăng ký bằng số điện thoại của bạn.</div></div>` : ''}
  </div>`;
}
function vBill() {
  const p = UI.period, bs = billsOf(p).sort((a, b) => a.room_code.localeCompare(b.room_code));
  if (!bs.length) { view.innerHTML = `<div class="head"><h2>Bill ${pLabel(p)}</h2></div><div class="card empty">Chưa có dữ liệu kỳ này. <button class="btn primary" data-act="createPeriod" data-p="${p}">Tạo kỳ</button></div>`; return; }
  if (!bs.find(b => b.room_code === UI.billRoom)) UI.billRoom = bs[0].room_code;
  const b = bs.find(x => x.room_code === UI.billRoom), r = roomByCode(b.room_code) || {};
  const phone = phoneNorm(r.phone);
  view.innerHTML = `<div class="head no-print"><div><h2>Bill ${pLabel(p)}</h2><p>Chọn phòng • gạch xanh = đã thu</p></div></div>
  <div class="m-only no-print"><div class="field" style="margin-bottom:12px"><select id="billPick">${bs.map(x => `<option value="${esc(x.room_code)}" ${x.room_code === UI.billRoom ? 'selected' : ''}>${esc(x.room_code)} – ${moneyD(calc(x).total)}${x.paid ? ' ✓ đã thu' : ''}</option>`).join('')}</select></div></div>
  <div class="room-chips no-print hm" style="margin-bottom:14px">${bs.map(x => `<button data-act="pickBill" data-code="${esc(x.room_code)}" class="${x.room_code === UI.billRoom ? 'active' : ''} ${x.paid ? 'paid' : ''}">${esc(x.room_code)}</button>`).join('')}</div>
  <div class="bill-layout"><div id="billBox">${billHTML(b)}</div>
  <div class="card bill-side grid" style="gap:10px">
    <h3>Phòng ${esc(b.room_code)}</h3>
    <div class="muted">${esc(r.tenant || '')}${phone ? ' • ' + phone : ' • <span class="pill warn">chưa có SĐT</span>'}</div>
    <button class="btn primary" data-act="zaloOne" data-code="${esc(b.room_code)}">Gửi Zalo (copy ảnh + mở chat)</button>
    <button class="btn" data-act="copyBillImg">Copy ảnh bill</button>
    <button class="btn" data-act="dlBillImg">Tải ảnh PNG</button>
    <button class="btn" data-act="printBill">In / Lưu PDF</button>
    <button class="btn" data-act="copyBillText" data-code="${esc(b.room_code)}">Copy tin nhắn chữ</button>
    ${bankReady() ? `<button class="btn" data-act="copyQrLink" data-code="${esc(b.room_code)}">Copy link QR</button>` : ''}
    <button class="btn" data-act="togglePaid" data-id="${b.id}">${b.paid ? 'Bỏ tích đã thu' : '✓ Đánh dấu đã thu'}</button>
    ${b.meter_photo ? `<button class="btn" data-act="viewMeterPhoto" data-f="${esc(b.meter_photo)}">🖼 Ảnh đồng hồ điện</button>` : ''}
    ${b.tenant_paid_at && !b.paid ? `<p class="pill warn" style="display:block;white-space:normal">Khách báo đã chuyển khoản lúc ${esc(b.tenant_paid_at)} – kiểm tra tài khoản rồi bấm ✓ Đánh dấu đã thu</p>` : ''}
    ${linkOf(b.room_code) ? `<button class="btn" data-act="publishBill" data-ids="${b.id}">📤 ${b.published_at ? 'Gửi lại bill qua app' : 'Gửi bill qua app cho khách'}</button>
      <div class="muted" style="font-size:12px;margin-top:-4px">${b.published_at ? `✓ Đã gửi lúc ${esc(b.published_at)}` : 'Khách chưa thấy bill này'} • app @${esc(linkOf(b.room_code).username)}</div>`
      : `<div class="muted" style="font-size:12px">Khách chưa có tài khoản app – tạo ở form Phòng → “Tài khoản app của khách”.</div>`}
    <hr style="border:0;border-top:1px solid var(--line);width:100%">
    <h3>Cả kỳ</h3>
    ${(() => { const ids = bs.filter(x => linkOf(x.room_code) && !x.published_at).map(x => x.id), n = bs.filter(x => linkOf(x.room_code)).length;
      return n ? `<button class="btn primary" data-act="publishBill" data-ids="${ids.join(',')}" ${ids.length ? '' : 'disabled'}>📤 Gửi bill qua app cho ${ids.length} phòng chưa gửi</button>
      <div class="muted" style="font-size:12px;margin-top:-4px">${n}/${bs.length} phòng có tài khoản app${ids.length ? '' : ' – đã gửi hết'}</div>` : ''; })()}
    <button class="btn" data-act="zaloAll">Gửi Zalo lần lượt từng phòng</button>
    <button class="btn" data-act="dlAllBills">Tải ảnh bill tất cả phòng</button>
  </div></div>`;
  const bp = $('#billPick'); if (bp) bp.onchange = () => { UI.billRoom = bp.value; vBill(); };
}
A.pickBill = el => { UI.billRoom = el.dataset.code; vBill(); };
async function billCanvas(b) {
  let el;
  if (b && b.room_code !== UI.billRoom || !$('#billBox .bill-paper')) {
    el = document.createElement('div'); el.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px';
    el.innerHTML = billHTML(b); document.body.appendChild(el);
  }
  const paper = el ? $('.bill-paper', el) : $('#billBox .bill-paper');
  await Promise.all($$('img', paper).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
  const prevW = paper.style.width; paper.style.width = '640px';
  const cv = await html2canvas(paper, { scale: 2, backgroundColor: '#ffffff', logging: false });
  paper.style.width = prevW;
  el && el.remove();
  return cv;
}
const canvasBlob = cv => new Promise(r => cv.toBlob(r, 'image/png'));
const billFileName = b => `${b.room_code} T${pM(b.period)}-${pY(b.period)}.png`;
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
async function copyImage(blob) {
  if (!navigator.clipboard || !window.ClipboardItem || !window.isSecureContext) return false;
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); return true; } catch (e) { return false; }
}
const curBill = () => billsOf(UI.period).find(b => b.room_code === UI.billRoom);
A.dlBillImg = async () => { const b = curBill(); downloadBlob(await canvasBlob(await billCanvas(b)), billFileName(b)); };
A.copyBillImg = async () => {
  const b = curBill(), blob = await canvasBlob(await billCanvas(b));
  if (await copyImage(blob)) toast('Đã copy ảnh bill – dán (Ctrl+V) vào Zalo'); else { downloadBlob(blob, billFileName(b)); toast('Trình duyệt không cho copy ảnh – đã tải file PNG'); }
};
A.printBill = () => window.print();
function billText(b) {
  const s = S.settings, c = calc(b);
  const L = [`${s.house_name} – PHIẾU THANH TOÁN`, `Phòng ${b.room_code} – Tháng ${pM(b.period)}/${pY(b.period)}`, '',
    `Tiền phòng: ${moneyD(b.rent)}`,
    `Điện: ${b.old_idx ?? ''}${b.new_idx !== null ? ' → ' + b.new_idx : ''} = ${money(c.kwh)} kWh × ${money(b.elec_price)} = ${moneyD(c.elec)}`,
    `Nước: ${b.people} người × ${money(b.water_price)} = ${moneyD(c.water)}`,
    `Phí dịch vụ: ${moneyD(b.service_fee)}`];
  if (c.parking) L.push(`Gửi xe: ${b.vehicles} × ${money(b.parking_price)} = ${moneyD(c.parking)}`);
  S.extras.filter(e => e.period === b.period && e.room_code === b.room_code).forEach(e => L.push(`${e.type || 'Thu thêm'}${e.content ? ' (' + e.content + ')' : ''}: ${moneyD(e.amount)}`));
  L.push('', `TỔNG CẦN THANH TOÁN: ${moneyD(c.total)}`);
  if (bankReady()) L.push('', `CK: ${s.bank_name} – ${s.account_no} – ${s.account_name}`, `Nội dung: ${transferInfo(b)}`, `QR: ${qrWebLink(b)}`);
  return L.join('\n');
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
A.copyBillText = async el => { await copyText(billText(billsOf(UI.period).find(b => b.room_code === el.dataset.code))); toast('Đã copy tin nhắn'); };
A.copyQrLink = async el => { await copyText(qrWebLink(billsOf(UI.period).find(b => b.room_code === el.dataset.code))); toast('Đã copy link QR'); };
A.togglePaid = async el => {
  const b = S.bills.find(x => x.id === +el.dataset.id); const patch = { paid: b.paid ? 0 : 1, paid_date: b.paid ? '' : today() };
  await api('PUT', '/api/bills/' + b.id, patch); Object.assign(b, patch); vBill();
};
async function zaloSend(b) {
  const r = roomByCode(b.room_code) || {}, phone = phoneNorm(r.phone);
  const blob = await canvasBlob(await billCanvas(b));
  const copied = await copyImage(blob);
  if (!copied) downloadBlob(blob, billFileName(b));
  if (phone) window.open('https://zalo.me/' + phone, '_blank');
  toast(copied ? `Đã copy ảnh bill ${b.room_code} – trong Zalo bấm Ctrl+V rồi Enter` : `Đã tải ảnh bill ${b.room_code} – kéo ảnh vào Zalo`, 5000);
  return phone;
}
A.zaloOne = async el => { const b = billsOf(UI.period).find(x => x.room_code === el.dataset.code); if (!await zaloSend(b)) toast('Phòng chưa có SĐT – nhập ở tab Phòng'); };
A.zaloAll = () => {
  const bs = billsOf(UI.period).sort((a, b) => a.room_code.localeCompare(b.room_code));
  let i = 0;
  const step = () => {
    const b = bs[i], r = roomByCode(b.room_code) || {}, ph = phoneNorm(r.phone);
    $('#modalBody').innerHTML = `<h2>Gửi Zalo lần lượt – ${pLabel(UI.period)}</h2><p class="muted">Phòng ${i + 1}/${bs.length}. Bấm nút xanh → Zalo mở ra → Ctrl+V → Enter → quay lại bấm “Phòng tiếp”.</p>
    <div class="card" style="margin:12px 0"><h3>${esc(b.room_code)} – ${esc(r.tenant || '')}</h3><div>${ph || '<span class="pill warn">Chưa có SĐT</span>'} • Tổng: <b>${moneyD(calc(b).total)}</b> ${b.paid ? '<span class="pill ok">đã thu</span>' : ''}</div></div>
    <div class="foot"><button class="btn" data-act="close">Đóng</button><button class="btn" id="zPrev" ${i ? '' : 'disabled'}>‹ Trước</button>
    <button class="btn primary" id="zGo" ${ph ? '' : 'disabled'}>Copy ảnh & mở Zalo</button><button class="btn" id="zNext">${i < bs.length - 1 ? 'Phòng tiếp ›' : 'Xong'}</button></div>`;
    $('#zGo').onclick = () => zaloSend(b);
    $('#zPrev').onclick = () => { i--; step(); };
    $('#zNext').onclick = () => { if (i < bs.length - 1) { i++; step(); } else closeModal(); };
  };
  openModal(''); step();
};
A.dlAllBills = async () => {
  const bs = billsOf(UI.period);
  toast(`Đang tạo ${bs.length} ảnh… (trình duyệt có thể hỏi cho phép tải nhiều file)`, 4000);
  for (const b of bs) { downloadBlob(await canvasBlob(await billCanvas(b)), billFileName(b)); await new Promise(r => setTimeout(r, 350)); }
};

/* ================= PHÒNG ================= */
function statusPill(s) { return `<span class="pill ${s === 'Đang thuê' ? 'ok' : s === 'Trống' ? 'danger' : 'warn'}">${esc(s)}</span>`; }
function vRooms() {
  const list = S.rooms.filter(r => UI.roomFilter === 'all' || r.status === UI.roomFilter);
  const cnt = s => S.rooms.filter(r => r.status === s).length;
  view.innerHTML = `<div class="head"><div><h2>Phòng</h2><p>${S.rooms.length} phòng • giá, khách thuê, thông tin & ảnh cho sales</p></div>
  <div class="actions"><select id="rf" class="btn"><option value="all">Tất cả (${S.rooms.length})</option>${STATUSES.map(s => `<option ${UI.roomFilter === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
  <button class="btn" data-act="toggleRoomTable">Dạng bảng</button><button class="btn" data-act="syncTenants" title="Tạo / gắn tài khoản app theo SĐT khách">📱 Tài khoản app cho mọi khách</button><button class="btn primary" data-act="editRoom">+ Thêm phòng</button></div></div>
  <div class="grid kpis" style="margin-bottom:14px">${STATUSES.map(s => `<div class="card kpi"><div class="label">${s}</div><div class="value">${cnt(s)}</div></div>`).join('')}
    <div class="card kpi"><div class="label">Tổng tiền phòng / tháng</div><div class="value">${shortMoney(S.rooms.filter(r => r.status !== 'Trống').reduce((s, r) => s + n0(r.price), 0))}</div></div></div>
  ${UI.roomTable ? roomTable(list) : `<div class="room-grid">${list.map(roomCard).join('') || '<div class="card empty">Chưa có phòng</div>'}</div>`}`;
  $('#rf').onchange = e => { UI.roomFilter = e.target.value; vRooms(); };
}
function roomCard(r) {
  const imgs = imagesOf(r.id);
  return `<div class="card room-card"><div class="cover" data-act="editRoom" data-id="${r.id}" style="cursor:pointer">${imgs[0] ? `<img src="${imgUrl(imgs[0])}" loading="lazy" alt="">` : '<span>Chưa có ảnh – bấm để thêm</span>'}${imgs.length ? `<span class="count">${imgs.length} ảnh</span>` : ''}</div>
  <div class="body"><div class="row"><h3>${esc(r.code)}</h3>${statusPill(r.status)}</div>
  <div class="price">${moneyD(r.price)}<span class="muted" style="font-weight:400;font-size:13px">/tháng</span></div>
  <div class="muted">${r.tenant ? esc(r.tenant) : 'Chưa có khách'}${r.phone ? ' • ' + esc(r.phone) : ''}</div>
  <div class="muted" style="font-size:12px">${r.people} người • ${r.vehicles} xe • DV ${money(r.service_fee)}${r.area ? ' • ' + r.area + 'm²' : ''}</div>
  ${r.move_out && r.status !== 'Trống' ? `<div style="font-size:12px">Hết hạn ${fmtDate(r.move_out)} • ${daysLabel(daysBetween(r.move_out))} ${LEASE_STAGE[r.lease_status] || ''}</div>` : ''}</div>
  <div class="foot"><button class="btn sm" data-act="editRoom" data-id="${r.id}">Sửa / ảnh</button><button class="btn sm" data-act="salesRoom" data-id="${r.id}">Gửi sales</button></div></div>`;
}
function roomTable(list) {
  return `<div class="table-wrap"><table><thead><tr><th>Phòng</th><th>Trạng thái</th><th>Khách thuê</th><th>SĐT</th><th>Ngày vào</th><th class="num">Giá phòng</th><th class="num">Người</th><th class="num">Xe</th><th class="num">Phí DV</th><th class="num">Cọc</th><th>Ảnh</th><th>Ghi chú</th><th></th></tr></thead><tbody>
  ${list.map(r => `<tr><td><b>${esc(r.code)}</b></td><td>${statusPill(r.status)}</td><td>${esc(r.tenant)}</td><td>${esc(r.phone)}</td><td>${fmtDate(r.move_in)}</td><td class="num">${money(r.price)}</td><td class="num">${r.people}</td><td class="num">${r.vehicles}</td><td class="num">${money(r.service_fee)}</td><td class="num">${money(r.deposit)}</td><td>${imagesOf(r.id).length}</td><td class="muted">${esc(r.note)}</td><td><button class="btn sm" data-act="editRoom" data-id="${r.id}">Sửa</button></td></tr>`).join('')}
  </tbody></table></div>`;
}
A.toggleRoomTable = () => { UI.roomTable = !UI.roomTable; vRooms(); };
A.salesRoom = el => { UI.salesRoom = +el.dataset.id; UI.salesFilter = 'all'; goTab('sales'); };
A.editRoom = el => {
  const id = +el.dataset.id || 0;
  const s = S.settings;
  const r = S.rooms.find(x => x.id === id) || { code: '', status: 'Trống', price: 0, people: 0, vehicles: 0, service_fee: s.service_fee, deposit: 0, sort: S.rooms.length };
  openModal(`<h2>${id ? 'Phòng ' + esc(r.code) : 'Thêm phòng'}</h2>
  <div id="rf2">
  <h3 class="section-title">Thông tin thuê</h3>
  <div class="form">
    ${field('Mã phòng', 'code', r.code, { ph: 'P.101' })}${field('Trạng thái', 'status', r.status, { options: STATUSES })}${field('Tên khách thuê', 'tenant', r.tenant)}
    ${field('SĐT (để gửi Zalo)', 'phone', r.phone, { type: 'tel' })}${field('Ngày vào', 'move_in', r.move_in, { type: 'date' })}${field('Ngày ra / hết hạn hợp đồng', 'move_out', r.move_out, { type: 'date' })}${field('Giá phòng', 'price', r.price, { num: 1 })}
    ${field('Số người', 'people', r.people, { num: 1 })}${field('Số xe', 'vehicles', r.vehicles, { num: 1 })}${field('Phí dịch vụ', 'service_fee', r.service_fee, { num: 1 })}
    ${field('Tiền cọc', 'deposit', r.deposit, { num: 1 })}${field('Thứ tự hiển thị', 'sort', r.sort, { num: 1 })}${field('Ghi chú', 'note', r.note)}
  </div>
  <div class="head" style="margin:22px 0 10px"><h3>Khách thuê – theo căn cước (CCCD)</h3>
    <button class="btn primary sm" data-act="idcardScan">📷 Chụp CCCD – AI tự điền</button></div>
  <div id="idcardBox"></div>
  <div class="form">
    ${field('Ngày sinh', 'tenant_dob', r.tenant_dob, { ph: 'dd/mm/yyyy' })}${field('Giới tính', 'tenant_gender', r.tenant_gender, { ph: 'Nam / Nữ' })}${field('Số CCCD', 'tenant_id_no', r.tenant_id_no, { ph: '12 số' })}
    ${field('Ngày cấp', 'tenant_id_date', r.tenant_id_date, { ph: 'dd/mm/yyyy' })}${field('Nơi cấp', 'tenant_id_place', r.tenant_id_place)}${field('Quê quán', 'tenant_hometown', r.tenant_hometown)}
    ${field('Nơi thường trú', 'tenant_address', r.tenant_address, { wide: 1 })}
    ${field('Số seri đồng hồ điện (AI tự ghi khi chụp điện lần đầu)', 'meter_serial', r.meter_serial)}
  </div>
  <h3 class="section-title">Thông tin cho sales</h3>
  <div class="form">
    ${field('Diện tích (m²)', 'area', r.area || '', { ph: '25' })}${field('Tầng', 'floor', r.floor, { ph: '2' })}${field('Tối đa (người)', 'max_people', r.max_people || '', { num: 1 })}
    ${field('Trống từ ngày', 'available_from', r.available_from, { type: 'date' })}${field('Hiển thị cho tài khoản Sales', 'listing', r.listing || '', { options: LISTING })}
    ${field('Tiện ích phòng (mỗi dòng 1 ý)', 'amenities', r.amenities, { area: 1, wide: 1, ph: 'Máy lạnh\nTủ lạnh\nGiường, nệm\nWC riêng\nBan công' })}
    ${field('Mô tả thêm', 'description', r.description, { area: 1, wide: 1, rows: 3, ph: 'Phòng mới sơn, cửa sổ thoáng…' })}
  </div></div>
  ${id ? `<h3 class="section-title">Tài khoản app của khách</h3>${tenantAccountHTML(r)}` : ''}
  ${id ? `<div class="head" style="margin:22px 0 10px"><h3>Hợp đồng thuê</h3><button class="btn sm" data-act="newContract" data-id="${id}">📄 Tạo hợp đồng</button></div>
  ${contractListHTML(r.code)}` : ''}
  ${id ? `<h3 class="section-title">Hình ảnh (${imagesOf(id).length}) – ảnh viền xanh là ảnh bìa</h3>
  <div class="dropzone" id="dz">Kéo thả ảnh vào đây hoặc <b>bấm để chọn</b> (nhiều ảnh cùng lúc, tự nén)<input type="file" id="fileIn" accept="image/*" multiple hidden></div>
  <div class="gallery" id="gal" style="margin-top:12px">${galleryHTML(id)}</div>` : '<p class="muted">Lưu phòng xong mới thêm được ảnh.</p>'}
  <div class="foot">${id ? `<button class="btn danger" data-act="delRoom" data-id="${id}" style="margin-right:auto">Xóa phòng</button>` : ''}<button class="btn" data-act="close">Đóng</button><button class="btn primary" data-act="saveRoom" data-id="${id}">Lưu</button></div>`,
  body => {
    if (!id) return;
    const dz = $('#dz', body), fi = $('#fileIn', body);
    dz.onclick = () => fi.click();
    fi.onchange = () => uploadFiles(id, fi.files);
    dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
    dz.ondragleave = () => dz.classList.remove('drag');
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); uploadFiles(id, e.dataTransfer.files); };
  });
};
function galleryHTML(rid) {
  return imagesOf(rid).map((im, i) => `<div class="thumb ${i === 0 ? 'is-cover' : ''}"><img src="${imgUrl(im)}" data-act="viewImg" data-src="${imgUrl(im)}" loading="lazy" alt="">
  <div class="tools">${i ? `<button data-act="coverImg" data-id="${im.id}" data-room="${rid}">Đặt bìa</button>` : '<span></span>'}<button data-act="delImg" data-id="${im.id}" data-room="${rid}">Xóa</button></div></div>`).join('');
}
async function resizeImage(file, max = 1920, q = 0.86) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return await new Promise(r => cv.toBlob(r, 'image/jpeg', q));
  } finally { URL.revokeObjectURL(url); }
}
async function uploadFiles(rid, files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  let done = 0;
  for (const f of list) {
    toast(`Đang tải ảnh ${++done}/${list.length}…`, 20000);
    let blob = f, type = f.type;
    try { if (f.type !== 'image/gif') { blob = await resizeImage(f); type = 'image/jpeg'; } } catch (e) { /* giữ file gốc */ }
    const im = await api('POST', `/api/rooms/${rid}/images`, undefined, { data: blob, type });
    S.images.push(im);
    const g = $('#gal'); if (g) g.innerHTML = galleryHTML(rid);
  }
  toast(`Đã thêm ${list.length} ảnh`);
}
A.coverImg = async el => {
  const rid = +el.dataset.room, imgs = imagesOf(rid), im = S.images.find(x => x.id === +el.dataset.id);
  im.sort = (imgs[0]?.sort ?? 0) - 1;
  await api('PUT', '/api/images/' + im.id, { sort: im.sort }); $('#gal').innerHTML = galleryHTML(rid);
};
A.delImg = async el => {
  if (!confirm('Xóa ảnh này?')) return;
  await api('DELETE', '/api/images/' + el.dataset.id); S.images = S.images.filter(x => x.id !== +el.dataset.id); $('#gal').innerHTML = galleryHTML(+el.dataset.room);
};
A.viewImg = el => window.open(el.dataset.src, '_blank');
A.saveRoom = async el => {
  const id = +el.dataset.id, d = formData($('#rf2'));
  if (!d.code.trim()) return toast('Nhập mã phòng');
  d.code = d.code.trim(); d.area = parseFloat(String(d.area).replace(',', '.')) || 0;
  ['price', 'people', 'vehicles', 'service_fee', 'deposit', 'sort', 'max_people'].forEach(k => d[k] = d[k] ?? 0);
  const r = id ? await api('PUT', '/api/rooms/' + id, d) : await api('POST', '/api/rooms', d);
  await load(); render();
  const t = r._tenant;
  if (t && t.created && t.setup_token) return showTenantQr(roomById(r.id), t, true);  // vừa tự tạo tài khoản khách -> gửi QR luôn
  toast(`Đã lưu ${r.code}` + (!t ? '' : t.error ? ` – ⚠ ${t.error}` : t.ended ? ' – đã ngắt tài khoản app của khách cũ'
    : t.new_link ? ` – SĐT ${t.username} đã có tài khoản, đã gắn vào phòng (khách đăng nhập như cũ)` : ''), t && (t.error || t.new_link) ? 6000 : 2600);
  if (!id) A.editRoom({ dataset: { id: r.id } }); else closeModal();
};
A.syncTenants = async () => {
  if (!confirm(`Tạo tài khoản app cho mọi khách đang thuê ở ${UI.building} theo SĐT của phòng?\nSĐT đã có tài khoản thì chỉ gắn vào phòng.`)) return;
  const res = await api('POST', '/api/tenant-accounts/sync');
  S.tenant_links = (await api('GET', '/api/all')).tenant_links;
  const fresh = res.filter(x => x.created), linked = res.filter(x => x.new_link && !x.created), bad = res.filter(x => x.error || x.skipped);
  const ok = res.filter(x => x.username && !x.created && !x.new_link);
  openModal(`<h2>📱 Tài khoản app của khách – ${esc(UI.building)}</h2>
    <p style="margin-top:10px">✓ Tạo mới <b>${fresh.length}</b> • gắn tài khoản có sẵn <b>${linked.length}</b> • đã có từ trước <b>${ok.length}</b>${bad.length ? ` • chưa tạo được <b>${bad.length}</b>` : ''}</p>
    ${fresh.length ? `<h3 class="section-title">Gửi mã QR kích hoạt cho khách mới</h3><div class="grid" style="gap:6px">${fresh.map(x => `<div class="room-item"><span style="flex:1"><b>${esc(x.room_code)}</b> ${esc(x.tenant || '')} <span class="muted">${esc(x.username)}</span></span>
      <button class="btn sm primary" data-act="sendSetupQr" data-id="${x.room_id}" data-tok="${esc(x.setup_token)}" data-u="${esc(x.username)}">Gửi mã QR</button></div>`).join('')}</div>` : ''}
    ${bad.length ? `<h3 class="section-title">Chưa tạo được</h3>${bad.map(x => `<div class="muted">• ${esc(x.room_code)}: ${esc(x.error || x.skipped)}</div>`).join('')}` : ''}
    <div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
};
A.sendSetupQr = el => showTenantQr(roomById(el.dataset.id), { setup_token: el.dataset.tok, username: el.dataset.u, created: true });
A.delRoom = async el => {
  if (!confirm('Xóa phòng này và toàn bộ ảnh? (Lịch sử thu tiền vẫn giữ)')) return;
  await api('DELETE', '/api/rooms/' + el.dataset.id); await load(); closeModal(); render();
};

/* ================= GỬI SALES ================= */
function salesVars(r) {
  const s = S.settings;
  const lines = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean).map(x => '• ' + x.replace(/^[•\-*]\s*/, '')).join('\n');
  return {
    phong: r.code, ten_nha: s.house_name || '', dia_chi: s.address || '',
    gia: `${moneyD(r.price)} (${shortMoney(r.price)})`, gia_so: money(r.price),
    dien_tich: r.area ? r.area + ' m²' : '', tang: r.floor || '', toi_da: r.max_people ? r.max_people + ' người' : '',
    trong_tu: r.status === 'Trống' ? (r.available_from && r.available_from > today() ? fmtDate(r.available_from) : 'Ở ngay') : (r.available_from ? fmtDate(r.available_from) : ''),
    dien: moneyD(s.elec_price), nuoc: moneyD(s.water_price), phi_dv: moneyD(r.service_fee || s.service_fee),
    xe: n0(s.parking_price) ? moneyD(s.parking_price) + '/xe/tháng' : 'Miễn phí',
    coc: n0(r.deposit) ? moneyD(r.deposit) : '1 tháng tiền phòng',
    tien_ich: lines(r.amenities), tien_ich_chung: lines(s.sales_common), mo_ta: r.description || '',
    lien_he: s.sales_contact || s.phone || '', hoa_hong: s.sales_commission ? '🎁 Hoa hồng sales: ' + s.sales_commission : '',
    so_anh: String(imagesOf(r.id).length),
  };
}
function salesText(r) {
  const v = salesVars(r), tpl = S.settings.sales_template || '';
  const empty = seg => { const ks = [...seg.matchAll(/\{(\w+)\}/g)].map(m => m[1]); return ks.length && ks.every(k => !v[k]); };
  const fill = seg => seg.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
  // dòng có nhiều phần "a • b • c": phần nào toàn biến trống thì bỏ; cả dòng trống thì bỏ dòng
  const lines = tpl.split('\n').map(line => {
    const segs = line.split(' • ').filter(sg => !empty(sg));
    return segs.length ? fill(segs.join(' • ')) : null;
  }).filter(x => x !== null);
  // bỏ tiêu đề mục (dòng chữ IN HOA, không có ":") nếu ngay sau nó là dòng trống / hết
  const isHeading = l => l.trim() && !l.includes(':') && l === l.toUpperCase() && /\p{Lu}{3,}/u.test(l);
  const out = lines.filter((l, i) => !(i > 0 && isHeading(l) && !(lines[i + 1] || '').trim()));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function vSales() {
  const vac = r => r.status !== 'Đang thuê';
  if (!UI.salesFilter) UI.salesFilter = S.rooms.some(vac) ? 'vacant' : 'all';
  const list = S.rooms.filter(r => UI.salesFilter === 'all' || vac(r)).sort((a, b) => vac(b) - vac(a) || a.sort - b.sort);
  if (!list.find(r => r.id === UI.salesRoom)) UI.salesRoom = list[0]?.id;
  const r = S.rooms.find(x => x.id === UI.salesRoom);
  const imgs = r ? imagesOf(r.id) : [];
  view.innerHTML = `<div class="head"><div><h2>Gửi thông tin cho Sales</h2><p>Chọn phòng → nội dung tự tạo từ giá phòng, dịch vụ, tiện ích + ảnh. Sửa mẫu ở Cài đặt.</p></div>
  <div class="actions"><button class="btn" data-act="copyAllVacant">Copy danh sách phòng trống</button></div></div>
  <div class="sales-layout"><div>
    <div class="actions" style="margin-bottom:8px"><button class="btn sm ${UI.salesFilter === 'vacant' ? 'primary' : ''}" data-act="salesFilter" data-f="vacant">Trống / sắp trống</button><button class="btn sm ${UI.salesFilter === 'all' ? 'primary' : ''}" data-act="salesFilter" data-f="all">Tất cả</button></div>
    <div class="room-list">${list.map(x => { const im = imagesOf(x.id)[0]; return `<button class="room-item ${x.id === UI.salesRoom ? 'active' : ''}" data-act="pickSales" data-id="${x.id}">${im ? `<img src="${imgUrl(im)}" alt="">` : '<span class="ph"></span>'}<span style="flex:1;min-width:0"><b>${esc(x.code)}</b> ${statusPill(x.status)}<br><span class="muted">${shortMoney(x.price)} • ${imagesOf(x.id).length} ảnh</span> ${listingPill(x.listing)}</span></button>`; }).join('') || '<div class="card empty">Không có phòng trống. Chọn “Tất cả”.</div>'}</div>
  </div>
  ${r ? `<div class="grid" style="gap:14px">
    <div class="card listing-card"><div class="head" style="margin-bottom:0"><div><h3>Hiển thị ${esc(r.code)} cho tài khoản Sales</h3>
      <p>${r.status === 'Đang thuê' && r.listing ? '⚠ Phòng đang thuê – chỉ hiện cho Sales khi chuyển sang Trống / Sắp trống.' : 'Sales thấy: giá, dịch vụ, tiện ích, ảnh, thông tin liên hệ chủ trọ.'}</p></div>
      <div class="actions"><select id="listingSel" class="btn" data-id="${r.id}">${LISTING.map(([v, l]) => `<option value="${v}" ${v === (r.listing || '') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn primary" data-act="shareSalesRoom" data-id="${r.id}">📣 Gửi cho danh bạ Sales</button></div></div></div>
    <div class="card"><div class="head"><h3>Nội dung – ${esc(r.code)}</h3><div class="actions">
      <button class="btn primary" data-act="copySales">Copy nội dung</button>
      <button class="btn" data-act="shareSales">Chia sẻ (ảnh + chữ)</button>
      <button class="btn" data-act="editRoom" data-id="${r.id}">Sửa phòng / ảnh</button></div></div>
      <textarea class="sales-text" id="salesText">${esc(salesText(r))}</textarea></div>
    <div class="card"><div class="head"><h3>Hình ảnh (${imgs.length})</h3><div class="actions">
      ${imgs.length ? `<a class="btn" href="/api/rooms/${r.id}/images.zip?${bq()}">Tải tất cả ảnh (.zip)</a>` : ''}
      <button class="btn" data-act="makePoster">Tạo ảnh tổng hợp</button></div></div>
      ${imgs.length ? `<div class="gallery">${imgs.map(im => `<div class="thumb"><img src="${imgUrl(im)}" data-act="viewImg" data-src="${imgUrl(im)}" alt=""></div>`).join('')}</div>` : `<div class="empty">Chưa có ảnh. <button class="btn sm" data-act="editRoom" data-id="${r.id}">Thêm ảnh</button></div>`}
      <div class="poster-wrap" id="posterWrap" style="margin-top:14px"></div></div>
  </div>` : '<div class="card empty">Chưa có phòng</div>'}</div>
  <div class="card" style="margin-top:14px" id="contactsBox"></div>`;
  const ls = $('#listingSel'); if (ls) ls.onchange = () => setListing(ls);
  renderContacts();
}
A.salesFilter = el => { UI.salesFilter = el.dataset.f; vSales(); };
A.pickSales = el => { UI.salesRoom = +el.dataset.id; vSales(); };
A.copySales = async () => { await copyText($('#salesText').value); toast('Đã copy nội dung – dán vào Zalo/Facebook'); };
A.copyAllVacant = async () => {
  const s = S.settings, list = S.rooms.filter(r => r.status !== 'Đang thuê');
  if (!list.length) return toast('Không có phòng trống');
  const t = [`🏠 ${s.house_name} – ${s.address}`, `PHÒNG TRỐNG (${list.length}):`, ...list.map(r => {
    const v = salesVars(r); return `• ${r.code}: ${shortMoney(r.price)}${v.dien_tich ? ' – ' + v.dien_tich : ''}${v.trong_tu ? ' – trống ' + v.trong_tu.toLowerCase() : ''}`;
  }), '', `Điện ${money(s.elec_price)}đ/kWh • Nước ${shortMoney(s.water_price)}/người • DV ${shortMoney(s.service_fee)}/phòng • Xe ${n0(s.parking_price) ? shortMoney(s.parking_price) : 'miễn phí'}`,
  `📞 ${s.sales_contact || s.phone}`, s.sales_commission ? '🎁 Hoa hồng: ' + s.sales_commission : ''].join('\n').trim();
  await copyText(t); toast('Đã copy danh sách phòng trống');
};
const loadImg = src => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
function drawCover(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height), sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
async function posterCanvas(r) {
  const W = 1080, H = 1350, s = S.settings, v = salesVars(r);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
  const teal = '#0f766e', F = 'system-ui,"Segoe UI",Roboto,sans-serif';
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  const imgs = (await Promise.all(imagesOf(r.id).slice(0, 4).map(im => loadImg(imgUrl(im))))).filter(Boolean);
  const PH = 760, g = 6;
  c.fillStyle = '#e6efed'; c.fillRect(0, 0, W, PH);
  if (imgs.length === 1) drawCover(c, imgs[0], 0, 0, W, PH);
  else if (imgs.length === 2) { drawCover(c, imgs[0], 0, 0, W / 2 - g / 2, PH); drawCover(c, imgs[1], W / 2 + g / 2, 0, W / 2 - g / 2, PH); }
  else if (imgs.length >= 3) {
    const bw = 700; drawCover(c, imgs[0], 0, 0, bw, PH);
    const rest = imgs.slice(1), sh = (PH - g * (rest.length - 1)) / rest.length;
    rest.forEach((im, i) => drawCover(c, im, bw + g, i * (sh + g), W - bw - g, sh));
  } else { c.fillStyle = teal; c.font = `bold 64px ${F}`; c.textAlign = 'center'; c.fillText(s.house_name || '', W / 2, PH / 2); c.textAlign = 'left'; }
  c.fillStyle = teal; rr(c, 36, 36, 260, 70, 35); c.fill();
  c.fillStyle = '#fff'; c.font = `bold 34px ${F}`; c.fillText('CHO THUÊ', 70, 83);
  let y = PH + 70;
  c.fillStyle = '#111'; c.font = `bold 52px ${F}`; c.fillText(`Phòng ${r.code}`, 50, y);
  c.fillStyle = '#666'; c.font = `28px ${F}`; c.fillText(`${s.house_name || ''}${s.address ? ' • ' + s.address : ''}`.slice(0, 60), 50, y + 46);
  c.fillStyle = teal; c.font = `bold 72px ${F}`; c.textAlign = 'right'; c.fillText(shortMoney(r.price), W - 50, y + 4);
  c.fillStyle = '#666'; c.font = `26px ${F}`; c.fillText('/tháng', W - 50, y + 44); c.textAlign = 'left';
  y += 100;
  c.strokeStyle = '#e3e3e3'; c.lineWidth = 2; c.beginPath(); c.moveTo(50, y); c.lineTo(W - 50, y); c.stroke();
  const info = [['Điện', v.dien + '/kWh'], ['Nước', v.nuoc + '/người'], ['Dịch vụ', v.phi_dv + '/phòng'], ['Gửi xe', v.xe],
    ...(v.dien_tich ? [['Diện tích', v.dien_tich]] : []), ...(v.tang ? [['Tầng', v.tang]] : []), ['Cọc', v.coc], ['Trống', v.trong_tu || 'Liên hệ']].slice(0, 8);
  y += 50; c.font = `28px ${F}`;
  info.forEach(([k, val], i) => {
    const x = i % 2 ? W / 2 + 10 : 50, yy = y + Math.floor(i / 2) * 50;
    c.fillStyle = '#777'; c.fillText(k + ':', x, yy); c.fillStyle = '#111'; c.font = `bold 28px ${F}`; c.fillText(String(val).slice(0, 26), x + 150, yy); c.font = `28px ${F}`;
  });
  const am = String(r.amenities || '').split('\n').map(x => x.trim().replace(/^[•\-*]\s*/, '')).filter(Boolean);
  if (am.length) { c.fillStyle = teal; c.font = `24px ${F}`; c.fillText(('✓ ' + am.join('   ✓ ')).slice(0, 80), 50, y + Math.ceil(info.length / 2) * 50 + 6); }
  c.fillStyle = teal; c.fillRect(0, H - 100, W, 100);
  c.fillStyle = '#fff'; c.font = `bold 38px ${F}`; c.textAlign = 'center'; c.fillText(`Liên hệ xem phòng: ${v.lien_he}`, W / 2, H - 37); c.textAlign = 'left';
  return cv;
}
A.makePoster = async () => {
  const r = S.rooms.find(x => x.id === UI.salesRoom), cv = await posterCanvas(r);
  const w = $('#posterWrap'); w.innerHTML = ''; w.appendChild(cv);
  const bar = document.createElement('div'); bar.className = 'actions'; bar.style.marginTop = '8px';
  bar.innerHTML = `<button class="btn primary" id="pDl">Tải ảnh tổng hợp</button><button class="btn" id="pCp">Copy ảnh</button>`; w.appendChild(bar);
  $('#pDl').onclick = async () => downloadBlob(await canvasBlob(cv), `${r.code}_cho-thue.png`);
  $('#pCp').onclick = async () => toast(await copyImage(await canvasBlob(cv)) ? 'Đã copy ảnh – dán vào Zalo' : 'Không copy được – hãy tải ảnh');
};
A.shareSales = async () => {
  const r = S.rooms.find(x => x.id === UI.salesRoom), text = $('#salesText').value;
  const files = [];
  try {
    for (const im of imagesOf(r.id).slice(0, 10)) { const b = await (await fetch(imgUrl(im))).blob(); files.push(new File([b], im.filename, { type: b.type })); }
  } catch (e) { /* ignore */ }
  if (navigator.canShare && files.length && navigator.canShare({ files })) {
    try { await copyText(text); await navigator.share({ files, text, title: 'Phòng ' + r.code }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  await copyText(text); toast('Máy này không hỗ trợ chia sẻ kèm ảnh – đã copy nội dung, bấm “Tải tất cả ảnh”', 4500);
};

/* ================= CHI PHÍ ================= */
function vExpenses() {
  const p = UI.period, list = S.expenses.filter(e => e.period === p);
  const byG = {}; list.forEach(e => byG[groupOf(e.category)] = (byG[groupOf(e.category)] || 0) + expAmount(e));
  const total = list.reduce((s, e) => s + expAmount(e), 0);
  view.innerHTML = `<div class="head"><div><h2>Chi phí ${pLabel(p)}</h2><p>Chi cố định + điện/nước tạm tính tự thêm khi tạo kỳ. Có hóa đơn thật → bấm “Sửa” nhập số thật.</p></div>
  <div class="actions"><button class="btn primary" data-act="editExp">+ Thêm chi phí</button></div></div>
  <div class="grid kpis" style="margin-bottom:14px"><div class="card kpi"><div class="label">Tổng chi</div><div class="value">${money(total)}</div></div>
  ${Object.entries(byG).map(([g, v]) => `<div class="card kpi"><div class="label">${g}</div><div class="value">${money(v)}</div></div>`).join('')}</div>
  <div class="table-wrap"><table><thead><tr><th>Ngày</th><th>Hạng mục</th><th>Nội dung</th><th class="num">Số tiền</th><th>Nhóm</th><th>Phòng</th><th>Hình thức</th><th>Ghi chú</th><th></th></tr></thead><tbody>
  ${list.map(e => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.content)}</td><td class="num"><b>${money(expAmount(e))}</b> ${e.estimated ? '<span class="pill warn">tạm tính</span>' : ''}</td><td>${groupOf(e.category)}</td><td>${esc(e.room_code)}</td><td>${esc(e.method)}</td><td class="muted">${esc(e.note)}</td><td><button class="btn sm" data-act="editExp" data-id="${e.id}">Sửa</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Chưa có chi phí kỳ này</td></tr>'}
  </tbody></table></div>`;
}
A.editExp = el => {
  const id = +el.dataset.id || 0, e = S.expenses.find(x => x.id === id) || { date: today(), period: UI.period, category: '', amount: null, method: 'Chuyển khoản' };
  const cats = (S.settings.expense_categories || []).map(c => c.name);
  openModal(`<h2>${id ? 'Sửa' : 'Thêm'} chi phí</h2>
  ${e.estimated ? `<p class="pill warn" style="margin-top:8px">Đang tạm tính: ${moneyD(expAmount(e))}. Nhập số hóa đơn thật rồi Lưu để chốt.</p>` : ''}
  <div class="form" id="ef" style="margin-top:14px">
    ${field('Ngày', 'date', e.date, { type: 'date' })}${field('Kỳ', 'periodIn', pToInput(e.period), { type: 'month' })}
    ${field('Hạng mục', 'category', e.category || cats[0], { options: cats })}${field('Nội dung', 'content', e.content)}
    ${field('Số tiền', 'amount', e.estimated ? expAmount(e) : e.amount, { num: 1 })}${field('Phòng (nếu có)', 'room_code', e.room_code || '', { options: [['', '—'], ...S.rooms.map(r => r.code)] })}
    ${field('Hình thức', 'method', e.method, { options: ['Chuyển khoản', 'Tiền mặt'] })}${field('Ghi chú', 'note', e.note)}
  </div>
  <div class="foot">${id ? `<button class="btn danger" data-act="delRow" data-t="expenses" data-id="${id}" style="margin-right:auto">Xóa</button>` : ''}<button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="saveExp" data-id="${id}">Lưu</button></div>`);
};
A.saveExp = async el => {
  const id = +el.dataset.id, d = formData($('#ef'));
  d.period = d.periodIn ? pFromInput(d.periodIn) : UI.period; delete d.periodIn; d.amount = d.amount ?? 0; d.estimated = 0;
  if (id && S.expenses.find(x => x.id === id)?.estimated && d.note.startsWith('Tạm tính')) d.note = 'Hóa đơn thật';
  id ? await api('PUT', '/api/expenses/' + id, d) : await api('POST', '/api/expenses', d);
  await load(); closeModal(); render();
};
A.delRow = async el => {
  if (!confirm('Xóa dòng này?')) return;
  await api('DELETE', `/api/${el.dataset.t}/${el.dataset.id}`); await load(); closeModal(); render();
};

/* ================= THU THÊM ================= */
function vExtras() {
  const p = UI.period, list = S.extras.filter(e => e.period === p);
  view.innerHTML = `<div class="head"><div><h2>Thu thêm / giảm trừ ${pLabel(p)}</h2><p>Số âm = giảm trừ. Tự cộng vào bill của phòng trong kỳ.</p></div>
  <div class="actions"><button class="btn primary" data-act="editExtra">+ Thêm</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Ngày</th><th>Phòng</th><th>Loại</th><th>Nội dung</th><th class="num">Số tiền</th><th>Ghi chú</th><th></th></tr></thead><tbody>
  ${list.map(e => `<tr><td>${fmtDate(e.date)}</td><td><b>${esc(e.room_code)}</b></td><td>${esc(e.type)}</td><td>${esc(e.content)}</td><td class="num" style="color:${e.amount < 0 ? 'var(--danger)' : 'inherit'}">${money(e.amount)}</td><td class="muted">${esc(e.note)}</td><td><button class="btn sm" data-act="editExtra" data-id="${e.id}">Sửa</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Chưa có khoản thu thêm kỳ này</td></tr>'}
  </tbody>${list.length ? `<tfoot><tr><td colspan="4">Tổng</td><td class="num">${money(list.reduce((s, e) => s + n0(e.amount), 0))}</td><td colspan="2"></td></tr></tfoot>` : ''}</table></div>`;
}
A.editExtra = el => {
  const id = +el.dataset.id || 0, e = S.extras.find(x => x.id === id) || { date: today(), period: UI.period, amount: null };
  const codes = [...new Set([...billsOf(UI.period).map(b => b.room_code), ...S.rooms.map(r => r.code)])];
  openModal(`<h2>${id ? 'Sửa' : 'Thêm'} thu thêm / giảm trừ</h2><div class="form" id="xf" style="margin-top:14px">
    ${field('Ngày', 'date', e.date, { type: 'date' })}${field('Kỳ tính', 'periodIn', pToInput(e.period), { type: 'month' })}
    ${field('Phòng', 'room_code', e.room_code || codes[0], { options: codes })}${field('Loại', 'type', e.type || (S.settings.extra_types || [])[0], { options: S.settings.extra_types || ['Khác'] })}
    ${field('Nội dung', 'content', e.content, { ph: '4 lần × 20.000' })}${field('Số tiền (âm = giảm trừ)', 'amount', e.amount, { num: 1 })}${field('Ghi chú', 'note', e.note, { wide: 1 })}
  </div><div class="foot">${id ? `<button class="btn danger" data-act="delRow" data-t="extras" data-id="${id}" style="margin-right:auto">Xóa</button>` : ''}<button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="saveExtra" data-id="${id}">Lưu</button></div>`);
};
A.saveExtra = async el => {
  const id = +el.dataset.id, d = formData($('#xf'));
  d.period = pFromInput(d.periodIn); delete d.periodIn; d.amount = d.amount ?? 0;
  id ? await api('PUT', '/api/extras/' + id, d) : await api('POST', '/api/extras', d);
  await load(); closeModal(); render();
};

/* ================= CÀI ĐẶT ================= */
function vSettings() {
  const s = S.settings, banks = s.banks || [];
  view.innerHTML = `<div class="head"><div><h2>Cài đặt – tòa ${esc(UI.building)}</h2><p>Điền 1 lần. Đơn giá mới áp dụng cho các kỳ tạo sau.</p></div>
  <div class="actions"><a class="btn" href="/api/export.xlsx?${bq()}">⬇ Xuất Excel</a><button class="btn" data-act="importExcel">Nhập từ Excel</button><a class="btn" href="/api/backup?${bq()}">Tải bản sao lưu (.zip)</a><button class="btn primary" data-act="saveSettings">Lưu cài đặt</button></div></div>
  <div id="sf">
  <div class="card"><h3 style="margin-bottom:12px">Thông tin nhà & ngân hàng (cho mã QR)</h3><div class="form">
    ${field('Tên nhà trọ', 'house_name', s.house_name)}${field('Địa chỉ', 'address', s.address)}${field('SĐT liên hệ', 'phone', s.phone)}
    ${field('Ngân hàng', 'bank_name', s.bank_name, { options: [['', '— chọn —'], ...banks.map(b => b[0])] })}${field('Số tài khoản', 'account_no', s.account_no)}
    ${field('Chủ tài khoản (VIẾT HOA KHÔNG DẤU)', 'account_name', s.account_name)}${field('Hạn thanh toán: ngày … tháng sau', 'due_day', s.due_day, { num: 1 })}
    ${field('Nhắc hết hạn hợp đồng trước (ngày)', 'remind_days', s.remind_days, { num: 1 })}
    ${field('Tự gửi bill qua app cho khách', 'auto_publish', s.auto_publish === false || s.auto_publish === 0 ? '0' : '1', { options: [['1', 'Bật – mỗi ngày tự gửi bill đã nhập đủ chỉ số'], ['0', 'Tắt – tôi tự bấm gửi']] })}
    ${field('Giờ tự gửi mỗi ngày (0–23)', 'auto_publish_hour', s.auto_publish_hour ?? 20, { num: 1 })}
    ${field('Tin nhắn mẫu nhắc khách tái ký – biến: {ten_khach} {phong} {ten_nha} {ngay_het_han} {con_lai} {han_tra_loi} {lien_he}', 'renew_message', s.renew_message, { area: 1, wide: 1, rows: 3 })}
  </div><p class="muted" style="margin:10px 0 0">${bankReady() ? '✓ Đã đủ thông tin ngân hàng – bill có mã QR.' : '⚠ Chưa đủ ngân hàng / số TK → bill chưa có mã QR.'}</p></div>
  <div class="card" style="margin-top:14px"><h3 style="margin-bottom:12px">Đơn giá thu khách & giá vốn</h3><div class="form">
    ${field('Điện thu khách (đ/kWh)', 'elec_price', s.elec_price, { num: 1 })}${field('Nước thu khách (đ/người)', 'water_price', s.water_price, { num: 1 })}
    ${field('Phí dịch vụ mặc định (đ/phòng)', 'service_fee', s.service_fee, { num: 1 })}${field('Giá giữ xe (đ/xe)', 'parking_price', s.parking_price, { num: 1 })}
    ${field('Giá vốn điện (đ/kWh) – tạm tính chi', 'elec_cost', s.elec_cost, { num: 1 })}${field('Chi phí nước (đ/người) – tạm tính chi', 'water_cost', s.water_cost, { num: 1 })}
  </div></div>
  <div class="card" style="margin-top:14px"><div class="head"><h3>Hạng mục chi (tự thêm khi tạo kỳ nếu có số tiền cố định hoặc tạm tính)</h3><button class="btn sm" data-act="addCat">+ Thêm hạng mục</button></div>
  <div class="table-wrap"><table id="catT"><thead><tr><th>Hạng mục</th><th>Nhóm báo cáo</th><th class="num">Chi cố định / tháng</th><th>Tạm tính theo</th><th>Ghi chú</th><th></th></tr></thead><tbody>
  ${(s.expense_categories || []).map(catRow).join('')}</tbody></table></div></div>
  <div class="card" style="margin-top:14px"><h3 style="margin-bottom:12px">Thu thêm & ngân hàng</h3><div class="form">
    ${field('Loại thu thêm (mỗi dòng 1 loại)', 'extra_types_txt', (s.extra_types || []).join('\n'), { area: 1, rows: 6 })}
    ${field('Danh sách ngân hàng (Tên|Mã BIN mỗi dòng)', 'banks_txt', banks.map(b => b.join('|')).join('\n'), { area: 1, rows: 6 })}
  </div></div>
  <div class="card" style="margin-top:14px"><h3 style="margin-bottom:12px">Gửi Sales</h3><div class="form">
    ${field('Liên hệ xem phòng (tên – SĐT)', 'sales_contact', s.sales_contact, { ph: s.phone })}${field('Hoa hồng cho sales', 'sales_commission', s.sales_commission, { ph: '50% tháng đầu' })}
    ${field('Tiện ích chung của nhà (mỗi dòng 1 ý)', 'sales_common', s.sales_common, { area: 1, wide: 1, rows: 4 })}
    ${field('Mẫu tin gửi sales', 'sales_template', s.sales_template, { area: 1, wide: 1, rows: 18 })}
  </div><p class="muted" style="font-size:12px">Biến dùng được: {phong} {ten_nha} {dia_chi} {gia} {gia_so} {dien_tich} {tang} {toi_da} {trong_tu} {dien} {nuoc} {phi_dv} {xe} {coc} {tien_ich} {tien_ich_chung} {mo_ta} {lien_he} {hoa_hong} {so_anh}. Dòng nào tất cả biến đều trống sẽ tự ẩn.</p></div>
  <div class="card" style="margin-top:14px"><h3 style="margin-bottom:12px">Hợp đồng thuê – thông tin Bên A (chủ trọ)</h3><div class="form">
    ${field('Họ tên Bên A', 'landlord_name', s.landlord_name)}${field('Ngày sinh', 'landlord_dob', s.landlord_dob, { ph: 'dd/mm/yyyy' })}${field('Số CCCD', 'landlord_id_no', s.landlord_id_no)}
    ${field('Ngày cấp', 'landlord_id_date', s.landlord_id_date, { ph: 'dd/mm/yyyy' })}${field('Nơi cấp', 'landlord_id_place', s.landlord_id_place)}${field('SĐT', 'landlord_phone', s.landlord_phone, { ph: s.phone })}
    ${field('Địa chỉ thường trú', 'landlord_address', s.landlord_address, { wide: 1 })}${field('Nơi ký hợp đồng', 'contract_place', s.contract_place, { ph: s.address })}
    ${field('Mẫu hợp đồng', 'contract_template', s.contract_template, { area: 1, wide: 1, rows: 16 })}
  </div><p class="muted" style="font-size:12px">Biến: {so_hd} {ngay_ky} {noi_ky} {ben_a_ten} {ben_a_ngay_sinh} {ben_a_cccd} {ben_a_ngay_cap} {ben_a_noi_cap} {ben_a_dia_chi} {ben_a_sdt} {stk} {ben_b_ten} {ben_b_ngay_sinh} {ben_b_gioi_tinh} {ben_b_cccd} {ben_b_ngay_cap} {ben_b_noi_cap} {ben_b_thuong_tru} {ben_b_sdt} {phong} {dia_chi_nha} {dien_tich} {so_nguoi} {tien_ich} {thoi_han} {ngay_bat_dau} {ngay_ket_thuc} {gia_thue} {gia_thue_chu} {tien_coc} {tien_coc_chu} {dien} {nuoc} {phi_dv} {xe} {han_thanh_toan} {dieu_khoan_them}. Dòng bắt đầu bằng “ĐIỀU” được in đậm.</p></div>
  </div>
  ${aiCardHTML()}
  <div class="card" style="margin-top:14px" id="membersBox"><p class="muted">Đang tải thành viên…</p></div>
  <div class="card" style="margin-top:14px" id="invitesBox"></div>`;
  renderMembers(); renderInvites();
}
function catRow(c) {
  return `<tr><td><input class="cell-input" style="width:160px;text-align:left" data-k="name" value="${esc(c.name)}"></td>
  <td><select class="cell-input" style="width:110px" data-k="group">${GROUPS.map(g => `<option ${g === c.group ? 'selected' : ''}>${g}</option>`).join('')}</select></td>
  <td class="num"><input class="cell-input" data-k="fixed" value="${c.fixed ? money(c.fixed) : ''}"></td>
  <td><select class="cell-input" style="width:120px" data-k="estimate">${[['', '—'], ['KWH', 'Theo kWh'], ['NGUOI', 'Theo số người']].map(([v, l]) => `<option value="${v}" ${v === (c.estimate || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
  <td><input class="cell-input" style="width:240px;text-align:left" data-k="note" value="${esc(c.note || '')}"></td><td><button class="btn sm danger" data-act="delCat">Xóa</button></td></tr>`;
}
A.addCat = () => $('#catT tbody').insertAdjacentHTML('beforeend', catRow({ name: '', group: 'Khác', fixed: 0, estimate: '', note: '' }));
A.delCat = el => el.closest('tr').remove();
A.saveSettings = async () => {
  const d = formData($('#sf'));
  d.extra_types = d.extra_types_txt.split('\n').map(x => x.trim()).filter(Boolean); delete d.extra_types_txt;
  d.banks = d.banks_txt.split('\n').map(x => x.split('|').map(y => y.trim())).filter(x => x[0] && x[1]); delete d.banks_txt;
  d.bank_bin = (d.banks.find(b => b[0] === d.bank_name) || [])[1] || '';
  d.account_name = noAccent(d.account_name).toUpperCase();
  d.expense_categories = $$('#catT tbody tr').map(tr => ({
    name: $('[data-k=name]', tr).value.trim(), group: $('[data-k=group]', tr).value, fixed: parseNum($('[data-k=fixed]', tr).value) || 0,
    estimate: $('[data-k=estimate]', tr).value, note: $('[data-k=note]', tr).value
  })).filter(c => c.name);
  d.auto_publish = d.auto_publish === '1'; d.auto_publish_hour = Math.min(23, Math.max(0, d.auto_publish_hour ?? 20));
  ['due_day', 'remind_days', 'elec_price', 'water_price', 'service_fee', 'parking_price', 'elec_cost', 'water_cost'].forEach(k => d[k] = d[k] ?? 0);
  S.settings = await api('PUT', '/api/settings', d);
  await loadBuildings(); toast('Đã lưu cài đặt'); vSettings();
};
A.importExcel = () => {
  openModal(`<h2>Nhập từ file Excel vào tòa ${esc(UI.building)}</h2>
  <p class="muted">Chọn file QuanLyThuChi_NhaTro*.xlsm. Lấy Cài đặt, Phòng, Thu tháng, Thu thêm, Chi phí.</p>
  <div class="form" style="margin-top:12px"><div class="field wide"><label>File Excel</label><input type="file" id="xf" accept=".xlsm,.xlsx"></div>
  <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" class="check" id="xrep"> Xóa dữ liệu phòng/thu/chi hiện có của tòa này trước khi nhập</label></div>
  <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn primary" data-act="doImportExcel">Nhập</button></div>`);
};
A.doImportExcel = async () => {
  const f = $('#xf').files[0]; if (!f) return toast('Chọn file trước');
  const rep = $('#xrep').checked;
  if (rep && !confirm(`Xóa toàn bộ phòng, thu, chi hiện có của tòa ${UI.building} rồi nhập lại?`)) return;
  toast('Đang nhập…', 10000);
  const r = await api('POST', `/api/import-excel?replace=${rep ? 1 : 0}`, undefined, { data: f, type: 'application/octet-stream' });
  closeModal(); await loadBuildings(); await switchBuilding(UI.building); toast(r.message, 5000);
};

/* ================= AI: ẢNH ĐỒNG HỒ ĐIỆN & CĂN CƯỚC ================= */
/* Chọn/chụp ảnh. capture=true mở thẳng camera sau trên điện thoại. */
function pickImages({ capture = false, multiple = false } = {}) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = multiple;
    if (capture) inp.setAttribute('capture', 'environment');
    inp.style.display = 'none'; document.body.appendChild(inp);
    inp.onchange = () => { resolve([...inp.files]); inp.remove(); };
    inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
    inp.click();
  });
}
const blobToB64 = blob => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
// 1568px cạnh dài là cỡ Claude đọc tốt nhất; nén JPEG để gửi nhanh
const aiImage = file => resizeImage(file, 1568, 0.9);
const aiOff = () => !ME.meta.ai.enabled;

/* ---- đồng hồ điện ---- */
A.meterPhoto = el => meterFlow(+el.dataset.id);
A.meterSeq = () => {
  const bs = billsOf(UI.period).sort((a, b) => (roomByCode(a.room_code)?.sort ?? 999) - (roomByCode(b.room_code)?.sort ?? 999) || a.room_code.localeCompare(b.room_code));
  const start = Math.max(0, bs.findIndex(b => b.new_idx === null && !n0(b.manual_kwh)));
  meterFlow(bs[start].id, { list: bs.map(b => b.id), i: start });
};
A.viewMeterPhoto = el => window.open(`/img/${encodeURIComponent(UI.building)}/${encodeURIComponent(el.dataset.f)}`, '_blank');
async function meterFlow(billId, seq) {
  const b = S.bills.find(x => x.id === billId);
  const head = `<h2>📷 Chỉ số điện ${esc(b.room_code)}${seq ? ` <span class="muted" style="font-size:14px">(${seq.i + 1}/${seq.list.length})</span>` : ''}</h2>
    <p class="muted">Chỉ số cũ: <b>${b.old_idx ?? '—'}</b>${b.new_idx !== null ? ` • đã nhập: <b>${b.new_idx}</b>` : ''}</p>`;
  const nav = seq ? `<button class="btn" id="mSkip">Bỏ qua ›</button>` : '';
  openModal(`${head}<div class="ai-steps"><button class="btn primary" id="mShot" style="padding:14px 18px">📷 Chụp đồng hồ</button>
    <button class="btn" id="mFile">Chọn ảnh có sẵn</button></div>
    ${aiOff() ? '<p class="pill warn" style="display:block;white-space:normal;margin-top:10px">Chưa bật AI – ảnh vẫn được lưu làm bằng chứng, bạn nhập số tay.</p>' : ''}
    <div class="foot">${nav}<button class="btn" data-act="close">Đóng</button></div>`);
  const go = async capture => {
    const [file] = await pickImages({ capture }); if (!file) return;
    const blob = await aiImage(file), preview = URL.createObjectURL(blob);
    $('#modalBody').innerHTML = `${head}<div class="ai-result"><img src="${preview}" class="ai-photo" alt="">
      <div><div class="ai-wait"><span class="spinner"></span> ${aiOff() ? 'Đang lưu ảnh…' : 'AI đang đọc chỉ số…'}</div></div></div>`;
    let r, err;
    try { r = await api('POST', `/api/ai/meter/${b.id}`, undefined, { data: blob, type: 'image/jpeg' }, true); }
    catch (e) { err = e; r = e.data || {}; }
    if (r.photo) b.meter_photo = r.photo;
    meterResult(b, r, err, preview, head, seq);
  };
  $('#mShot').onclick = () => go(true);
  $('#mFile').onclick = () => go(false);
  if (seq) $('#mSkip').onclick = () => meterNext(seq);
}
function meterResult(b, r, err, preview, head, seq) {
  const ok = !err && r.readable;
  const val = ok ? r.reading : (b.new_idx ?? '');
  const conf = { cao: ['ok', 'chắc chắn'], trung_binh: ['warn', 'khá chắc'], thap: ['danger', 'không chắc'] }[r.confidence] || ['muted', ''];
  const prev = S.bills.find(x => x.period === pAdd(b.period, -1) && x.room_code === b.room_code);
  const prevK = prev ? calc(prev).kwh : 0;
  $('#modalBody').innerHTML = `${head}<div class="ai-result"><img src="${preview}" class="ai-photo" alt="" data-act="viewImg" data-src="${preview}">
    <div>
      ${err ? `<p class="pill danger" style="display:block;white-space:normal">${esc(err.message === 'auth' ? 'Hết phiên đăng nhập' : err.message)}</p><p class="muted">Ảnh đã lưu. Nhìn ảnh và nhập số tay.</p>`
            : `<div class="muted" style="font-size:13px">AI đọc được ${conf[1] ? `<span class="pill ${conf[0]}">${conf[1]}</span>` : ''}</div>
               ${r.digits_seen ? `<div class="muted" style="font-size:12px;margin-top:4px">Trên mặt đồng hồ: <b>${esc(r.digits_seen)}</b>${r.serial ? ` • seri ${esc(r.serial)}` : ''}</div>` : ''}`}
      <div class="field" style="margin:10px 0"><label>CHỈ SỐ MỚI (kWh)</label><input id="mVal" class="big-num" inputmode="numeric" value="${val}"></div>
      <div id="mKwh" class="muted"></div>
      ${(r.warnings || []).map(w => `<p class="pill warn" style="display:block;white-space:normal;margin-top:6px">⚠ ${esc(w)}</p>`).join('')}
      ${r.note ? `<p class="muted" style="font-size:12px;margin-top:6px">${esc(r.note)}</p>` : ''}
    </div></div>
    <div class="foot"><button class="btn" id="mAgain" style="margin-right:auto">Chụp lại</button>${seq ? '<button class="btn" id="mSkip">Bỏ qua</button>' : ''}
    <button class="btn" data-act="close">Đóng</button><button class="btn primary" id="mSave">${seq && seq.i < seq.list.length - 1 ? 'Lưu & phòng tiếp ›' : 'Lưu'}</button></div>`;
  const inp = $('#mVal');
  const upd = () => {
    const v = parseNum(inp.value);
    if (v === null || b.old_idx === null) { $('#mKwh').textContent = ''; return; }
    const k = v - n0(b.old_idx);
    $('#mKwh').innerHTML = `Tiêu thụ: <b style="color:${k < 0 ? 'var(--danger)' : 'var(--text)'}">${money(k)} kWh</b> = ${moneyD(k * n0(b.elec_price))}${prevK ? ` • tháng trước ${money(prevK)} kWh ${dlt(k, prevK, true)}` : ''}`;
  };
  inp.oninput = upd; upd(); inp.focus(); inp.select();
  inp.onkeydown = e => { if (e.key === 'Enter') $('#mSave').click(); };
  $('#mAgain').onclick = () => meterFlow(b.id, seq);
  if (seq) $('#mSkip').onclick = () => meterNext(seq);
  $('#mSave').onclick = async () => {
    const v = parseNum(inp.value);
    if (v === null) return toast('Nhập chỉ số');
    if (b.old_idx !== null && v < b.old_idx && !confirm(`Chỉ số ${v} nhỏ hơn số cũ ${b.old_idx}. Vẫn lưu?`)) return;
    await api('PUT', '/api/bills/' + b.id, { new_idx: v }); b.new_idx = v;
    const room = roomByCode(b.room_code);
    // lần đầu đọc được seri thì ghi vào phòng, các lần sau dùng để phát hiện chụp nhầm phòng
    if (!err && r.serial && room && !room.meter_serial && can('rooms')) {
      try { await api('PUT', '/api/rooms/' + room.id, { meter_serial: r.serial }, undefined, true); room.meter_serial = r.serial; } catch (_) {}
    }
    toast(`Đã lưu ${b.room_code}: ${v}`);
    if (seq && seq.i < seq.list.length - 1) meterNext(seq); else { closeModal(); if (UI.tab === 'monthly') vMonthly(); }
  };
}
function meterNext(seq) {
  if (seq.i >= seq.list.length - 1) { closeModal(); toast('Đã hết phòng'); return vMonthly(); }
  meterFlow(seq.list[seq.i + 1], { list: seq.list, i: seq.i + 1 });
}

/* ---- căn cước ---- */
const ID_MAP = { full_name: 'tenant', date_of_birth: 'tenant_dob', sex: 'tenant_gender', id_number: 'tenant_id_no',
  issue_date: 'tenant_id_date', issued_by: 'tenant_id_place', residence: 'tenant_address', hometown: 'tenant_hometown' };
A.idcardScan = async () => {
  if (aiOff()) return toast('Chưa bật AI – chủ hệ thống nhập API key ở Cài đặt → AI', 4000);
  const box = $('#idcardBox'), shots = [];
  const show = () => {
    box.innerHTML = `<div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      ${shots.map(s => `<img src="${s.url}" style="height:70px;border-radius:6px">`).join('')}
      <span class="muted">${shots.length ? `Đã có ${shots.length === 1 ? 'mặt trước' : 'mặt trước + sau'}.` : ''}</span>
      ${shots.length < 2 ? `<button class="btn sm" id="idMore">📷 ${shots.length ? 'Chụp mặt sau' : 'Chụp mặt trước'}</button>` : ''}
      ${shots.length ? '<button class="btn primary sm" id="idRead">Đọc & điền</button>' : ''}</div>`;
    const more = $('#idMore'), read = $('#idRead');
    if (more) more.onclick = take;
    if (read) read.onclick = run;
  };
  const take = async () => {
    const files = await pickImages({ capture: true }); if (!files.length) return;
    const blob = await aiImage(files[0]); shots.push({ blob, url: URL.createObjectURL(blob) }); show();
  };
  const run = async () => {
    box.innerHTML = '<div class="card ai-wait" style="margin-bottom:12px"><span class="spinner"></span> AI đang đọc căn cước…</div>';
    let r;
    try { r = await api('POST', '/api/ai/idcard', { images: await Promise.all(shots.map(async s => ({ type: 'image/jpeg', data: await blobToB64(s.blob) }))) }, undefined, true); }
    catch (e) { box.innerHTML = `<p class="pill danger" style="display:block;white-space:normal;margin-bottom:12px">${esc(e.message)}</p>`; return; }
    if (!r.is_id_card) { box.innerHTML = '<p class="pill warn" style="display:block;margin-bottom:12px">Ảnh không giống thẻ căn cước – chụp lại rõ hơn.</p>'; return; }
    let n = 0;
    for (const [k, name] of Object.entries(ID_MAP)) {
      const v = (r[k] || '').trim(), inp = $(`#rf2 [name=${name}]`);
      if (!v || !inp || inp.disabled) continue;
      inp.value = v; inp.classList.add('ai-filled'); n++;
      if ((r.unclear_fields || []).includes(k)) inp.classList.add('ai-unclear');
    }
    box.innerHTML = `<p class="pill ok" style="display:block;white-space:normal;margin-bottom:12px">✓ AI đã điền ${n} ô (tô vàng${(r.unclear_fields || []).length ? ', viền đỏ = không chắc' : ''}). Kiểm tra lại rồi bấm <b>Lưu</b>.${r.note ? ' ' + esc(r.note) : ''}</p>`;
  };
  await take();
};

/* ================= HỢP ĐỒNG THUÊ ================= */
function contractListHTML(code) {
  const list = (S.contracts || []).filter(c => c.room_code === code);
  if (!list.length) return '<p class="muted">Chưa có hợp đồng.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Khách</th><th>Từ</th><th>Đến</th><th class="num">Giá thuê</th><th>Lập bởi</th><th></th></tr></thead><tbody>
  ${list.map(c => `<tr><td>${esc(c.tenant)}</td><td>${fmtDate(c.start_date)}</td><td>${fmtDate(c.end_date)}${c.end_date && c.end_date < today() ? ' <span class="pill muted">hết hạn</span>' : ''}</td><td class="num">${money(c.rent)}</td><td class="muted">${esc(c.created_by)}</td>
  <td><div class="actions"><button class="btn sm" data-act="openContract" data-id="${c.id}">In / Xem</button><button class="btn sm danger" data-act="delContract" data-id="${c.id}">Xóa</button></div></td></tr>`).join('')}</tbody></table></div>`;
}
/* đọc số thành chữ tiếng Việt: 3500000 -> "Ba triệu năm trăm nghìn đồng" */
function docSo(n) {
  n = Math.round(n0(n)); if (!n) return 'Không đồng';
  const so = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const doc3 = (x, full) => {
    const tr = Math.floor(x / 100), ch = Math.floor(x % 100 / 10), dv = x % 10, out = [];
    if (full || tr) out.push(so[tr] + ' trăm');
    if (ch > 1) out.push(so[ch] + ' mươi'); else if (ch === 1) out.push('mười'); else if (dv && (full || tr)) out.push('lẻ');
    if (dv) out.push(dv === 1 && ch > 1 ? 'mốt' : dv === 5 && ch > 0 ? 'lăm' : dv === 4 && ch > 1 ? 'tư' : so[dv]);
    return out.join(' ');
  };
  const units = ['', ' nghìn', ' triệu', ' tỷ'], parts = [], groups = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }  // nhóm 3 chữ số từ phải sang
  let first = true;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    parts.push(doc3(groups[i], !first) + (units[i] || ''));  // nhóm sau nhóm đầu đọc đủ "không trăm", "lẻ"
    first = false;
  }
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1) + ' đồng';
}
const addMonths = (iso, m) => { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + m); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function contractVars(r, f) {
  const s = S.settings, v = salesVars(r), dash = '……………';
  const amen = String(r.amenities || '').split('\n').map(x => x.trim().replace(/^[•\-*]\s*/, '')).filter(Boolean).join(', ');
  return {
    so_hd: f.so_hd, ngay_ky: fmtDate(f.ngay_ky), noi_ky: f.noi_ky || dash,
    ben_a_ten: s.landlord_name || dash, ben_a_ngay_sinh: s.landlord_dob || dash, ben_a_cccd: s.landlord_id_no || dash,
    ben_a_ngay_cap: s.landlord_id_date || dash, ben_a_noi_cap: s.landlord_id_place || dash, ben_a_dia_chi: s.landlord_address || dash,
    ben_a_sdt: s.landlord_phone || s.phone || dash, stk: s.account_no ? `${s.account_no} – ${s.bank_name} – ${s.account_name}` : dash,
    ben_b_ten: r.tenant || dash, ben_b_ngay_sinh: r.tenant_dob || dash, ben_b_gioi_tinh: r.tenant_gender || dash,
    ben_b_cccd: r.tenant_id_no || dash, ben_b_ngay_cap: r.tenant_id_date || dash, ben_b_noi_cap: r.tenant_id_place || dash,
    ben_b_thuong_tru: r.tenant_address || dash, ben_b_sdt: r.phone || dash,
    phong: r.code, dia_chi_nha: s.address || dash, dien_tich: r.area ? r.area + ' m²' : dash, so_nguoi: f.so_nguoi || dash,
    tien_ich: amen || 'theo biên bản bàn giao',
    thoi_han: f.months, ngay_bat_dau: fmtDate(f.start), ngay_ket_thuc: fmtDate(addMonths(f.start, +f.months)),
    gia_thue: money(f.rent), gia_thue_chu: docSo(f.rent), tien_coc: money(f.deposit), tien_coc_chu: docSo(f.deposit),
    dien: money(s.elec_price), nuoc: money(s.water_price), phi_dv: money(r.service_fee || s.service_fee), xe: v.xe,
    han_thanh_toan: f.due_day, dieu_khoan_them: f.extra || 'Không có.',
  };
}
function contractHTML(r, f) {
  const vars = contractVars(r, f);
  const lines = String(S.settings.contract_template || '').replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m).split('\n');
  const ti = lines.findIndex(l => /^HỢP ĐỒNG/.test(l.trim()));
  const body = lines.map((l, i) => {
    const t = esc(l);
    if (!l.trim()) return '<div style="height:6px"></div>';
    if (i < ti) return `<p class="c-center c-b">${t}</p>`;
    if (i === ti) return `<p class="c-center c-title">${t}</p>`;
    if (i === ti + 1 && /^Số/.test(l)) return `<p class="c-center"><i>${t}</i></p>`;
    if (/^(ĐIỀU|BÊN CHO THUÊ|BÊN THUÊ)/.test(l.trim())) return `<p class="c-b">${t}</p>`;
    return `<p>${t.replace(/ {3,}/g, ' &nbsp; &nbsp; ')}</p>`;
  }).join('');
  return `<div class="contract">${body}
    <table class="c-sign"><tr><td><b>BÊN A</b><br><i>(Ký, ghi rõ họ tên)</i><br><br><br><br><br><b>${esc(S.settings.landlord_name || '')}</b></td>
    <td><b>BÊN B</b><br><i>(Ký, ghi rõ họ tên)</i><br><br><br><br><br><b>${esc(r.tenant || '')}</b></td></tr></table></div>`;
}
const CONTRACT_CSS = `body{font-family:"Times New Roman",serif;font-size:13pt;line-height:1.45;color:#000;margin:0}
.contract{max-width:760px;margin:0 auto;padding:24px 28px}.contract p{margin:2px 0;text-align:justify}
.c-center{text-align:center!important}.c-b{font-weight:bold}.c-title{font-weight:bold;font-size:16pt;margin-top:10px!important}
.c-sign{width:100%;margin-top:24px;border-collapse:collapse}.c-sign td{width:50%;text-align:center;vertical-align:top;border:0}
@page{size:A4;margin:18mm 16mm}@media print{.contract{padding:0}}`;
A.newContract = el => {
  const r = S.rooms.find(x => x.id === +el.dataset.id), s = S.settings;
  const start = r.move_in_contract || r.move_in || today();  // tái ký: hợp đồng mới bắt đầu sau ngày hết hạn cũ
  delete r.move_in_contract;
  const f = { so_hd: `${r.code.replace(/\W/g, '')}-${start.replace(/-/g, '')}`, ngay_ky: today(), noi_ky: s.contract_place || s.address,
    start, months: 12, rent: r.price, deposit: r.deposit || r.price, so_nguoi: Math.max(n0(r.people), n0(r.max_people)) || '', due_day: s.due_day, extra: '' };
  const miss = [!s.landlord_name && 'thông tin Bên A (Cài đặt)', !r.tenant && 'tên khách', !r.tenant_id_no && 'số CCCD khách (Chụp CCCD ở form phòng)'].filter(Boolean);
  openModal(`<h2>📄 Hợp đồng thuê – ${esc(r.code)}</h2>
  ${miss.length ? `<p class="pill warn" style="display:block;white-space:normal;margin-top:8px">Còn thiếu: ${miss.join(', ')}. Chỗ thiếu sẽ để “……” để điền tay.</p>` : ''}
  <div class="form" id="cf" style="margin-top:12px">
    ${field('Số hợp đồng', 'so_hd', f.so_hd)}${field('Ngày ký', 'ngay_ky', f.ngay_ky, { type: 'date' })}${field('Nơi ký', 'noi_ky', f.noi_ky)}
    ${field('Ngày bắt đầu thuê', 'start', f.start, { type: 'date' })}${field('Thời hạn (tháng)', 'months', f.months, { num: 1 })}${field('Số người ở tối đa', 'so_nguoi', f.so_nguoi, { num: 1 })}
    ${field('Giá thuê / tháng', 'rent', f.rent, { num: 1 })}${field('Tiền cọc', 'deposit', f.deposit, { num: 1 })}${field('Hạn thanh toán (ngày)', 'due_day', f.due_day, { num: 1 })}
    ${field('Điều khoản thêm (mỗi dòng 1 điều)', 'extra', '', { area: 1, wide: 1, rows: 3, ph: 'Không nuôi thú cưng.\nGiờ đóng cổng 23h.' })}
  </div>
  <h3 class="section-title">Xem trước</h3>
  <div class="contract-preview" id="cPrev"></div>
  <div class="foot"><button class="btn" data-act="editRoom" data-id="${r.id}" style="margin-right:auto">‹ Về phòng</button><button class="btn" id="cDoc">Tải Word</button><button class="btn primary" id="cSave">Lưu & In / PDF</button></div>`, body => {
    const read = () => { const d = formData($('#cf', body)); d.months = d.months || 12; d.rent = d.rent ?? 0; d.deposit = d.deposit ?? 0; return d; };
    const draw = () => { $('#cPrev', body).innerHTML = contractHTML(r, read()); };
    $('#cf', body).addEventListener('input', draw); draw();
    $('#cDoc', body).onclick = () => {
      const html = `<html><head><meta charset="utf-8"><style>${CONTRACT_CSS}</style></head><body>${contractHTML(r, read())}</body></html>`;
      downloadBlob(new Blob(['﻿', html], { type: 'application/msword' }), `HopDong_${r.code}_${(r.tenant || '').replace(/\s+/g, '')}.doc`);
    };
    $('#cSave', body).onclick = async () => {
      const w = window.open('', '_blank'); // mở trước để không bị chặn popup
      const d = read(), html = contractHTML(r, d);
      const c = await api('POST', '/api/contracts', { room_code: r.code, tenant: r.tenant, start_date: d.start, end_date: addMonths(d.start, +d.months),
        months: d.months, rent: d.rent, deposit: d.deposit, data: JSON.stringify(d), html });
      S.contracts = [c, ...(S.contracts || [])];
      printContract(w, html, r.code);
      toast('Đã lưu hợp đồng');
    };
  });
};
function printContract(w, html, code) {
  if (!w) return toast('Trình duyệt chặn cửa sổ in – cho phép popup rồi thử lại');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Hợp đồng ${esc(code)}</title><style>${CONTRACT_CSS}</style></head><body>${html}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}
A.openContract = async el => {
  const w = window.open('', '_blank');
  const c = await api('GET', '/api/contracts/' + el.dataset.id);
  printContract(w, c.html, c.room_code);
};
A.delContract = async el => {
  if (!confirm('Xóa hợp đồng đã lưu này?')) return;
  await api('DELETE', '/api/contracts/' + el.dataset.id);
  const c = S.contracts.find(x => x.id === +el.dataset.id); S.contracts = S.contracts.filter(x => x !== c);
  const r = roomByCode(c.room_code); if (r) A.editRoom({ dataset: { id: r.id } });
};

/* ---- cài đặt AI (chỉ chủ hệ thống) ---- */
function aiCardHTML() {
  const a = ME.meta.ai;
  return `<div class="card" style="margin-top:14px"><h3 style="margin-bottom:8px">AI đọc ảnh (Claude)</h3>
  <p>${a.enabled ? `<span class="pill ok">Đang bật</span> Model ${esc(a.model)} – key ${a.key_source === 'env' ? 'từ biến môi trường ANTHROPIC_API_KEY' : 'đã lưu trong app'}.` : '<span class="pill warn">Chưa bật</span> Cần Claude API key (tạo ở console.anthropic.com → API Keys).'}</p>
  <p class="muted" style="font-size:13px">Dùng cho: chụp đồng hồ điện → tự đọc chỉ số; chụp căn cước → tự điền thông tin khách. Ảnh được gửi tới Anthropic để xử lý; mỗi ảnh tốn phí theo bảng giá API. Ảnh CCCD không được lưu trong app, chỉ lưu chữ đã đọc.</p>
  ${ME.meta.system_owner && a.key_source !== 'env' ? `<div class="form" id="aiF" style="margin-top:10px">${field('Claude API key', 'api_key', '', { type: 'password', ph: a.key_source === 'app' ? '•••••• (đã lưu – nhập key mới để thay)' : 'sk-ant-…' })}
    <div class="field" style="justify-content:flex-end;flex-direction:row;gap:8px;align-items:flex-end"><button class="btn primary" data-act="saveAiKey">Lưu key</button>${a.key_source === 'app' ? '<button class="btn danger" data-act="clearAiKey">Tắt AI</button>' : ''}</div></div>`
    : (!ME.meta.system_owner ? '<p class="muted" style="font-size:12px">Chỉ chủ hệ thống (tài khoản đăng ký đầu tiên) mới đặt được key.</p>' : '')}</div>`;
}
A.saveAiKey = async () => {
  const k = $('#aiF [name=api_key]').value.trim(); if (!k) return toast('Nhập API key');
  ME.meta.ai = await api('POST', '/api/ai/key', { api_key: k }); toast('Đã bật AI'); vSettings();
};
A.clearAiKey = async () => {
  if (!confirm('Tắt AI (xóa key đã lưu)?')) return;
  ME.meta.ai = await api('POST', '/api/ai/key', { api_key: '' }); vSettings();
};

/* ================= SALES: TÌM PHÒNG ================= */
const MK = { list: [], q: '', price: '', status: '', sort: 'new' };
async function startSales() {
  document.body.classList.add('sales-mode');
  $('.brand').insertAdjacentHTML('beforeend', '<b style="font-size:16px">Tìm phòng</b>');
  view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  MK.list = await api('GET', '/api/market');
  vMarket();
}
const marketText = it => withData({ settings: it.settings, images: [] }, () => salesText(it.room));
function vMarket() {
  const q = noAccent(MK.q).toLowerCase();
  let list = MK.list.filter(it => {
    const r = it.room, hay = noAccent(`${r.code} ${it.settings.house_name} ${it.settings.address} ${r.amenities} ${r.description}`).toLowerCase();
    if (q && !q.split(/\s+/).every(w => hay.includes(w))) return false;
    if (MK.price && (MK.price.startsWith('>') ? r.price <= +MK.price.slice(1) : r.price > +MK.price)) return false;
    if (MK.status && r.status !== MK.status) return false;
    return true;
  });
  list = list.sort(MK.sort === 'asc' ? (a, b) => a.room.price - b.room.price : MK.sort === 'desc' ? (a, b) => b.room.price - a.room.price
    : (a, b) => (a.room.status === 'Trống' ? 0 : 1) - (b.room.status === 'Trống' ? 0 : 1) || String(a.room.available_from).localeCompare(String(b.room.available_from)));
  const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === v ? 'selected' : ''}>${l}</option>`;
  view.innerHTML = `<div class="head"><div><h2>Phòng đang mở cho Sales</h2><p>${MK.list.length} phòng trống / sắp trống từ ${new Set(MK.list.map(x => x.building)).size} tòa nhà • xin chào ${esc(ME.user.name)}</p></div>
    <div class="actions"><button class="btn" data-act="marketReload">↻ Làm mới</button><button class="btn" data-act="account">Tài khoản</button></div></div>
  <div class="card market-filters">
    <input id="mkQ" placeholder="🔍 Tìm theo địa chỉ, tòa, phòng, tiện ích (vd: máy lạnh, ban công)…" value="${esc(MK.q)}">
    <select id="mkPrice">${opt('', 'Mọi mức giá', MK.price)}${opt('3000000', 'Đến 3 triệu', MK.price)}${opt('4000000', 'Đến 4 triệu', MK.price)}${opt('5000000', 'Đến 5 triệu', MK.price)}${opt('7000000', 'Đến 7 triệu', MK.price)}${opt('>7000000', 'Trên 7 triệu', MK.price)}</select>
    <select id="mkStatus">${opt('', 'Trống + sắp trống', MK.status)}${opt('Trống', 'Trống – ở ngay', MK.status)}${opt('Sắp trống', 'Sắp trống', MK.status)}</select>
    <select id="mkSort">${opt('new', 'Trống sớm nhất', MK.sort)}${opt('asc', 'Giá thấp → cao', MK.sort)}${opt('desc', 'Giá cao → thấp', MK.sort)}</select>
  </div>
  <div class="room-grid" style="margin-top:14px">${list.map((it, i) => marketCard(it, MK.list.indexOf(it))).join('') ||
    `<div class="card empty" style="grid-column:1/-1">${MK.list.length ? 'Không có phòng khớp bộ lọc.' : 'Chưa có phòng nào được mở cho bạn. Chủ trọ cần bật “Hiển thị cho Sales” ở phòng trống, hoặc chia sẻ riêng cho tên đăng nhập <b>' + esc(ME.user.username) + '</b>.'}</div>`}</div>`;
  const re = () => { MK.q = $('#mkQ').value; MK.price = $('#mkPrice').value; MK.status = $('#mkStatus').value; MK.sort = $('#mkSort').value; };
  $('#mkQ').oninput = () => { re(); clearTimeout(MK.t); MK.t = setTimeout(() => { const pos = $('#mkQ').selectionStart; vMarket(); $('#mkQ').focus(); $('#mkQ').setSelectionRange(pos, pos); }, 250); };
  ['#mkPrice', '#mkStatus', '#mkSort'].forEach(s => $(s).onchange = () => { re(); vMarket(); });
}
function marketCard(it, idx) {
  const r = it.room, s = it.settings;
  const when = r.status === 'Trống' ? (r.available_from && r.available_from > today() ? 'Trống từ ' + fmtDate(r.available_from) : 'Ở ngay') : 'Sắp trống' + (r.available_from ? ' – ' + fmtDate(r.available_from) : '');
  return `<div class="card room-card"><div class="cover" data-act="marketOpen" data-i="${idx}" style="cursor:pointer">${r.images[0] ? `<img src="${r.images[0]}" loading="lazy" alt="">` : '<span>Chưa có ảnh</span>'}${r.images.length ? `<span class="count">${r.images.length} ảnh</span>` : ''}</div>
  <div class="body"><div class="row"><h3>${esc(r.code)} · ${esc(s.house_name)}</h3>${statusPill(r.status)}</div>
  <div class="price">${shortMoney(r.price)}<span class="muted" style="font-weight:400;font-size:13px">/tháng</span></div>
  <div class="muted" style="font-size:13px">📍 ${esc(s.address)}</div>
  <div class="muted" style="font-size:12px">${[r.area && r.area + 'm²', r.floor && 'tầng ' + r.floor, r.max_people && 'tối đa ' + r.max_people + ' người'].filter(Boolean).join(' • ')}</div>
  <div style="font-size:12px;margin-top:2px"><b>${esc(when)}</b> ${it.via === 'shared' ? '<span class="pill warn">Chia sẻ riêng cho bạn</span>' : ''}
  ${r.shared_at && (Date.now() - new Date(r.shared_at.replace(' ', 'T') + 'Z')) < 3 * 86400000 ? '<span class="pill ok">Mới gửi</span>' : ''}</div></div>
  <div class="foot"><button class="btn sm primary" data-act="marketOpen" data-i="${idx}">Chi tiết & tin đăng</button>${it.owner.phone ? `<a class="btn sm" href="tel:${esc(phoneNorm(it.owner.phone))}">📞 Gọi chủ</a>` : ''}</div></div>`;
}
A.marketReload = async () => { MK.list = await api('GET', '/api/market'); vMarket(); toast('Đã cập nhật'); };
A.marketOpen = el => {
  const it = MK.list[+el.dataset.i], r = it.room, s = it.settings, o = it.owner, ph = phoneNorm(o.phone);
  const info = [['Giá thuê', moneyD(r.price) + '/tháng'], ['Cọc', n0(r.deposit) ? moneyD(r.deposit) : '1 tháng tiền phòng'], ['Điện', moneyD(s.elec_price) + '/kWh'],
    ['Nước', moneyD(s.water_price) + '/người'], ['Phí dịch vụ', moneyD(r.service_fee || s.service_fee)], ['Gửi xe', n0(s.parking_price) ? moneyD(s.parking_price) + '/xe' : 'Miễn phí'],
    ['Diện tích', r.area ? r.area + ' m²' : '—'], ['Tầng', r.floor || '—'], ['Tối đa', r.max_people ? r.max_people + ' người' : '—'],
    ['Trạng thái', r.status + (r.available_from ? ' – từ ' + fmtDate(r.available_from) : '')]];
  openModal(`<h2>${esc(r.code)} · ${esc(s.house_name)}</h2><p class="muted">📍 ${esc(s.address)}</p>
  ${r.images.length ? `<div class="gallery" style="margin-top:12px">${r.images.map(u => `<div class="thumb"><img src="${u}" data-act="viewImg" data-src="${u}" alt=""></div>`).join('')}</div>` : ''}
  <div class="grid two" style="margin-top:14px">
    <div class="card"><h3 style="margin-bottom:8px">Thông tin phòng</h3><table>${info.map(([k, v]) => `<tr><td class="muted">${k}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>
      ${r.amenities ? `<p style="margin-top:8px"><b>Tiện ích:</b> ${esc(r.amenities.split('\n').filter(Boolean).join(', '))}</p>` : ''}${r.description ? `<p class="muted">${esc(r.description)}</p>` : ''}</div>
    <div class="card"><h3 style="margin-bottom:8px">Chủ trọ</h3>
      <p><b>${esc(o.name || '—')}</b>${o.phone ? `<br>📞 ${esc(o.phone)}` : ''}</p>
      ${o.contact ? `<p class="muted">Liên hệ xem phòng: ${esc(o.contact)}</p>` : ''}
      ${o.commission ? `<p class="pill ok" style="display:inline-block;white-space:normal">🎁 Hoa hồng: ${esc(o.commission)}</p>` : ''}
      <div class="actions" style="margin-top:10px">${ph ? `<a class="btn primary" href="tel:${ph}">Gọi</a><a class="btn" href="https://zalo.me/${ph}" target="_blank" rel="noopener">Zalo</a>` : ''}</div></div>
  </div>
  <h3 class="section-title">Tin đăng (copy gửi khách)</h3>
  <textarea class="sales-text" id="mkText" style="min-height:240px">${esc(marketText(it))}</textarea>
  <div class="foot"><button class="btn" data-act="close" style="margin-right:auto">Đóng</button>
    ${r.images.length ? `<a class="btn" href="/api/market/${encodeURIComponent(it.building)}/${r.id}/images.zip">Tải ảnh (.zip)</a>` : ''}
    <button class="btn" id="mkShare">Chia sẻ</button><button class="btn primary" id="mkCopy">Copy tin đăng</button></div>`, body => {
    $('#mkCopy', body).onclick = async () => { await copyText($('#mkText').value); toast('Đã copy tin đăng'); };
    $('#mkShare', body).onclick = async () => {
      const text = $('#mkText').value, files = [];
      try { for (const u of r.images.slice(0, 10)) { const bl = await (await fetch(u)).blob(); files.push(new File([bl], u.split('/').pop(), { type: bl.type })); } } catch (_) {}
      if (navigator.canShare && files.length && navigator.canShare({ files })) { try { await navigator.share({ files, text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      await copyText(text); toast('Máy này không chia sẻ kèm ảnh được – đã copy chữ, hãy tải ảnh .zip', 4000);
    };
  });
};

/* ---- phía chủ trọ: chia sẻ cho Sales ---- */
// Ẩn | Công khai (mọi Sales) | Chỉ Sales được gửi qua danh bạ mới thấy
const LISTING = [['', 'Ẩn – không cho Sales thấy'], ['public', 'Công khai – mọi Sales'], ['shared', 'Chỉ Sales được gửi (danh bạ)']];
const listingPill = l => l === 'public' ? '<span class="pill ok">Công khai</span>' : l === 'shared' ? '<span class="pill warn">Gửi riêng</span>' : '';
const setListing = async el => {
  const r = S.rooms.find(x => x.id === +el.dataset.id);
  const v = await api('PUT', '/api/rooms/' + r.id, { listing: el.value }); Object.assign(r, v);
  toast(el.value ? (r.status === 'Đang thuê' ? 'Đã lưu – phòng sẽ hiện cho Sales khi chuyển sang Trống / Sắp trống' : 'Sales đã thấy phòng này') : 'Đã ẩn khỏi Sales');
  vSales();
};

/* ================= HẾT HẠN HỢP ĐỒNG / SẮP TRỐNG ================= */
const daysBetween = iso => Math.round((new Date(iso + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
const isoAdd = (iso, days) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isoAddMonths = (iso, m) => { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + m); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function daysLabel(n) {
  if (n < 0) return `<span class="days late">quá hạn ${-n} ngày</span>`;
  if (n === 0) return '<span class="days late">hết hạn hôm nay</span>';
  return `<span class="days ${n <= 7 ? 'late' : n <= 15 ? 'soon' : 'ok'}">còn ${n} ngày</span>`;
}
const LEASE_STAGE = { reminded: '<span class="pill warn">đã nhắc khách</span>', leaving: '<span class="pill danger">khách sẽ ra</span>' };
/* các phòng của tòa đang mở sắp hết hạn (tính ngay trên máy, không cần gọi server) */
function leaseDue() {
  const lim = n0(S.settings.remind_days) || 30;
  return S.rooms.filter(r => r.move_out && ['Đang thuê', 'Sắp trống'].includes(r.status))
    .map(r => ({ ...r, days_left: daysBetween(r.move_out), building: UI.building, house: S.settings.house_name }))
    .filter(r => r.days_left <= lim).sort((a, b) => a.days_left - b.days_left);
}
function leaseItemHTML(n, showHouse) {
  return `<div class="lease-item"><div><b>${esc(n.code)}</b>${showHouse ? ` <span class="muted">· ${esc(n.house)}</span>` : ''} – ${esc(n.tenant || 'chưa có tên khách')}
    <div class="muted" style="font-size:13px">Hết hạn ${fmtDate(n.move_out)} • ${daysLabel(n.days_left)} ${LEASE_STAGE[n.lease_status] || ''}</div></div>
    <div class="actions"><button class="btn sm" data-act="leaseRemind" data-b="${esc(n.building)}" data-id="${n.id}">💬 Nhắc khách tái ký</button>
    <button class="btn sm" data-act="leaseRenew" data-b="${esc(n.building)}" data-id="${n.id}">✓ Đã tái ký</button>
    <button class="btn sm" data-act="leaseLeaving" data-b="${esc(n.building)}" data-id="${n.id}">🚪 Khách sẽ ra → báo Sales</button></div></div>`;
}
/* hành động trên phòng của tòa khác -> chuyển sang tòa đó trước */
async function inBuilding(b) { if (b && b !== UI.building) { $('#building').value = b; await switchBuilding(b); } }
const roomById = id => S.rooms.find(r => r.id === +id);
A.leaseRemind = async el => {
  await inBuilding(el.dataset.b); closeModal();
  const r = roomById(el.dataset.id), s = S.settings, left = daysBetween(r.move_out);
  const msg = String(s.renew_message || '').replace(/\{(\w+)\}/g, (m, k) => ({
    ten_khach: r.tenant || 'anh/chị', phong: r.code, ten_nha: s.house_name, ngay_het_han: fmtDate(r.move_out), con_lai: Math.max(0, left),
    han_tra_loi: fmtDate(isoAdd(today(), Math.max(1, Math.min(7, left - 1)))), lien_he: s.landlord_phone || s.phone || s.sales_contact || '' }[k] ?? m));
  const ph = phoneNorm(r.phone);
  openModal(`<h2>💬 Nhắc ${esc(r.code)} tái ký</h2><p class="muted">Hết hạn ${fmtDate(r.move_out)} • ${daysLabel(left)}. Sửa tin nhắn mẫu ở Cài đặt.</p>
    <textarea class="sales-text" id="rmMsg" style="min-height:140px;margin-top:10px">${esc(msg)}</textarea>
    ${ph ? '' : '<p class="pill warn" style="display:block;margin-top:8px">Phòng chưa có SĐT khách – copy tin nhắn để gửi cách khác.</p>'}
    <div class="foot"><button class="btn" data-act="close">Đóng</button><button class="btn" id="rmCopy">Copy tin nhắn</button>
    ${ph ? '<button class="btn primary" id="rmZalo">Copy & mở Zalo khách</button>' : ''}</div>`, body => {
    const done = async () => { await copyText($('#rmMsg').value); if (r.lease_status !== 'reminded' && can('rooms')) { const v = await api('PUT', '/api/rooms/' + r.id, { lease_status: 'reminded' }); Object.assign(r, v); refreshBell(); } };
    $('#rmCopy', body).onclick = async () => { await done(); toast('Đã copy – dán gửi khách'); };
    if (ph) $('#rmZalo', body).onclick = async () => { await done(); window.open('https://zalo.me/' + ph, '_blank'); toast('Đã copy – dán (Ctrl+V) vào Zalo', 4000); };
  });
};
A.leaseRenew = async el => {
  await inBuilding(el.dataset.b); closeModal();
  const r = roomById(el.dataset.id);
  openModal(`<h2>✓ ${esc(r.code)} tái ký</h2><p class="muted">Hết hạn cũ: ${fmtDate(r.move_out)}</p>
    <div class="form" style="margin-top:12px">${field('Gia hạn thêm', 'months', '12', { options: [['3', '3 tháng'], ['6', '6 tháng'], ['12', '12 tháng'], ['24', '24 tháng']] })}
    <div class="field"><label>Hết hạn mới</label><input id="rnNew" type="date"></div></div>
    <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn" id="rnContract">Lưu & tạo hợp đồng mới</button><button class="btn primary" id="rnSave">Lưu</button></div>`, body => {
    const sel = $('[name=months]', body), out = $('#rnNew', body);
    const upd = () => { out.value = isoAddMonths(r.move_out, +sel.value); }; sel.onchange = upd; upd();
    const save = async () => {
      const v = await api('PUT', '/api/rooms/' + r.id, { move_out: out.value, lease_status: '', status: 'Đang thuê', available_from: '' });
      Object.assign(r, v); refreshBell(); toast(`${r.code} gia hạn đến ${fmtDate(out.value)}`);
    };
    $('#rnSave', body).onclick = async () => { await save(); closeModal(); render(); };
    $('#rnContract', body).onclick = async () => { const start = isoAdd(r.move_out, 1); await save(); r.move_in_contract = start; A.newContract({ dataset: { id: r.id } }); };
  });
};
A.leaseLeaving = async el => {
  await inBuilding(el.dataset.b); closeModal();
  const r = roomById(el.dataset.id);
  if (!confirm(`${r.code}: khách sẽ trả phòng ngày ${fmtDate(r.move_out)}?\nPhòng sẽ chuyển sang "Sắp trống" (trống từ ${fmtDate(isoAdd(r.move_out, 1))}) và mở cho Sales.`)) return;
  const v = await api('PUT', '/api/rooms/' + r.id, { status: 'Sắp trống', available_from: isoAdd(r.move_out, 1), lease_status: 'leaving', listing: r.listing || 'shared' });
  Object.assign(r, v); refreshBell();
  shareSalesModal(r);
};

/* ---- chuông thông báo ---- */
let BELL = [];
let BELL_SEEN = null;
async function refreshBell() {
  try { BELL = await api('GET', '/api/notifications', undefined, undefined, true); } catch (_) { return; }
  const n = BELL.length; $('#bellN').textContent = n > 99 ? '99+' : n; $('#bellN').classList.toggle('hidden', !n);
  // khách: có bill mới -> thông báo của điện thoại (khi app đang mở / chạy nền và đã cho phép)
  if (ME.user && ME.user.kind === 'tenant') {
    const ids = new Set(BELL.map(x => x.bill_id));
    if (BELL_SEEN) {
      const fresh = BELL.filter(x => !BELL_SEEN.has(x.bill_id));
      if (fresh.length) {
        if (window.Notification && Notification.permission === 'granted') {
          try { new Notification('Hóa đơn tiền phòng mới', { body: fresh.map(x => `${x.house} – phòng ${x.room} ${pLabel(x.period)}`).join('\n'), icon: '/static/icons/icon-192.png' }); } catch (_) {}
        }
        toast(`🔔 Có ${fresh.length} hóa đơn mới`, 5000);
        if (typeof A.tenantReload === 'function' && document.body.classList.contains('tenant-mode')) A.tenantReload();
      }
    }
    BELL_SEEN = ids;
  }
}
A.enableNotify = async () => {
  if (!window.Notification) return toast('Trình duyệt này không hỗ trợ thông báo');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Đã bật thông báo hóa đơn mới' : 'Bạn chưa cho phép thông báo – bật lại trong cài đặt trình duyệt', 4000);
  vTenant();
};
A.myBills = async () => { closeModal(); TN = await api('GET', '/api/tenant'); vTenant(); };
A.openBell = async () => {
  await refreshBell();
  if (ME.user.kind === 'sales') {
    openModal(`<h2>🔔 Phòng mới được gửi cho bạn</h2>${BELL.length ? BELL.map(n => `<div class="lease-item"><div><b>${esc(n.room)}</b> · ${esc(n.house)} – ${shortMoney(n.price)}<div class="muted" style="font-size:12px">gửi lúc ${esc(String(n.at).slice(0, 16))}</div></div>
      <button class="btn sm primary" data-act="bellMarket" data-b="${esc(n.building)}" data-id="${n.room_id}">Xem</button></div>`).join('') : '<p class="muted" style="margin-top:12px">Chưa có phòng mới trong 7 ngày qua.</p>'}
      <div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
    return;
  }
  if (ME.user.kind === 'tenant') {
    openModal(`<h2>🔔 Hóa đơn chưa thanh toán</h2>${BELL.map(n => `<div class="lease-item"><div><b>${pLabel(n.period)}</b> · phòng ${esc(n.room)} – ${esc(n.house)}
      <div class="muted" style="font-size:12px">${n.reported ? 'đã báo chuyển khoản, chờ chủ xác nhận' : 'chưa thanh toán'}</div></div></div>`).join('') || '<p class="muted" style="margin-top:12px">Không có hóa đơn nào cần thanh toán. 🎉</p>'}
      <div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
    return;
  }
  const claims = BELL.filter(n => n.type === 'paid_claim'), leases = BELL.filter(n => n.type === 'lease');
  openModal(`${claims.length ? `<h2>💸 Khách báo đã chuyển khoản</h2><p class="muted">Kiểm tra tài khoản ngân hàng rồi xác nhận.</p>
    <div style="margin:8px 0 18px">${claims.map(n => `<div class="lease-item"><div><b>${esc(n.room_code)}</b> <span class="muted">· ${esc(n.house)}</span> – ${pLabel(n.period)}
      <div class="muted" style="font-size:12px">báo lúc ${esc(n.tenant_paid_at)}</div></div>
      <div class="actions"><button class="btn sm primary" data-act="confirmClaim" data-b="${esc(n.building)}" data-id="${n.id}">✓ Xác nhận đã thu</button></div></div>`).join('')}</div>` : ''}
    <h2>🔔 Hợp đồng sắp hết hạn</h2><p class="muted">Các tòa của bạn – nhắc trước ${n0(S.settings?.remind_days) || 30} ngày (đổi ở Cài đặt). Nhắc khách tái ký, ghi nhận tái ký, hoặc báo Sales khi khách sẽ ra.</p>
    <div style="margin-top:8px">${leases.map(n => leaseItemHTML(n, true)).join('') || '<p class="muted">Không có hợp đồng nào sắp hết hạn. 🎉</p>'}</div>
    <div class="foot"><button class="btn" data-act="close">Đóng</button></div>`);
};
A.bellMarket = el => { closeModal(); const i = MK.list.findIndex(x => x.building === el.dataset.b && x.room.id === +el.dataset.id); if (i >= 0) A.marketOpen({ dataset: { i } }); };

/* ================= DANH BẠ SALES & GỬI PHÒNG ================= */
let CONTACTS = [];
async function renderContacts() {
  const box = $('#contactsBox'); if (!box) return;
  CONTACTS = await api('GET', '/api/sales-contacts');
  box.innerHTML = `<div class="head" style="margin-bottom:8px"><div><h3>📒 Danh bạ Sales của bạn (${CONTACTS.length})</h3>
    <p>Dùng chung cho mọi tòa. Bấm <b>“📣 Gửi cho danh bạ Sales”</b> ở phòng: Sales có tài khoản app nhận ngay trong mục Tìm phòng + chuông thông báo; Sales chỉ có SĐT thì app copy tin đăng và mở Zalo lần lượt từng người.</p></div></div>
  <div class="table-wrap" style="margin-bottom:10px"><table><thead><tr><th>Tên</th><th>SĐT</th><th>Tài khoản app</th><th></th></tr></thead><tbody>
  ${CONTACTS.map(c => `<tr><td>${esc(c.name || '—')}</td><td>${esc(c.phone)}</td><td>${c.username ? `<span class="pill ok">@${esc(c.username)}</span>` : '<span class="muted">chưa có – gửi qua Zalo</span>'}</td>
    <td><button class="btn sm danger" data-act="delContact" data-id="${c.id}">Xóa</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Chưa có ai. Thêm Sales bên dưới.</td></tr>'}</tbody></table></div>
  <div class="form" id="ctAdd">${field('Tên', 'name', '', { ph: 'vd: Minh – môi giới Q3' })}${field('Số điện thoại', 'phone', '', { type: 'tel' })}
    <div class="field" style="justify-content:flex-end"><button class="btn primary" data-act="addContact">+ Thêm vào danh bạ</button></div></div>
  <p class="muted" style="font-size:12px;margin-top:6px">SĐT đã đăng ký app (loại Sales) thì tự gắn tài khoản. Sales đăng ký sau bằng đúng SĐT này cũng tự thấy các phòng đã gửi.</p>`;
}
A.addContact = async () => { CONTACTS = await api('POST', '/api/sales-contacts', formData($('#ctAdd'))); toast('Đã thêm'); renderContacts(); };
A.delContact = async el => { if (!confirm('Xóa Sales này khỏi danh bạ? Các phòng đã gửi cho họ (chế độ chia sẻ riêng) sẽ không còn hiện với họ.')) return; await api('DELETE', '/api/sales-contacts/' + el.dataset.id); renderContacts(); };
A.shareSalesRoom = el => shareSalesModal(roomById(el.dataset.id));
async function shareSalesModal(r) {
  CONTACTS = await api('GET', '/api/sales-contacts');
  if (!CONTACTS.length) {
    openModal(`<h2>📣 Gửi ${esc(r.code)} cho Sales</h2><p style="margin-top:10px">Danh bạ Sales đang trống. Thêm Sales ở tab <b>Gửi Sales</b> → mục Danh bạ Sales.</p>
      <div class="foot"><button class="btn" data-act="close">Đóng</button><button class="btn primary" data-act="goSalesTab">Mở danh bạ</button></div>`);
    return;
  }
  openModal(`<h2>📣 Gửi ${esc(r.code)} cho danh bạ Sales</h2>
    <p class="muted">${r.status === 'Đang thuê' ? '⚠ Phòng đang thuê – Sales chỉ thấy khi phòng chuyển sang Trống / Sắp trống. ' : ''}${r.listing === 'public' ? 'Phòng đang công khai cho mọi Sales.' : 'Phòng sẽ ở chế độ “chỉ Sales được gửi mới thấy”.'}</p>
    <div style="margin:10px 0"><label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" class="check" id="ctAll" checked> Chọn tất cả (${CONTACTS.length})</label></div>
    <div class="grid" style="gap:6px;max-height:40vh;overflow:auto">${CONTACTS.map(c => `<label class="room-item" style="cursor:pointer"><input type="checkbox" class="check ct-pick" value="${c.id}" checked>
      <span style="flex:1"><b>${esc(c.name || c.phone)}</b> <span class="muted">${esc(c.phone)}</span><br>${c.username ? '<span class="pill ok">nhận trong app</span>' : '<span class="pill muted">gửi qua Zalo</span>'}</span></label>`).join('')}</div>
    <div class="foot"><button class="btn" data-act="close">Hủy</button><button class="btn primary" id="ctSend">Gửi</button></div>`, body => {
    $('#ctAll', body).onchange = e => $$('.ct-pick', body).forEach(x => { x.checked = e.target.checked; });
    $('#ctSend', body).onclick = async () => {
      const ids = $$('.ct-pick', body).filter(x => x.checked).map(x => +x.value);
      if (!ids.length) return toast('Chọn ít nhất 1 Sales');
      const res = await api('POST', `/api/rooms/${r.id}/share-sales`, { contact_ids: ids });
      if (!r.listing) r.listing = 'shared';
      const inApp = res.sent.filter(c => c.has_account), zalo = res.sent.filter(c => !c.has_account && c.phone);
      const text = salesText(r);
      $('#modalBody').innerHTML = `<h2>📣 Đã gửi ${esc(r.code)}</h2>
        <p style="margin-top:10px">✓ <b>${inApp.length}</b> Sales có tài khoản đã nhận trong app (hiện ở Tìm phòng + chuông).</p>
        ${zalo.length ? `<p><b>${zalo.length}</b> Sales chỉ có SĐT – bấm từng người: app copy tin đăng và mở Zalo, bạn dán (Ctrl+V) và gửi. Ảnh: tải ở tab Gửi Sales.</p>
        <div class="grid" style="gap:6px;margin-top:8px">${zalo.map(c => `<div class="room-item"><span style="flex:1"><b>${esc(c.name || c.phone)}</b> <span class="muted">${esc(c.phone)}</span></span><button class="btn sm primary zl" data-ph="${esc(phoneNorm(c.phone))}">Copy & mở Zalo</button></div>`).join('')}</div>` : ''}
        <div class="foot"><button class="btn" data-act="close">Xong</button></div>`;
      $$('.zl').forEach(btn => btn.onclick = async () => { await copyText(text); window.open('https://zalo.me/' + btn.dataset.ph, '_blank'); btn.textContent = '✓ Đã mở'; btn.classList.remove('primary'); });
      if (UI.tab === 'sales') vSales();
    };
  });
}
A.goSalesTab = () => { closeModal(); goTab('sales'); };

/* ================= CHIA SẺ / SANG NHƯỢNG TÒA NHÀ ================= */
const inviteLink = tok => `${(ME.meta.lan && ME.meta.urls[0]) || location.origin}/?invite=${encodeURIComponent(tok)}`;
const scopeLabel = sc => !sc || !Object.keys(sc).length ? 'toàn bộ' : `${sc.months ? (sc.months === 1 ? 'doanh thu tháng gần nhất' : `doanh thu ${sc.months} tháng gần nhất`) : 'toàn bộ doanh thu'}${sc.pii ? ' + CCCD khách' : ''}`;
async function renderInvites(newTok) {
  const box = $('#invitesBox'); if (!box || !can('members')) { if (box) box.innerHTML = ''; return; }
  const list = await api('GET', '/api/invites');
  box.innerHTML = `<h3 style="margin-bottom:6px">🔗 Chia sẻ / sang nhượng tòa ${esc(UI.building)}</h3>
  <p class="muted" style="font-size:13px">Tạo link hoặc mã QR cho tài khoản chủ trọ khác. <b>Xem trước</b>: người nhận chỉ xem (mặc định doanh thu tháng gần nhất và toàn bộ thông tin phòng, giá, khách, chi phí), không sửa được. <b>Sang nhượng</b>: người nhận thành chủ trọ toàn quyền và bạn rời khỏi tòa.</p>
  <div class="form" id="invF" style="margin-top:10px">
    ${field('Mục đích', 'purpose', 'view', { options: [['view', 'Xem trước (người mua / đối tác)'], ['transfer', 'Sang nhượng toàn quyền']] })}
    ${field('Dữ liệu doanh thu', 'months', '1', { options: [['1', 'Tháng gần nhất (mặc định)'], ['3', '3 tháng gần nhất'], ['6', '6 tháng'], ['12', '12 tháng'], ['0', 'Toàn bộ']] })}
    ${field('Link hiệu lực', 'days', '7', { options: [['1', '1 ngày'], ['3', '3 ngày'], ['7', '7 ngày'], ['30', '30 ngày']] })}
    <label style="display:flex;gap:8px;align-items:center;align-self:end"><input type="checkbox" class="check" name="pii"> Kèm CCCD / hợp đồng của khách</label>
    <div class="field" style="justify-content:flex-end"><button class="btn primary" data-act="createInvite">Tạo link + QR</button></div></div>
  ${newTok ? `<div class="card invite-qr" style="margin-top:12px;border-color:var(--accent)"><img src="${qrDataUrl(inviteLink(newTok), 5)}" alt="QR">
    <div><b>Gửi link hoặc cho chủ kia quét mã:</b><p style="word-break:break-all;margin:6px 0"><code>${esc(inviteLink(newTok))}</code></p>
    <div class="actions"><button class="btn sm" data-act="copyInvite" data-l="${esc(inviteLink(newTok))}">Copy link</button></div>
    <p class="muted" style="font-size:12px;margin-top:6px">Chỉ dùng được 1 lần. Người nhận đăng nhập (hoặc đăng ký) tài khoản Chủ trọ rồi bấm Nhận. Link chỉ hiện 1 lần – hãy copy ngay.${ME.meta.lan ? '' : ' App đang ở chế độ chỉ máy này: người nhận phải dùng chung máy, hoặc chạy run-dienthoai.bat để mở qua Wi-Fi.'}</p></div></div>` : ''}
  <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Loại</th><th>Dữ liệu</th><th>Tạo bởi</th><th>Trạng thái</th><th></th></tr></thead><tbody>
  ${list.map(i => `<tr><td>${i.transfer ? '<span class="pill danger">Sang nhượng</span>' : '<span class="pill muted">Xem trước</span>'}</td><td>${i.transfer ? 'toàn quyền' : esc(scopeLabel(i.scope))}</td><td>${esc(i.by)}</td>
    <td>${i.used_by ? `✓ @${esc(i.used_by)} đã nhận` : i.expires * 1000 < Date.now() ? '<span class="muted">hết hạn</span>' : `còn hạn đến ${new Date(i.expires * 1000).toLocaleDateString('vi-VN')}`}</td>
    <td>${!i.used_by && i.expires * 1000 > Date.now() ? `<button class="btn sm danger" data-act="revokeInvite" data-id="${i.id}">Hủy link</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Chưa tạo link nào.</td></tr>'}</tbody></table></div>
  <p class="muted" style="font-size:12px;margin-top:6px">Người đã nhận “Xem trước” hiện trong bảng Thành viên (vai trò Chỉ xem) – xóa ở đó để thu hồi quyền xem.</p>`;
}
A.createInvite = async () => {
  const d = formData($('#invF'));
  if (d.purpose === 'transfer' && !confirm(`SANG NHƯỢNG tòa ${UI.building}: người nhận link sẽ thành chủ trọ toàn quyền và BẠN SẼ BỊ GỠ khỏi tòa này khi họ nhận. Tiếp tục tạo link?`)) return;
  const r = await api('POST', '/api/invites', d); renderInvites(r.token);
};
A.copyInvite = async el => { await copyText(el.dataset.l); toast('Đã copy link'); };
A.revokeInvite = async el => { await api('DELETE', '/api/invites/' + el.dataset.id); renderInvites(); };
async function checkInvite() {
  let tok = null;
  try { tok = sessionStorage.getItem('invite'); } catch (_) {}
  if (!tok) return false;
  let info;
  try { info = await api('GET', '/api/invite-info?token=' + encodeURIComponent(tok), undefined, undefined, true); }
  catch (e) { try { sessionStorage.removeItem('invite'); } catch (_) {} toast(e.message, 5000); return false; }
  openModal(`<h2>${info.transfer ? '🏠 Nhận sang nhượng tòa nhà' : '👀 Được mời xem tòa nhà'}</h2>
    <div class="card" style="margin-top:12px"><b>${esc(info.name)}</b> (${esc(info.building)}) – ${info.rooms} phòng<div class="muted">${esc(info.address || '')}</div>
    <div style="margin-top:6px">Người gửi: <b>${esc(info.by)}</b></div>
    <div>${info.transfer ? 'Bạn sẽ thành <b>chủ trọ toàn quyền</b>; người gửi rời khỏi tòa.' : `Bạn được <b>xem</b> (không sửa): ${esc(scopeLabel(info.scope))} và thông tin phòng, giá, chi phí.`}</div></div>
    ${ME.user.kind === 'sales' ? '<p class="pill danger" style="display:block;margin-top:10px">Tài khoản Sales không nhận được – đăng xuất và dùng tài khoản Chủ trọ.</p>' : ''}
    <div class="foot"><button class="btn" id="ivNo">Bỏ qua</button>${ME.user.kind !== 'sales' ? '<button class="btn primary" id="ivYes">Nhận</button>' : ''}</div>`, body => {
    const clear = () => { try { sessionStorage.removeItem('invite'); } catch (_) {} };
    $('#ivNo', body).onclick = () => { clear(); closeModal(); };
    const y = $('#ivYes', body);
    if (y) y.onclick = async () => {
      const r = await api('POST', '/api/invites/accept', { token: tok }); clear();
      try { localStorage.setItem('building', r.building); } catch (_) {}
      location.href = '/?b=' + encodeURIComponent(r.building) + '&tab=dashboard';
    };
  });
  return true;
}

/* ================= KHÁCH THUÊ ================= */
const appBase = () => (ME.meta && ME.meta.lan && ME.meta.urls[0]) || location.origin;
const roomQrUrl = tok => `${appBase()}/?room=${encodeURIComponent(tok)}`;
A.roomQr = el => {
  const r = roomById(el.dataset.id);
  openModal(`<h2>🔳 Mã QR phòng ${esc(r.code)}</h2>
    <div class="invite-qr" style="margin-top:12px"><img src="${qrDataUrl(roomQrUrl(r.access_token), 5)}" alt="QR"><div>
    <p>Khách (và người ở cùng phòng) <b>quét mã này</b> → đăng nhập hoặc đăng ký bằng SĐT → xem lịch sử hóa đơn của phòng từ ${r.move_in ? fmtDate(r.move_in) : 'tháng này'}.</p>
    <p class="muted" style="font-size:13px">Mã này cũng được in sẵn ở cuối mỗi bill. Mã tự hết hiệu lực khi phòng đổi khách (đổi ngày vào) hoặc chuyển sang Trống. Nếu lỡ gửi nhầm người, bấm “Đổi mã” – mọi mã cũ (kể cả trên bill đã gửi) không dùng được nữa.</p>
    <p style="word-break:break-all;font-size:12px"><code>${esc(roomQrUrl(r.access_token))}</code></p></div></div>
    <div class="foot"><button class="btn danger" data-act="rotateRoomQr" data-id="${r.id}" style="margin-right:auto">Đổi mã</button>
    <button class="btn" data-act="close">Đóng</button><button class="btn primary" data-act="copyRoomQr" data-l="${esc(roomQrUrl(r.access_token))}">Copy link</button></div>`);
};
A.copyRoomQr = async el => { await copyText(el.dataset.l); toast('Đã copy link – gửi cho khách'); };
A.rotateRoomQr = async el => {
  if (!confirm('Đổi mã QR phòng? Mã cũ in trên các bill đã gửi sẽ không dùng được nữa (người đã vào app trước đó vẫn xem được).')) return;
  const r = roomById(el.dataset.id), res = await api('POST', `/api/rooms/${r.id}/tenant-account`, { action: 'rotate-qr' });
  r.access_token = res.access_token; toast('Đã đổi mã QR phòng'); A.roomQr(el);
};
const linkOf = code => (S.tenant_links || []).find(l => l.room_code === code && l.active);

/* ---- phía chủ trọ: tài khoản app của khách (trong form phòng) ---- */
function tenantAccountHTML(r) {
  const l = linkOf(r.code);
  return `<div class="card" style="background:var(--surface-2)">
    ${r.access_token ? `<div class="actions" style="float:right"><button class="btn sm" data-act="roomQr" data-id="${r.id}" title="Mã QR in trên bill – khách quét để xem lịch sử hóa đơn">🔳 QR phòng</button></div>` : ''}
    ${l ? `<b>📱 @${esc(l.username)}</b> ${l.has_password ? '<span class="pill ok">khách đã kích hoạt</span>' : '<span class="pill warn">chưa quét QR đặt mật khẩu</span>'}
      <div class="muted" style="font-size:13px;margin:4px 0 8px">Khách xem hóa đơn từ ${pLabel(l.since_period)} trở đi trong app. Bill chỉ hiện với khách sau khi bạn bấm “Gửi bill qua app” ở tab Bill.</div>
      <div class="actions"><button class="btn sm" data-act="tenantQr" data-id="${r.id}" data-a="reset">${l.has_password ? 'Mã QR đặt lại mật khẩu' : 'Hiện lại mã QR'}</button>
      <button class="btn sm danger" data-act="tenantEnd" data-id="${r.id}">Ngắt (khách đã trả phòng)</button></div>`
    : `<b>📱 Khách chưa có tài khoản app</b><div class="muted" style="font-size:13px;margin:4px 0 8px">Tạo tài khoản theo SĐT của phòng${r.phone ? ` (<b>${esc(phoneNorm(r.phone))}</b>)` : ' – nhập SĐT trước'}. Khách quét mã QR để đặt mật khẩu, cài app lên màn hình chính, rồi nhận bill hằng tháng + lịch sử hóa đơn.</div>
      <button class="btn sm primary" data-act="tenantQr" data-id="${r.id}" data-a="create" ${r.phone ? '' : 'disabled'}>Tạo tài khoản + mã QR cho khách</button>`}</div>`;
}
A.tenantQr = async el => {
  const r = roomById(el.dataset.id);
  const res = await api('POST', `/api/rooms/${r.id}/tenant-account`, { action: el.dataset.a });
  S.tenant_links = (await api('GET', '/api/all')).tenant_links;
  showTenantQr(r, res);
};
function showTenantQr(r, res, auto) {
  const tok = res.setup_token, url = tok ? `${appBase()}/?setup=${encodeURIComponent(tok)}` : `${appBase()}/`;
  const uname = res.username || linkOf(r.code)?.username || phoneNorm(r.phone);  // tên đăng nhập thật của khách
  const msg = tok ? `Chào ${r.tenant || 'anh/chị'}, ${S.settings.house_name} gửi tài khoản xem hóa đơn phòng ${r.code}.\nBấm link (hoặc quét mã QR) để đặt mật khẩu: ${url}\nTên đăng nhập là SĐT của anh/chị: ${uname}. Sau đó chọn "Thêm vào màn hình chính" để dùng như app.`
    : `Chào ${r.tenant || 'anh/chị'}, phòng ${r.code} đã được gắn vào tài khoản app của anh/chị (SĐT ${uname}). Đăng nhập tại ${url} để xem hóa đơn hằng tháng.`;
  openModal(`<h2>📱 Tài khoản app – ${esc(r.code)}</h2>
    ${auto ? `<p class="pill ok" style="display:block;white-space:normal;margin-top:8px">✓ Đã lưu phòng và tự tạo tài khoản app cho khách theo SĐT ${esc(res.username)}. Gửi mã QR này để khách kích hoạt.</p>` : ''}
    ${tok ? `<div class="invite-qr" style="margin-top:12px"><img src="${qrDataUrl(url, 5)}" alt="QR"><div>
      <p><b>Khách quét mã này</b> bằng camera điện thoại → đặt mật khẩu → vào app.</p>
      <p class="muted" style="font-size:13px">Tên đăng nhập: <b>${esc(uname)}</b>. Mã dùng 1 lần, hạn 14 ngày. Sau khi vào, khách chọn menu trình duyệt → <i>Thêm vào màn hình chính</i> để có biểu tượng app.</p>
      <p style="word-break:break-all;font-size:12px"><code>${esc(url)}</code></p></div></div>`
    : `<p style="margin-top:12px">✓ SĐT này đã có tài khoản app (khách từng thuê ở đây hoặc tòa khác) – đã gắn thêm phòng ${esc(r.code)}. Khách đăng nhập như cũ.</p>`}
    ${ME.meta.lan ? '' : '<p class="pill warn" style="display:block;white-space:normal;margin-top:10px">App đang chạy chế độ chỉ máy này – điện thoại khách chưa mở được link. Chạy run-dienthoai.bat (cùng Wi-Fi) hoặc đưa app lên mạng.</p>'}
    <textarea class="sales-text" id="tqMsg" style="min-height:110px;margin-top:10px">${esc(msg)}</textarea>
    <div class="foot"><button class="btn" data-act="close">Đóng</button><button class="btn" id="tqCopy">Copy tin nhắn</button>
    ${phoneNorm(uname) ? '<button class="btn primary" id="tqZalo">Copy & mở Zalo khách</button>' : ''}</div>`, body => {
    $('#tqCopy', body).onclick = async () => { await copyText($('#tqMsg').value); toast('Đã copy'); };
    const z = $('#tqZalo', body); if (z) z.onclick = async () => { await copyText($('#tqMsg').value); window.open('https://zalo.me/' + phoneNorm(uname), '_blank'); toast('Đã copy – dán vào Zalo'); };
  });
}
A.tenantEnd = async el => {
  const r = roomById(el.dataset.id);
  if (!confirm(`Ngắt tài khoản app của khách phòng ${r.code}? Khách vẫn xem được các hóa đơn trong thời gian đã ở, nhưng không nhận bill mới.`)) return;
  await api('POST', `/api/rooms/${r.id}/tenant-account`, { action: 'end' });
  S.tenant_links = (await api('GET', '/api/all')).tenant_links; A.editRoom({ dataset: { id: r.id } });
};

/* ---- gửi bill qua app ---- */
A.publishBill = async el => {
  const ids = el.dataset.ids.split(',').map(Number);
  const r = await api('POST', '/api/bills/publish', { ids });
  ids.forEach(id => { const b = S.bills.find(x => x.id === id); if (b) b.published_at = r.published_at; });
  toast(`Đã gửi ${r.count} bill qua app – khách thấy ngay trong app`); vBill();
};
A.confirmClaim = async el => {
  await inBuilding(el.dataset.b);
  const b = S.bills.find(x => x.id === +el.dataset.id);
  const v = await api('PUT', '/api/bills/' + b.id, { paid: 1, paid_date: today() }); Object.assign(b, v);
  toast(`${b.room_code}: đã xác nhận thu`); closeModal(); refreshBell(); render();
};

/* ---- khách quét QR: đặt mật khẩu ---- */
async function showSetup(tok) {
  document.body.classList.add('locked');
  let info;
  try { info = await (await fetch('/api/setup-info?token=' + encodeURIComponent(tok))).json(); } catch (_) { info = {}; }
  view.innerHTML = `<div class="login card"><div style="text-align:center"><div class="logo" style="display:inline-grid;width:48px;height:48px;font-size:26px;border-radius:12px">⌂</div>
    <h2 style="margin-top:10px">Kích hoạt tài khoản</h2></div>
    ${info.error ? `<p class="pill danger" style="display:block;white-space:normal;margin-top:12px">${esc(info.error)}</p><p class="muted">Nếu đã có mật khẩu, <a href="/">đăng nhập tại đây</a>.</p>` : `
    <p class="muted" style="margin:10px 0">Xin chào ${esc(info.name || '')}! Tên đăng nhập của bạn: <b>${esc(info.username)}</b>. Đặt mật khẩu để xem hóa đơn hằng tháng.</p>
    <form id="setF" class="grid" style="gap:10px"><div class="field"><label>Mật khẩu mới (tối thiểu 6 ký tự)</label><input name="password" type="password" autocomplete="new-password" required></div>
    <div class="field"><label>Nhập lại mật khẩu</label><input name="password2" type="password" autocomplete="new-password" required></div>
    <button class="btn primary" style="justify-content:center;padding:12px" type="submit">Kích hoạt & vào app</button></form>`}</div>`;
  const f = $('#setF'); if (!f) return;
  f.onsubmit = async e => {
    e.preventDefault(); const d = formData(f);
    if (d.password !== d.password2) return toast('Mật khẩu nhập lại không khớp');
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tok, password: d.password }) });
    const j = await r.json(); if (!r.ok) return toast(j.error || 'Lỗi', 4000);
    location.href = '/?installed=1';
  };
}

/* ---- giao diện khách thuê ---- */
let TN = [];
const tenantBillHTML = (t, b) => withData({ settings: t.settings, rooms: [t.room], extras: t.extras, bills: t.bills }, () => billHTML(b));
async function startTenant() {
  document.body.classList.add('tenant-mode');
  $('.brand').insertAdjacentHTML('beforeend', '<b style="font-size:16px">Hóa đơn của tôi</b>');
  TN = await api('GET', '/api/tenant');
  vTenant(new URLSearchParams(location.search).get('installed'));
}
function vTenant(justInstalled) {
  const st = b => b.paid ? '<span class="pill ok">Đã thanh toán</span>' : b.tenant_paid_at ? '<span class="pill warn">Đã báo chuyển khoản – chờ chủ xác nhận</span>' : '<span class="pill danger">Chưa thanh toán</span>';
  view.innerHTML = `<div class="head"><div><h2>Xin chào ${esc(ME.user.name || ME.user.username)}</h2><p>Hóa đơn tiền phòng hằng tháng do chủ trọ gửi qua app.</p></div>
    <div class="actions"><button class="btn" data-act="tenantReload">↻ Làm mới</button><button class="btn" data-act="account">Tài khoản</button></div></div>
    ${justInstalled ? `<div class="card" style="border-color:var(--accent);background:var(--accent-soft);margin-bottom:14px"><b>✓ Đã kích hoạt!</b> Để dùng như app: mở menu trình duyệt (⋮ hoặc nút Chia sẻ trên iPhone) → <b>Thêm vào màn hình chính</b>.</div>` : ''}
    ${window.Notification && Notification.permission === 'default' && window.isSecureContext ? `<div class="card" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="flex:1">Nhận thông báo khi chủ trọ gửi hóa đơn mới?</span><button class="btn primary sm" data-act="enableNotify">🔔 Bật thông báo</button></div>` : ''}
    ${TN.length ? TN.map((t, ti) => {
      const cur = t.bills[0], s = t.settings, ph = phoneNorm(t.owner.phone);
      return `<div class="card" style="margin-bottom:14px"><div class="head" style="margin-bottom:8px"><div><h3>Phòng ${esc(t.room.code)} · ${esc(s.house_name)} ${t.active ? '' : '<span class="pill muted">đã trả phòng</span>'}</h3>
        <p>📍 ${esc(s.address || '')}${t.room.move_out && t.active ? ` • Hợp đồng đến ${fmtDate(t.room.move_out)}` : ''}${!t.active && t.until ? ` • Đã ở ${pLabel(t.since)} – ${pLabel(t.until)}` : ''}</p></div>
        ${ph ? `<div class="actions"><a class="btn sm" href="tel:${ph}">📞 Gọi chủ trọ</a><a class="btn sm" href="https://zalo.me/${ph}" target="_blank" rel="noopener">Zalo</a></div>` : ''}</div>
        ${cur ? `<div class="bill-layout" style="grid-template-columns:1fr"><div id="tb-${ti}">${tenantBillHTML(t, cur)}</div></div>
          <div class="actions" style="justify-content:center;margin-top:10px">${st(cur)}
          ${!cur.paid && !cur.tenant_paid_at ? `<button class="btn primary" data-act="tenantPaid" data-t="${ti}" data-id="${cur.id}">✓ Tôi đã chuyển khoản</button>` : ''}
          <button class="btn" data-act="tenantSaveImg" data-t="${ti}" data-id="${cur.id}">Lưu ảnh hóa đơn</button></div>`
        : '<p class="muted">Chưa có hóa đơn nào được gửi.</p>'}
        ${t.bills.length > 1 ? `<h3 class="section-title">Hóa đơn các tháng trước</h3><div class="table-wrap"><table><thead><tr><th>Kỳ</th><th class="num">Tổng</th><th>Trạng thái</th><th></th></tr></thead><tbody>
          ${t.bills.slice(1).map(b => `<tr><td>${pLabel(b.period)}</td><td class="num"><b>${money(withData({ settings: s, extras: t.extras }, () => calc(b)).total)}</b></td><td>${st(b)}</td>
          <td><button class="btn sm" data-act="tenantView" data-t="${ti}" data-id="${b.id}">Xem</button></td></tr>`).join('')}</tbody></table></div>` : ''}</div>`;
    }).join('') : '<div class="card empty">Chưa có phòng nào gắn với tài khoản này.<br>Quét <b>mã QR in ở cuối bill</b> (hoặc mã chủ trọ gửi) bằng camera điện thoại để thêm phòng của bạn.</div>'}`;
}
A.tenantReload = async () => { TN = await api('GET', '/api/tenant'); vTenant(); refreshBell(); };
const tenantBill = el => { const t = TN[+el.dataset.t]; return [t, t.bills.find(b => b.id === +el.dataset.id)]; };
A.tenantView = el => {
  const [t, b] = tenantBill(el);
  openModal(`${tenantBillHTML(t, b)}<div class="foot"><button class="btn" data-act="close">Đóng</button>
    ${!b.paid && !b.tenant_paid_at ? `<button class="btn primary" data-act="tenantPaid" data-t="${el.dataset.t}" data-id="${b.id}">✓ Tôi đã chuyển khoản</button>` : ''}</div>`);
};
A.tenantPaid = async el => {
  const [t, b] = tenantBill(el);
  if (!confirm(`Xác nhận bạn đã chuyển khoản hóa đơn ${pLabel(b.period)}? Chủ trọ sẽ được báo để kiểm tra.`)) return;
  await api('POST', '/api/tenant/report-paid', { building: t.building, bill_id: b.id });
  toast('Đã báo chủ trọ. Cảm ơn bạn!'); closeModal(); A.tenantReload();
};
A.tenantSaveImg = async el => {
  const [t, b] = tenantBill(el);
  const box = $(`#tb-${el.dataset.t} .bill-paper`);
  const cv = await html2canvas(box, { scale: 2, backgroundColor: '#ffffff', logging: false });
  downloadBlob(await canvasBlob(cv), `HoaDon_${t.room.code}_T${pM(b.period)}-${pY(b.period)}.png`);
};

/* ---------------- start ---------------- */
(async function start() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // khách quét QR kích hoạt tài khoản
  const setup = new URLSearchParams(location.search).get('setup');
  if (setup) { history.replaceState(null, '', '/'); return showSetup(setup); }
  // khách quét QR phòng (in trên bill / chủ gửi): giữ mã qua bước đăng nhập / đăng ký
  const rq = new URLSearchParams(location.search).get('room');
  if (rq) { try { sessionStorage.setItem('roomclaim', rq); } catch (_) {} history.replaceState(null, '', '/'); }
  if (pendingClaim()) {
    try {
      const r = await fetch('/api/room-claim-info?token=' + encodeURIComponent(pendingClaim()));
      const j = await r.json();
      if (r.ok) CLAIM_INFO = j; else { try { sessionStorage.removeItem('roomclaim'); } catch (_) {} toast(j.error || 'Mã QR không hợp lệ', 6000); }
    } catch (_) {}
  }
  // link / QR chia sẻ tòa nhà: giữ mã mời qua bước đăng nhập / đăng ký
  const inv = new URLSearchParams(location.search).get('invite');
  if (inv) { try { sessionStorage.setItem('invite', inv); } catch (_) {} history.replaceState(null, '', '/'); }
  let pendingInvite = false; try { pendingInvite = !!sessionStorage.getItem('invite'); } catch (_) {}
  const st = await (await fetch('/api/auth-status')).json();
  if (!st.user) return showLogin(pendingInvite ? 'Bạn được chia sẻ một tòa nhà. Đăng nhập hoặc đăng ký tài khoản Chủ trọ để nhận.'
    : st.first ? 'Chào mừng! Tạo tài khoản đầu tiên – tài khoản này sẽ là chủ trọ của các tòa nhà đang có.' : '', st.first ? 'register' : CLAIM_INFO ? 'register' : 'login');
  ME.user = st.user;
  // đã đăng nhập + có mã QR phòng -> gắn phòng vào tài khoản để xem lịch sử hóa đơn
  let claimed = null;
  if (CLAIM_INFO) {
    try { claimed = await api('POST', '/api/room-claim', { token: pendingClaim() }); toast(`✓ Đã thêm phòng ${claimed.room} – ${claimed.house} vào tài khoản`, 5000); }
    catch (_) {}
    try { sessionStorage.removeItem('roomclaim'); } catch (_) {}
  }
  ME.meta = await api('GET', '/api/meta');
  $('#accountBtn').textContent = (ME.user.name || ME.user.username).trim().charAt(0).toUpperCase();
  $('#accountBtn').title = `${ME.user.name} (@${ME.user.username})`;
  refreshBell(); setInterval(refreshBell, 5 * 60 * 1000);
  if (ME.user.kind === 'sales') { await startSales(); if (claimed) return A.myBills(); return checkInvite(); }
  if (ME.user.kind === 'tenant') { await startTenant(); history.replaceState(null, '', '/'); return; }
  try { UI.building = new URLSearchParams(location.search).get('b') || localStorage.getItem('building'); } catch (_) {}
  await loadBuildings();
  if (await checkInvite()) { if (!UI.building) return; }
  if (!UI.building) {
    if (claimed || ME.meta.my_rooms) return A.myBills();  // chủ trọ chưa có tòa nhưng đang thuê phòng
    view.innerHTML = `<div class="card empty" style="max-width:520px;margin:40px auto"><h2>Xin chào ${esc(ME.user.name)}!</h2>
    <p>Bạn chưa thuộc tòa nhà nào.</p><p>• Nếu bạn là <b>chủ trọ</b>: tạo tòa nhà của mình.<br>• Nếu bạn là <b>quản lý / người xem</b>: gửi SĐT <b>${esc(ME.user.username)}</b> cho chủ trọ để được thêm vào.</p>
    <div class="actions" style="justify-content:center;margin-top:12px"><button class="btn primary" data-act="newBuilding">+ Tạo tòa nhà</button><button class="btn" data-act="account">Tài khoản</button></div></div>`;
    return;
  }
  await load();
  const latest = latestPeriod();
  UI.period = latest || pNow();
  $('#period').value = pToInput(UI.period);
  try { const t = localStorage.getItem('tab'); if (t) UI.tab = t; } catch (_) {}
  const qt = new URLSearchParams(location.search).get('tab'); if (qt) UI.tab = qt;
  goTab(UI.tab);
  if (claimed) return A.myBills();  // vừa quét QR phòng mình thuê -> mở hóa đơn
  // giống Excel: sang tháng mới mà chưa có kỳ thì hỏi tạo
  if (latest && pNow() > latest && can('bills')) A.createPeriod({ dataset: { p: String(pNow()) } });
})();
