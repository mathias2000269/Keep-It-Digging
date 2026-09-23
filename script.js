const config = window.KID_CONFIG || {};
const backendReady = config.supabaseUrl?.startsWith('https://') && !config.supabaseAnonKey?.startsWith('PEGA_');
const db = backendReady && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const money = value => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const statusNames = { pending:'Pendiente', preparing:'Preparando', ready:'Listo', completed:'Completado', cancelled:'Cancelado' };
const roleNames = { customer:'Cliente', worker:'Trabajador', admin:'Administrador' };
const hiddenLoginEmail = username => `${normalizeUsername(username)}@users.keepitdigging.invalid`;
function normalizeUsername(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 24);
}
const defaultProducts = [
  { id:1, name:'Hierro', price:85, category:'Metal industrial', image_url:'assets/logo.png', description:'Resistente, versátil y preparado para cualquier proyecto.' },
  { id:2, name:'Cobre', price:120, category:'Metal conductor', image_url:'assets/logo.png', description:'Perfecto para cableado, componentes y encargos especiales.' },
  { id:3, name:'Carbón', price:65, category:'Combustible mineral', image_url:'assets/logo.png', description:'Negro, fiable y disponible en grandes cantidades.' },
  { id:4, name:'Oro', price:480, category:'Metal precioso', image_url:'assets/logo.png', description:'Brilla, pesa y siempre conserva su valor.' },
  { id:5, name:'Plata', price:310, category:'Metal precioso', image_url:'assets/logo.png', description:'Elegante, limpia y seleccionada a mano.' },
  { id:6, name:'Diamante', price:950, category:'Gema premium', image_url:'assets/logo.png', description:'Difícil de encontrar e imposible de ignorar.' }
];
let currentSession = null;
let currentProfile = null;
let products = [];
let cart = JSON.parse(localStorage.getItem('kid-cart') || '[]');
let staffOrders = [];
let activeOrderFilter = 'all';
let inquiries = [];
let activeInquiryFilter = 'all';

function toast(message, error = false) {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = `toast${error ? ' is-error' : ''}`;
  element.textContent = message;
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}

function initNavigation() {
  const menuButton = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.main-nav');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    nav?.classList.toggle('is-open', !open);
  });
  const page = document.body.dataset.page;
  document.querySelectorAll('.main-nav a').forEach(link => {
    const href = link.getAttribute('href');
    if ((page === 'inicio' && href === 'index.html') || href === `${page}.html`) link.setAttribute('aria-current', 'page');
  });
  document.querySelectorAll('.account-button').forEach(button => {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21a8 8 0 0 1 16 0" fill="currentColor"/></svg>';
    button.addEventListener('click', showAccountMenu);
  });
}

function initCarousel() {
  const slides = [...document.querySelectorAll('.carousel-slide')];
  const dots = [...document.querySelectorAll('.carousel-dots button')];
  if (!slides.length) return;
  let current = 0;
  let timer;
  const show = index => {
    slides[current]?.classList.remove('is-active'); dots[current]?.classList.remove('is-active');
    current = index; slides[current]?.classList.add('is-active'); dots[current]?.classList.add('is-active');
  };
  const start = () => {
    if (slides.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    clearInterval(timer); timer = setInterval(() => show((current + 1) % slides.length), 5000);
  };
  dots.forEach((dot, index) => dot.addEventListener('click', () => { show(index); start(); }));
  start();
}

async function loadSession() {
  if (!db) return;
  const { data } = await db.auth.getSession();
  currentSession = data.session;
  if (currentSession) {
    const { data: profile } = await db.from('profiles').select('*').eq('id', currentSession.user.id).single();
    currentProfile = profile;
  }
  updateRoleUI();
  db.auth.onAuthStateChange((_event, session) => { currentSession = session; if (!session) currentProfile = null; updateRoleUI(); });
}

function updateRoleUI() {
  const staff = ['worker', 'admin'].includes(currentProfile?.role);
  document.querySelectorAll('.staff-link').forEach(link => link.hidden = !staff);
}

function showAccountMenu(event) {
  event.stopPropagation();
  document.querySelector('.account-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  if (currentSession && currentProfile) {
    menu.innerHTML = `<strong>${escapeHTML(currentProfile.full_name || 'Mi cuenta')}</strong><small>@${escapeHTML(currentProfile.username)}</small><a href="cuenta.html">Mi perfil y pedidos</a>${['worker','admin'].includes(currentProfile.role) ? '<a href="panel.html">Panel interno</a>' : ''}<button type="button" data-signout>Cerrar sesión</button>`;
    menu.querySelector('[data-signout]').addEventListener('click', async () => { await db.auth.signOut(); location.href = 'index.html'; });
  } else {
    menu.innerHTML = `<strong>Zona de usuario</strong><small>${backendReady ? 'Accede para realizar pedidos' : 'Falta conectar Supabase'}</small><a href="cuenta.html">Iniciar sesión</a><a href="cuenta.html?registro=1">Crear cuenta</a>`;
  }
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once:true }), 0);
}

async function loadProducts(includeInactive = false) {
  if (!db) { products = defaultProducts; return products; }
  let query = db.from('products').select('*').order('id');
  if (!includeInactive) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) { toast('No se pudo cargar el catálogo.', true); products = defaultProducts; }
  else products = data;
  return products;
}

async function initCatalog() {
  const grid = document.querySelector('#product-grid');
  if (!grid) return;
  await loadProducts();
  grid.innerHTML = products.map((product, index) => `<article class="product-card"><div class="product-image"><img src="${escapeHTML(product.image_url || 'assets/logo.png')}" alt="${escapeHTML(product.name)}"><span>${String(index + 1).padStart(2, '0')}</span></div><div class="product-body"><div><p class="product-type">${escapeHTML(product.category)}</p><h2>${escapeHTML(product.name)}</h2><p>${escapeHTML(product.description)}</p></div><div class="product-actions"><strong class="product-price">${money(product.price)}</strong><button class="add-cart-button" type="button" data-add-product="${product.id}">Añadir al carro</button></div></div></article>`).join('');
  grid.addEventListener('click', event => {
    const button = event.target.closest('[data-add-product]');
    if (!button) return;
    const product = products.find(item => String(item.id) === button.dataset.addProduct);
    addToCart(product);
  });
  createCartDrawer();
}

function saveCart() {
  localStorage.setItem('kid-cart', JSON.stringify(cart));
  document.querySelectorAll('.cart-count').forEach(element => element.textContent = cart.reduce((sum, item) => sum + item.quantity, 0));
  renderCart();
}

function addToCart(product) {
  const existing = cart.find(item => String(item.id) === String(product.id));
  if (existing) existing.quantity += 1;
  else cart.push({ id:product.id, name:product.name, price:Number(product.price), quantity:1 });
  saveCart(); openCart(); toast(`${product.name} añadido al carrito.`);
}

function createCartDrawer() {
  if (document.querySelector('.cart-drawer')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="drawer-backdrop"></div><aside class="cart-drawer" aria-label="Carrito" aria-hidden="true"><div class="drawer-heading"><h2>Tu carrito</h2><button class="drawer-close" type="button" aria-label="Cerrar carrito">×</button></div><div class="cart-items"></div><div class="cart-checkout"><div class="cart-total"><span>Total</span><strong>$0</strong></div><div class="cart-customer-fields"><input id="checkout-name" type="text" placeholder="Nombre completo" aria-label="Nombre completo"><input id="checkout-phone" type="tel" inputmode="numeric" pattern="[0-9]+" placeholder="Teléfono" aria-label="Teléfono"><textarea id="checkout-notes" rows="2" placeholder="Notas o lugar de entrega" aria-label="Notas"></textarea></div><button class="submit-button checkout-button" type="button">Confirmar compra <span>↗</span></button></div></aside>`);
  document.querySelectorAll('.cart-button').forEach(button => button.addEventListener('click', openCart));
  document.querySelector('.drawer-close').addEventListener('click', closeCart);
  document.querySelector('.drawer-backdrop').addEventListener('click', closeCart);
  document.querySelector('.checkout-button').addEventListener('click', checkout);
  document.querySelector('.cart-items').addEventListener('click', changeCartFromClick);
  document.querySelector('.cart-items').addEventListener('change', changeCartFromInput);
  saveCart();
}

function openCart() {
  document.querySelector('.cart-drawer')?.classList.add('is-open');
  document.querySelector('.drawer-backdrop')?.classList.add('is-open');
  document.querySelector('.cart-drawer')?.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  if (currentProfile) {
    document.querySelector('#checkout-name').value ||= currentProfile.full_name || '';
    document.querySelector('#checkout-phone').value ||= currentProfile.phone || '';
  }
}

function closeCart() {
  document.querySelector('.cart-drawer')?.classList.remove('is-open');
  document.querySelector('.drawer-backdrop')?.classList.remove('is-open');
  document.querySelector('.cart-drawer')?.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function renderCart() {
  const container = document.querySelector('.cart-items');
  if (!container) return;
  if (!cart.length) container.innerHTML = '<p class="empty-cart">Tu carrito todavía está vacío.</p>';
  else container.innerHTML = cart.map(item => `<article class="cart-item"><div><h3>${escapeHTML(item.name)}</h3><p>${money(item.price)} por unidad</p></div><strong class="cart-item-price">${money(item.price * item.quantity)}</strong><div class="quantity-control"><button type="button" data-cart-action="minus" data-id="${item.id}">−</button><input type="number" min="1" step="1" value="${item.quantity}" data-cart-quantity="${item.id}" aria-label="Cantidad de ${escapeHTML(item.name)}"><button type="button" data-cart-action="plus" data-id="${item.id}">+</button><button class="remove-cart" type="button" data-cart-action="remove" data-id="${item.id}">Eliminar</button></div></article>`).join('');
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  document.querySelector('.cart-total strong').textContent = money(total);
}

function changeCartFromClick(event) {
  const button = event.target.closest('[data-cart-action]');
  if (!button) return;
  const index = cart.findIndex(item => String(item.id) === button.dataset.id);
  if (index < 0) return;
  if (button.dataset.cartAction === 'plus') cart[index].quantity += 1;
  if (button.dataset.cartAction === 'minus') cart[index].quantity = Math.max(1, cart[index].quantity - 1);
  if (button.dataset.cartAction === 'remove') cart.splice(index, 1);
  saveCart();
}

function changeCartFromInput(event) {
  if (!event.target.matches('[data-cart-quantity]')) return;
  const item = cart.find(entry => String(entry.id) === event.target.dataset.cartQuantity);
  if (item) item.quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
  saveCart();
}

async function checkout() {
  if (!cart.length) return toast('Añade algún producto antes de comprar.', true);
  if (!db) return toast('Primero conecta el proyecto con Supabase.', true);
  if (!currentSession) { localStorage.setItem('kid-return', 'productos.html?carrito=1'); location.href = 'cuenta.html'; return; }
  const customerName = document.querySelector('#checkout-name').value.trim();
  const phone = document.querySelector('#checkout-phone').value.trim();
  const notes = document.querySelector('#checkout-notes').value.trim();
  if (!customerName) return toast('Escribe tu nombre.', true);
  if (!/^[0-9]{5,15}$/.test(phone)) return toast('El teléfono debe contener solo entre 5 y 15 números.', true);
  const button = document.querySelector('.checkout-button'); button.disabled = true; button.textContent = 'Enviando…';
  const items = cart.map(item => ({ product_id:Number(item.id), quantity:item.quantity }));
  const { error } = await db.rpc('place_order', { p_customer_name:customerName, p_phone:phone, p_notes:notes, p_items:items });
  button.disabled = false; button.innerHTML = 'Confirmar compra <span>↗</span>';
  if (error) return toast(error.message || 'No se pudo enviar el pedido.', true);
  cart = []; saveCart(); closeCart(); toast('Pedido realizado con éxito.');
}

function initAuthTabs() {
  const tabs = document.querySelectorAll('.auth-tab');
  tabs.forEach(tab => tab.addEventListener('click', () => {
    tabs.forEach(item => item.classList.toggle('is-active', item === tab));
    document.querySelector('#login-form').hidden = tab.dataset.authTab !== 'login';
    document.querySelector('#register-form').hidden = tab.dataset.authTab !== 'register';
  }));
  const registerForm = document.querySelector('#register-form');
  const preview = document.querySelector('#username-preview');
  const updatePreview = () => {
    const fullName = registerForm?.elements.full_name.value || '';
    const selected = registerForm?.elements.username.value || fullName;
    const normalized = normalizeUsername(selected);
    if (preview) preview.textContent = normalized ? `Tu usuario será @${normalized}` : 'Podrás iniciar sesión con este nombre.';
  };
  registerForm?.elements.full_name.addEventListener('input', updatePreview);
  registerForm?.elements.username.addEventListener('input', updatePreview);
  if (new URLSearchParams(location.search).get('registro')) document.querySelector('[data-auth-tab="register"]')?.click();
}

async function initAccountPage() {
  if (!document.querySelector('.account-page')) return;
  initAuthTabs();
  if (!db) { document.querySelector('#auth-message').textContent = 'Antes debes configurar Supabase en config.js.'; return; }
  if (currentSession) return showProfile();
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const username = normalizeUsername(form.get('username'));
    const { error } = await db.auth.signInWithPassword({ email:hiddenLoginEmail(username), password:form.get('password') });
    if (error) return setAuthMessage('Usuario o contraseña incorrectos.');
    const destination = localStorage.getItem('kid-return'); localStorage.removeItem('kid-return');
    location.href = destination || 'cuenta.html';
  });
  document.querySelector('#register-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const fullName = form.get('full_name').trim();
    const username = normalizeUsername(form.get('username') || fullName);
    const phone = form.get('phone').trim();
    const password = form.get('password');
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) return setAuthMessage('El usuario debe tener entre 3 y 24 caracteres válidos.');
    setAuthMessage('Creando la cuenta…');
    const { data, error } = await db.functions.invoke('register-user', { body:{ fullName, username, phone, password } });
    if (error || data?.error) {
      let message = data?.error || 'No se pudo crear la cuenta.';
      if (error?.context) {
        try { message = (await error.context.json()).error || message; } catch {}
      }
      return setAuthMessage(message);
    }
    const login = await db.auth.signInWithPassword({ email:hiddenLoginEmail(username), password });
    if (login.error) return setAuthMessage(`Cuenta creada. Tu usuario es @${username}. Ya puedes iniciar sesión.`);
    setAuthMessage(`Cuenta creada. Tu usuario es @${username}.`);
    const destination = localStorage.getItem('kid-return'); localStorage.removeItem('kid-return');
    setTimeout(() => { location.href = destination || 'cuenta.html'; }, 700);
  });
}

function setAuthMessage(message) { const target = document.querySelector('#auth-message'); if (target) target.textContent = message; }

async function showProfile() {
  document.querySelector('#auth-view').hidden = true;
  document.querySelector('#profile-view').hidden = false;
  document.querySelector('#profile-name').textContent = currentProfile?.full_name || 'Bienvenido';
  document.querySelector('#profile-role').textContent = `${roleNames[currentProfile?.role] || 'Cliente'} · @${currentProfile?.username || ''}`;
  document.querySelector('#logout-button').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
  const { data: orders } = await db.from('orders').select('*, order_items(*)').eq('user_id', currentSession.user.id).order('created_at', { ascending:false });
  const orderTarget = document.querySelector('#my-orders');
  if (orders?.length) orderTarget.innerHTML = orders.map(order => `<article class="mini-order"><div><strong>${new Date(order.created_at).toLocaleDateString('es-ES')}</strong><span>${order.order_items.map(item => `${item.quantity}× ${escapeHTML(item.product_name)}`).join(', ')}</span></div><div><strong>${money(order.total)}</strong><span class="status-badge status-${order.status}">${statusNames[order.status]}</span></div></article>`).join('');
  const { data: application } = await db.from('job_applications').select('*').eq('user_id', currentSession.user.id).maybeSingle();
  const area = document.querySelector('#application-area');
  if (currentProfile?.role !== 'customer') area.innerHTML = '<p>Tu cuenta ya forma parte del equipo de K.I.D.</p>';
  else if (application) area.innerHTML = `<p>Estado de tu solicitud: <strong>${application.status === 'pending' ? 'Pendiente' : application.status === 'approved' ? 'Aceptada' : 'Rechazada'}</strong></p>`;
  else document.querySelector('#application-form').addEventListener('submit', async event => {
    event.preventDefault(); const message = new FormData(event.currentTarget).get('message');
    const { error } = await db.from('job_applications').insert({ user_id:currentSession.user.id, applicant_name:currentProfile.full_name, message });
    if (error) toast(error.message, true); else { toast('Solicitud enviada.'); setTimeout(() => location.reload(), 900); }
  });
}

async function initPanel() {
  if (!document.querySelector('.admin-page')) return;
  const denied = document.querySelector('#access-denied');
  const dashboard = document.querySelector('#staff-dashboard');
  if (!db || !currentSession || !['worker','admin'].includes(currentProfile?.role)) { denied.hidden = false; return; }
  dashboard.hidden = false;
  document.querySelector('#staff-identity').textContent = `${currentProfile.full_name} · ${roleNames[currentProfile.role]}`;
  document.querySelector('#panel-logout').addEventListener('click', async () => { await db.auth.signOut(); location.href = 'index.html'; });
  const isAdmin = currentProfile.role === 'admin';
  document.querySelector('#admin-stats').hidden = !isAdmin;
  document.querySelectorAll('.admin-only').forEach(element => element.hidden = !isAdmin);
  initPanelTabs(); initOrderFilters(); initMessageTabs(); initInquiryFilters();
  await loadStaffOrders();
  if (isAdmin) { await loadApplications(); await loadInquiries(); await loadAdminProducts(); await loadWorkers(); }
}

function initPanelTabs() {
  document.querySelectorAll('.panel-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(item => item.classList.toggle('is-active', item === tab));
    ['orders','catalog','messages','workers'].forEach(name => { document.querySelector(`#${name}-panel`).hidden = tab.dataset.panel !== name; });
  }));
}

function initMessageTabs() {
  document.querySelectorAll('.secondary-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.secondary-tab').forEach(item => item.classList.toggle('is-active', item === tab));
    document.querySelector('#applications-view').hidden = tab.dataset.messagePanel !== 'applications';
    document.querySelector('#inquiries-view').hidden = tab.dataset.messagePanel !== 'inquiries';
  }));
}

function initInquiryFilters() {
  document.querySelectorAll('[data-inquiry-filter]').forEach(button => button.addEventListener('click', () => {
    activeInquiryFilter = button.dataset.inquiryFilter;
    document.querySelectorAll('[data-inquiry-filter]').forEach(item => item.classList.toggle('is-active', item === button));
    renderInquiries();
  }));
}

function initOrderFilters() {
  document.querySelectorAll('.order-filters button').forEach(button => button.addEventListener('click', () => {
    activeOrderFilter = button.dataset.status;
    document.querySelectorAll('.order-filters button').forEach(item => item.classList.toggle('is-active', item === button));
    renderStaffOrders();
  }));
}

async function loadStaffOrders() {
  const { data, error } = await db.from('orders').select('*, order_items(*)').order('created_at', { ascending:false });
  if (error) return toast('No se pudieron cargar los pedidos.', true);
  staffOrders = data || []; renderStaffOrders(); renderMaterialsNeeded(); renderStats();
}

function renderStaffOrders() {
  const target = document.querySelector('#staff-orders'); if (!target) return;
  const visible = activeOrderFilter === 'all' ? staffOrders : staffOrders.filter(order => order.status === activeOrderFilter);
  if (!visible.length) { target.innerHTML = '<p class="loading-message">No hay pedidos en esta sección.</p>'; return; }
  target.innerHTML = visible.map(order => `<article class="staff-order-card"><div><h3>${escapeHTML(order.customer_name)}</h3><p>${new Date(order.created_at).toLocaleString('es-ES')}</p><p>Tel. ${escapeHTML(order.phone)}</p></div><div><p class="order-products">${order.order_items.map(item => `${item.quantity}× ${escapeHTML(item.product_name)}`).join('<br>')}</p>${order.notes ? `<p>Nota: ${escapeHTML(order.notes)}</p>` : ''}</div><p class="order-money">${money(order.total)}</p><div><select class="order-status-select" data-order-status="${order.id}" aria-label="Estado del pedido">${Object.entries(statusNames).map(([value,label]) => `<option value="${value}"${order.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select><button class="delete-order" type="button" data-delete-order="${order.id}" aria-label="Eliminar pedido">×</button></div></article>`).join('');
  target.querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', updateOrderStatus));
  target.querySelectorAll('[data-delete-order]').forEach(button => button.addEventListener('click', deleteOrder));
}

async function updateOrderStatus(event) {
  const { error } = await db.from('orders').update({ status:event.target.value }).eq('id', event.target.dataset.orderStatus);
  if (error) return toast('No se pudo cambiar el estado.', true);
  const order = staffOrders.find(item => item.id === event.target.dataset.orderStatus); if (order) order.status = event.target.value;
  toast('Estado actualizado.'); renderStaffOrders(); renderMaterialsNeeded(); renderStats();
}

async function deleteOrder(event) {
  const id = event.currentTarget.dataset.deleteOrder;
  if (!confirm('¿Seguro que quieres borrar este pedido? Esta acción no se puede deshacer.')) return;
  const { error } = await db.from('orders').delete().eq('id', id);
  if (error) return toast('No se pudo eliminar.', true);
  staffOrders = staffOrders.filter(order => order.id !== id); renderStaffOrders(); renderMaterialsNeeded(); renderStats(); toast('Pedido eliminado.');
}

function renderMaterialsNeeded() {
  const totals = {};
  staffOrders.filter(order => ['pending','preparing'].includes(order.status)).forEach(order => order.order_items.forEach(item => { totals[item.product_name] = (totals[item.product_name] || 0) + item.quantity; }));
  const target = document.querySelector('#materials-needed');
  target.innerHTML = Object.keys(totals).length ? Object.entries(totals).map(([name,qty]) => `<span>${escapeHTML(name)} · ${qty}</span>`).join('') : '<span>No hay pedidos pendientes.</span>';
}

function renderStats() {
  if (currentProfile?.role !== 'admin') return;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const income = staffOrders.filter(order => order.status === 'completed' && new Date(order.created_at).getTime() >= weekAgo).reduce((sum, order) => sum + Number(order.total), 0);
  document.querySelector('#weekly-income').textContent = money(income);
  document.querySelector('#active-orders').textContent = staffOrders.filter(order => ['pending','preparing','ready'].includes(order.status)).length;
}

async function loadApplications() {
  const { data, error } = await db.from('job_applications').select('*').order('created_at', { ascending:false });
  if (error) return;
  document.querySelector('#pending-applications').textContent = data.filter(item => item.status === 'pending').length;
  document.querySelector('#application-tab-count').textContent = data.filter(item => item.status === 'pending').length;
  const target = document.querySelector('#applications-list');
  target.innerHTML = data.length ? data.map(item => `<article class="application-card"><div><h3>${escapeHTML(item.applicant_name)}</h3><p>${new Date(item.created_at).toLocaleDateString('es-ES')} · ${item.status}</p><p>${escapeHTML(item.message || 'Sin mensaje')}</p></div><div class="row-actions"><button class="approve" data-review="approved" data-id="${item.id}" type="button">Aceptar</button><button data-review="pending" data-id="${item.id}" type="button">En espera</button><button class="danger" data-review="rejected" data-id="${item.id}" type="button">Rechazar</button></div></article>`).join('') : '<p class="loading-message">No hay solicitudes.</p>';
  target.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', reviewApplication));
}

async function loadInquiries() {
  const { data, error } = await db.from('inquiries').select('*').order('created_at', { ascending:false });
  if (error) return toast('No se pudieron cargar las dudas.', true);
  inquiries = data || [];
  const pending = inquiries.filter(item => item.status === 'new').length;
  document.querySelector('#pending-inquiries').textContent = pending;
  document.querySelector('#inquiry-tab-count').textContent = pending;
  renderInquiries();
}

function renderInquiries() {
  const target = document.querySelector('#inquiries-list');
  if (!target) return;
  const visible = activeInquiryFilter === 'all' ? inquiries : inquiries.filter(item => item.status === activeInquiryFilter);
  target.innerHTML = visible.length ? visible.map(item => `<article class="application-card inquiry-card${item.status === 'resolved' ? ' is-resolved' : ''}"><div><h3>${escapeHTML(item.name)}</h3><p>${new Date(item.created_at).toLocaleString('es-ES')} · Tel. ${escapeHTML(item.phone)}</p><p class="inquiry-text">${escapeHTML(item.message)}</p></div><div class="row-actions">${item.status === 'new' ? `<button class="approve" type="button" data-inquiry-status="resolved" data-id="${item.id}">Marcar resuelta</button>` : `<button type="button" data-inquiry-status="new" data-id="${item.id}">Reabrir</button>`}<button class="danger" type="button" data-delete-inquiry="${item.id}">Eliminar</button></div></article>`).join('') : '<p class="loading-message">No hay dudas en esta sección.</p>';
  target.querySelectorAll('[data-inquiry-status]').forEach(button => button.addEventListener('click', updateInquiryStatus));
  target.querySelectorAll('[data-delete-inquiry]').forEach(button => button.addEventListener('click', deleteInquiry));
}

async function updateInquiryStatus(event) {
  const status = event.currentTarget.dataset.inquiryStatus;
  const resolvedAt = status === 'resolved' ? new Date().toISOString() : null;
  const { error } = await db.from('inquiries').update({ status, resolved_at:resolvedAt }).eq('id', event.currentTarget.dataset.id);
  if (error) return toast('No se pudo actualizar la duda.', true);
  toast(status === 'resolved' ? 'Duda marcada como resuelta.' : 'Duda reabierta.');
  await loadInquiries();
}

async function deleteInquiry(event) {
  if (!confirm('¿Eliminar esta duda definitivamente?')) return;
  const { error } = await db.from('inquiries').delete().eq('id', event.currentTarget.dataset.deleteInquiry);
  if (error) return toast('No se pudo eliminar la duda.', true);
  toast('Duda eliminada.');
  await loadInquiries();
}

async function reviewApplication(event) {
  const { error } = await db.rpc('review_application', { p_application_id:event.currentTarget.dataset.id, p_decision:event.currentTarget.dataset.review });
  if (error) return toast('No se pudo revisar la solicitud.', true);
  toast('Solicitud actualizada.'); await loadApplications();
}

async function loadWorkers() {
  const { data, error } = await db.from('profiles').select('id, full_name, username, created_at').eq('role', 'worker').order('full_name');
  if (error) return toast('No se pudo cargar el equipo.', true);
  const target = document.querySelector('#workers-list');
  target.innerHTML = data.length ? data.map(worker => `<article class="application-card"><div><h3>${escapeHTML(worker.full_name || 'Sin nombre')}</h3><p>@${escapeHTML(worker.username)}</p><p>Trabajador desde ${new Date(worker.created_at).toLocaleDateString('es-ES')}</p></div><div class="row-actions"><button class="danger" type="button" data-remove-worker="${worker.id}">Quitar permisos</button></div></article>`).join('') : '<p class="loading-message">No hay trabajadores activos.</p>';
  target.querySelectorAll('[data-remove-worker]').forEach(button => button.addEventListener('click', removeWorker));
}

async function removeWorker(event) {
  if (!confirm('¿Quitar a esta persona el acceso de trabajador? Su cuenta seguirá existiendo como cliente.')) return;
  const { error } = await db.from('profiles').update({ role:'customer' }).eq('id', event.currentTarget.dataset.removeWorker).eq('role', 'worker');
  if (error) return toast('No se pudieron retirar los permisos.', true);
  toast('Permisos de trabajador retirados.');
  await loadWorkers();
}

async function loadAdminProducts() {
  await loadProducts(true); renderAdminProducts();
  document.querySelector('#product-form').addEventListener('submit', saveProduct);
  document.querySelector('#cancel-product-edit').addEventListener('click', resetProductForm);
}

function renderAdminProducts() {
  const target = document.querySelector('#admin-products');
  target.innerHTML = products.map(product => `<article class="admin-product-row"><div><h3>${escapeHTML(product.name)} · ${money(product.price)}</h3><p>${escapeHTML(product.category)}${product.active ? '' : ' · Oculto'}</p></div><div class="row-actions"><button type="button" data-edit-product="${product.id}">Editar</button><button class="danger" type="button" data-delete-product="${product.id}">Eliminar</button></div></article>`).join('');
  target.querySelectorAll('[data-edit-product]').forEach(button => button.addEventListener('click', editProduct));
  target.querySelectorAll('[data-delete-product]').forEach(button => button.addEventListener('click', deleteProduct));
}

async function saveProduct(event) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { name:data.get('name').trim(), price:Number(data.get('price')), category:data.get('category').trim(), image_url:data.get('image_url').trim(), description:data.get('description').trim(), active:true };
  const id = data.get('id');
  const result = id ? await db.from('products').update(payload).eq('id', id) : await db.from('products').insert(payload);
  if (result.error) return toast('No se pudo guardar el material.', true);
  toast(id ? 'Material actualizado.' : 'Material añadido.'); resetProductForm(); await loadAdminProducts();
}

function editProduct(event) {
  const product = products.find(item => String(item.id) === event.currentTarget.dataset.editProduct); const form = document.querySelector('#product-form');
  ['id','name','price','category','image_url','description'].forEach(key => form.elements[key].value = product[key] ?? '');
  document.querySelector('#product-form-title').textContent = 'Editar material'; document.querySelector('#cancel-product-edit').hidden = false; form.scrollIntoView({ behavior:'smooth' });
}

function resetProductForm() {
  const form = document.querySelector('#product-form'); form.reset(); form.elements.id.value = ''; form.elements.image_url.value = 'assets/logo.png';
  document.querySelector('#product-form-title').textContent = 'Añadir material'; document.querySelector('#cancel-product-edit').hidden = true;
}

async function deleteProduct(event) {
  if (!confirm('¿Eliminar este material del catálogo?')) return;
  const { error } = await db.from('products').delete().eq('id', event.currentTarget.dataset.deleteProduct);
  if (error) return toast('No se puede eliminar porque ya aparece en pedidos. Puedes editarlo u ocultarlo.', true);
  toast('Material eliminado.'); await loadAdminProducts();
}

function initInquiryForm() {
  const form = document.querySelector('#inquiry-form');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const messageTarget = document.querySelector('#inquiry-message');
    if (!db) { messageTarget.textContent = 'El formulario todavía no está conectado a la base de datos.'; return; }
    const data = new FormData(form);
    const payload = {
      name:data.get('name').trim(),
      phone:data.get('phone').trim(),
      message:data.get('message').trim(),
    };
    if (!/^[0-9]{5,15}$/.test(payload.phone)) { messageTarget.textContent = 'El teléfono debe contener solo entre 5 y 15 números.'; return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Enviando…'; messageTarget.textContent = '';
    const { error } = await db.from('inquiries').insert(payload);
    button.disabled = false; button.innerHTML = 'Enviar duda <span>↗</span>';
    if (error) { messageTarget.textContent = 'No se pudo enviar la duda. Inténtalo de nuevo.'; return; }
    form.reset(); messageTarget.textContent = 'Duda enviada correctamente.'; toast('Duda enviada con éxito.');
  });
}

function showQueryToast() {
  const params = new URLSearchParams(location.search);
  if (params.get('duda') === 'ok') { toast('Duda enviada con éxito.'); history.replaceState({}, '', location.pathname); }
  if (params.get('carrito') === '1') setTimeout(openCart, 250);
}

async function start() {
  initNavigation(); initCarousel(); await loadSession();
  await initCatalog(); await initAccountPage(); await initPanel(); initInquiryForm();
  showQueryToast();
}

start();
