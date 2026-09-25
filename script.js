// 1. Configuracion de Supabase
// Lee los datos de config.js y crea el cliente "db". Cada vez que veas db.from,
// db.auth, db.rpc o db.functions.invoke, el script esta hablando con Supabase.
const config = window.KID_CONFIG || {};
const backendReady = config.supabaseUrl?.startsWith('https://') && !config.supabaseAnonKey?.startsWith('PEGA_');
const db = backendReady && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

// 2. Utilidades generales
// money formatea precios, escapeHTML evita que textos de usuarios/productos se
// conviertan en HTML peligroso, y normalizeUsername limpia nombres de usuario.
const money = value => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));

// 3. Estados y roles
// En la base de datos se guardan valores cortos como "pending" o "boss".
// Estos mapas los convierten en textos claros para mostrarlos en la web.
const statusNames = { pending:'Pendiente', preparing:'Preparando', ready:'Listo', completed:'Completado', cancelled:'Cancelado' };
const roleNames = { customer:'Cliente', worker:'Trabajador', boss:'Jefe', admin:'Administrador' };

// staffRoles puede entrar al panel de trabajo. managementRoles puede gestionar
// catalogo, empleados, solicitudes y dudas. "boss" ve lo mismo que admin.
const staffRoles = ['worker', 'boss', 'admin'];
const managementRoles = ['boss', 'admin'];

// Supabase Auth necesita email, pero la web usa usuario + contrasena.
// Creamos un email interno que el usuario nunca ve.
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

// 4. Productos de emergencia
// Si Supabase no esta configurado o falla, la tienda usa estos materiales para
// no quedarse vacia. Los productos reales vienen de la tabla "products".
const defaultProducts = [
  { id:1, name:'Hierro', price:85, category:'Metal industrial', image_url:'assets/logo.png', description:'Resistente, versátil y preparado para cualquier proyecto.' },
  { id:2, name:'Cobre', price:120, category:'Metal conductor', image_url:'assets/logo.png', description:'Perfecto para cableado, componentes y encargos especiales.' },
  { id:3, name:'Carbón', price:65, category:'Combustible mineral', image_url:'assets/logo.png', description:'Negro, fiable y disponible en grandes cantidades.' },
  { id:4, name:'Oro', price:480, category:'Metal precioso', image_url:'assets/logo.png', description:'Brilla, pesa y siempre conserva su valor.' },
  { id:5, name:'Plata', price:310, category:'Metal precioso', image_url:'assets/logo.png', description:'Elegante, limpia y seleccionada a mano.' },
  { id:6, name:'Diamante', price:950, category:'Gema premium', image_url:'assets/logo.png', description:'Difícil de encontrar e imposible de ignorar.' }
];

// 5. Estado temporal de la pagina
// Estas variables son la memoria viva del script mientras el usuario navega:
// sesion actual, perfil, productos cargados, carrito, pedidos y filtros.
let currentSession = null;
let currentProfile = null;
let products = [];
let cart = JSON.parse(localStorage.getItem('kid-cart') || '[]');
let staffOrders = [];
let activeOrderFilter = 'all';
let inquiries = [];
let activeInquiryFilter = 'all';
let claims = [];
let activeClaimFilter = 'all';
let revenueEntries = [];
let expenses = [];
let expenseLedger = [];

// 6. Avisos flotantes
// Crea notificaciones apiladas. Por eso si anades varios materiales rapido,
// cada mensaje aparece encima/anadido al stack y no reemplaza al anterior.
function toast(message, error = false) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('aria-live', 'polite');
    stack.setAttribute('aria-atomic', 'false');
    document.body.append(stack);
  }
  const element = document.createElement('div');
  element.className = `toast${error ? ' is-error' : ''}`;
  element.textContent = message;
  stack.append(element);
  setTimeout(() => {
    element.remove();
    if (!stack.children.length) stack.remove();
  }, 3200);
}

// 7. Navegacion principal
// Controla el menu movil, marca el enlace de la pagina actual y prepara el
// boton del perfil que abre el menu de cuenta.
function initNavigation() {
  const menuButton = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.main-nav');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    nav?.classList.toggle('is-open', !open);
  });
  const page = document.body.dataset.page;
  const panelSection = new URLSearchParams(location.search).get('section');
  document.querySelectorAll('.main-nav a').forEach(link => {
    const href = link.getAttribute('href');
    const isCurrentPage = (page === 'inicio' && href === 'index.html') || href === `${page}.html`;
    const isCurrentPanel = page === 'panel' && (
      (link.classList.contains('employees-link') && panelSection === 'employees') ||
      (link.classList.contains('orders-link') && panelSection !== 'employees')
    );
    if (isCurrentPage || isCurrentPanel) link.setAttribute('aria-current', 'page');
  });
  document.querySelectorAll('.account-button').forEach(button => {
    button.innerHTML = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21a8 8 0 0 1 16 0" fill="currentColor"/></svg>';
    button.addEventListener('click', showAccountMenu);
  });
}

// 8. Inputs numericos
// Limpia automaticamente letras y simbolos en campos de telefono. La regla de
// "exactamente 10 numeros" se valida despues con /^[0-9]{10}$/.
function initNumericInputs() {
  document.addEventListener('input', event => {
    if (!event.target.matches('input[type="tel"][inputmode="numeric"]')) return;
    event.target.value = event.target.value.replace(/\D/g, '');
  });
}

// 9. Carrusel de la pagina inicial
// Cambia las diapositivas cada 5 segundos, salvo si el usuario tiene activada
// la preferencia de reducir animaciones.
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

// 10. Sesion y perfil
// Pregunta a Supabase si hay un usuario conectado. Si lo hay, busca su fila en
// "profiles" para saber nombre, usuario, telefono y rol.
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

// 11. Visibilidad segun rol
// Oculta o muestra enlaces del menu dependiendo de si el usuario es trabajador,
// jefe o administrador. Esto es visual; la seguridad real esta en Supabase.
function updateRoleUI() {
  const staff = staffRoles.includes(currentProfile?.role);
  const management = managementRoles.includes(currentProfile?.role);
  document.querySelectorAll('.orders-link').forEach(link => link.hidden = !staff);
  document.querySelectorAll('.employees-link').forEach(link => link.hidden = !management);
}

// 12. Menu de cuenta
// Construye el desplegable del icono de usuario: perfil, gestionar trabajo,
// cerrar sesion, iniciar sesion o crear cuenta segun el estado actual.
function showAccountMenu(event) {
  event.stopPropagation();
  document.querySelector('.account-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'account-menu';
  if (currentSession && currentProfile) {
    menu.innerHTML = `<strong>${escapeHTML(currentProfile.full_name || 'Mi cuenta')}</strong><small>@${escapeHTML(currentProfile.username)}</small><a href="cuenta.html">Mi perfil y pedidos</a>${staffRoles.includes(currentProfile.role) ? '<a href="panel.html?section=orders">Gestionar trabajo</a>' : ''}<button type="button" data-signout>Cerrar sesión</button>`;
    menu.querySelector('[data-signout]').addEventListener('click', async () => { await db.auth.signOut(); location.href = 'index.html'; });
  } else {
    menu.innerHTML = '<strong>Zona de usuario</strong><small>Accede para consultar y seguir tus pedidos</small><a href="cuenta.html">Iniciar sesión</a><a href="cuenta.html?registro=1">Crear cuenta</a>';
  }
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once:true }), 0);
}

// 13. Carga de productos
// Lee la tabla "products". En tienda solo trae activos; en admin puede traer
// tambien inactivos/ocultos con includeInactive = true.
async function loadProducts(includeInactive = false) {
  if (!db) { products = defaultProducts; return products; }
  let query = db.from('products').select('*').order('id');
  if (!includeInactive) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) { toast('No se pudo cargar el catálogo.', true); products = defaultProducts; }
  else products = data;
  return products;
}

// 14. Catalogo publico
// Pinta las tarjetas de productos en #product-grid y conecta el boton
// "Anadir al carro" con la funcion addToCart.
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
}

// 15. Carrito: guardar y anadir productos
// El carrito vive en localStorage para no perderse al recargar. saveCart
// actualiza el contador superior y vuelve a pintar el drawer.
function saveCart() {
  localStorage.setItem('kid-cart', JSON.stringify(cart));
  document.querySelectorAll('.cart-count').forEach(element => element.textContent = cart.reduce((sum, item) => sum + item.quantity, 0));
  renderCart();
}

function addToCart(product) {
  const existing = cart.find(item => String(item.id) === String(product.id));
  if (existing) existing.quantity += 1;
  else cart.push({ id:product.id, name:product.name, price:Number(product.price), quantity:1 });
  saveCart(); toast(`${product.name} añadido al carrito.`);
}

// 16. Drawer del carrito
// Crea el panel lateral del carrito en todas las paginas y conecta abrir,
// cerrar, cambiar cantidades, eliminar productos y confirmar compra.
function createCartDrawer() {
  if (document.querySelector('.cart-drawer')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="drawer-backdrop"></div><aside class="cart-drawer" aria-label="Carrito" aria-hidden="true"><div class="drawer-heading"><h2>Tu carrito</h2><button class="drawer-close" type="button" aria-label="Cerrar carrito">×</button></div><div class="cart-items"></div><div class="cart-checkout"><div class="cart-total"><span>Total</span><strong>$0</strong></div><div class="cart-customer-fields"><input id="checkout-name" type="text" placeholder="Nombre completo" aria-label="Nombre completo"><input id="checkout-phone" type="tel" inputmode="numeric" pattern="[0-9]{10}" placeholder="Teléfono" aria-label="Teléfono"><textarea id="checkout-notes" rows="2" placeholder="Notas o lugar de entrega" aria-label="Notas"></textarea></div><button class="submit-button checkout-button" type="button">Confirmar compra <span>↗</span></button></div></aside>`);
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

// 17. Confirmar compra
// Valida nombre y telefono, transforma el carrito en items simples y llama a
// la funcion SQL "place_order", que crea el pedido y sus lineas en Supabase.
async function checkout() {
  if (!cart.length) return toast('Añade algún producto antes de comprar.', true);
  if (!db) return toast('No se pudo completar el pedido en este momento.', true);
  const customerName = document.querySelector('#checkout-name').value.trim();
  const phone = document.querySelector('#checkout-phone').value.trim();
  const notes = document.querySelector('#checkout-notes').value.trim();
  if (!customerName) return toast('Escribe tu nombre.', true);
  if (!/^[0-9]{10}$/.test(phone)) return toast('El teléfono debe contener exactamente 10 números.', true);
  const button = document.querySelector('.checkout-button'); button.disabled = true; button.textContent = 'Enviando…';
  const items = cart.map(item => ({ product_id:Number(item.id), quantity:item.quantity }));
  const { error } = await db.rpc('place_order', { p_customer_name:customerName, p_phone:phone, p_notes:notes, p_items:items });
  button.disabled = false; button.innerHTML = 'Confirmar compra <span>↗</span>';
  if (error) return toast(error.message || 'No se pudo enviar el pedido.', true);
  cart = []; saveCart(); closeCart();
  toast(currentSession ? 'Pedido realizado con éxito.' : 'Pedido enviado. Te buscaremos por tu nombre y teléfono.');
}

// 18. Pestanas de acceso
// Separa visualmente iniciar sesion y crear cuenta. Cuando una pestana esta
// activa, el otro formulario queda oculto.
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

// 19. Pagina de cuenta
// Si ya hay sesion, muestra perfil. Si no, prepara login y registro. El login
// usa usuario + contrasena, aunque internamente Supabase Auth recibe un email oculto.
async function initAccountPage() {
  if (!document.querySelector('.account-page')) return;
  initAuthTabs();
  if (currentSession) return showProfile();
  document.querySelector('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!db) return setAuthMessage('El acceso no está disponible en este momento.');
    const form = new FormData(event.currentTarget);
    const username = normalizeUsername(form.get('username'));
    const { error } = await db.auth.signInWithPassword({ email:hiddenLoginEmail(username), password:form.get('password') });
    if (error) return setAuthMessage('Usuario o contraseña incorrectos.');
    const destination = localStorage.getItem('kid-return'); localStorage.removeItem('kid-return');
    location.href = destination || 'cuenta.html';
  });
  document.querySelector('#register-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!db) return setAuthMessage('El registro no está disponible en este momento.');
    const form = new FormData(event.currentTarget);
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

// 20. Perfil del usuario
// Muestra datos del perfil, pedidos propios y el estado/formulario de solicitud
// de trabajo. Solo las cuentas customer pueden enviar solicitud.
async function showProfile() {
  document.querySelector('#auth-view').hidden = true;
  document.querySelector('#profile-view').hidden = false;
  document.querySelector('#profile-name').textContent = currentProfile?.full_name || 'Bienvenido';
  document.querySelector('#profile-role').textContent = `${roleNames[currentProfile?.role] || 'Cliente'} · @${currentProfile?.username || ''}`;
  document.querySelector('#logout-button').addEventListener('click', async () => { await db.auth.signOut(); location.reload(); });
  initProfileEditForm();
  await loadCustomerOrders();
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

// Permite corregir nombre, usuario y teléfono. La Edge Function actualiza a la
// vez profiles y el email interno de Auth para que el nuevo usuario siga
// funcionando la próxima vez que la persona inicie sesión.
function initProfileEditForm() {
  const form = document.querySelector('#profile-edit-form');
  if (!form || !currentProfile) return;
  form.elements.full_name.value = currentProfile.full_name || '';
  form.elements.username.value = currentProfile.username || '';
  form.elements.phone.value = currentProfile.phone || '';
  form.addEventListener('submit', updateMyProfile);
}

async function updateMyProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const target = document.querySelector('#profile-edit-message');
  const data = new FormData(form);
  const fullName = data.get('full_name').trim();
  const username = normalizeUsername(data.get('username'));
  const phone = data.get('phone').trim();
  if (fullName.length < 2) { target.textContent = 'Escribe un nombre válido.'; return; }
  if (!/^[a-z0-9._-]{3,24}$/.test(username)) { target.textContent = 'El usuario debe tener entre 3 y 24 caracteres válidos.'; return; }
  if (!/^[0-9]{10}$/.test(phone)) { target.textContent = 'El teléfono debe contener exactamente 10 números.'; return; }

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Guardando…'; target.textContent = '';
  const { data: response, error } = await db.functions.invoke('register-user', {
    body:{ action:'update-profile', fullName, username, phone },
  });
  button.disabled = false; button.textContent = 'Guardar cambios';
  if (error || response?.error) {
    let message = response?.error || 'No se pudieron guardar los cambios.';
    if (error?.context) {
      try { message = (await error.context.json()).error || message; } catch {}
    }
    target.textContent = message;
    return;
  }

  currentProfile = { ...currentProfile, full_name:fullName, username, phone };
  document.querySelector('#profile-name').textContent = fullName;
  document.querySelector('#profile-role').textContent = `${roleNames[currentProfile.role] || 'Cliente'} · @${username}`;
  target.textContent = `Datos guardados. La próxima vez inicia sesión como @${username}.`;
  toast('Datos del perfil actualizados.');
}

// Carga los pedidos visibles del cliente. Cada tarjeta permite quitar el
// pedido de su perfil o abrir una reclamación asociada a ese pedido concreto.
async function loadCustomerOrders() {
  const orderTarget = document.querySelector('#my-orders');
  if (!orderTarget) return;
  const { data: orders, error } = await db
    .from('orders')
    .select('*, order_items(*), order_claims(*)')
    .eq('user_id', currentSession.user.id)
    .order('created_at', { ascending:false });
  if (error) { orderTarget.innerHTML = '<p>No se pudieron cargar tus pedidos.</p>'; return; }
  if (!orders?.length) { orderTarget.innerHTML = '<p>Aún no tienes pedidos.</p>'; return; }

  orderTarget.innerHTML = orders.map(order => {
    const openClaim = order.order_claims?.find(claim => claim.status === 'new');
    return `<article class="mini-order customer-order-card"><div><strong>${new Date(order.created_at).toLocaleDateString('es-ES')}</strong><span>${order.order_items.map(item => `${item.quantity}× ${escapeHTML(item.product_name)}`).join(', ')}</span><small>Pedido ${escapeHTML(order.id.slice(0, 8).toUpperCase())}</small></div><div class="customer-order-summary"><strong>${money(order.total)}</strong><span class="status-badge status-${order.status}">${statusNames[order.status]}</span></div><div class="customer-order-actions">${openClaim ? '<span class="claim-pending-label">Reclamación pendiente</span>' : `<button class="outline-button" type="button" data-open-claim="${order.id}">Reclamar</button>`}<button class="danger-button" type="button" data-customer-delete-order="${order.id}">Eliminar</button></div>${openClaim ? '' : `<form class="claim-form" data-claim-form="${order.id}" hidden><label>Motivo de la reclamación<textarea name="message" rows="4" minlength="5" maxlength="2000" required placeholder="Explícanos qué ha ocurrido con este pedido..."></textarea></label><div class="claim-form-actions"><button class="submit-button" type="submit">Enviar reclamación</button><button class="outline-button" type="button" data-close-claim="${order.id}">Cancelar</button></div></form>`}</article>`;
  }).join('');

  orderTarget.querySelectorAll('[data-open-claim]').forEach(button => button.addEventListener('click', () => {
    orderTarget.querySelector(`[data-claim-form="${button.dataset.openClaim}"]`).hidden = false;
    button.hidden = true;
  }));
  orderTarget.querySelectorAll('[data-close-claim]').forEach(button => button.addEventListener('click', () => {
    orderTarget.querySelector(`[data-claim-form="${button.dataset.closeClaim}"]`).hidden = true;
    orderTarget.querySelector(`[data-open-claim="${button.dataset.closeClaim}"]`).hidden = false;
  }));
  orderTarget.querySelectorAll('[data-claim-form]').forEach(form => form.addEventListener('submit', submitClaim));
  orderTarget.querySelectorAll('[data-customer-delete-order]').forEach(button => button.addEventListener('click', customerDeleteOrder));
}

async function customerDeleteOrder(event) {
  const id = event.currentTarget.dataset.customerDeleteOrder;
  const warning = 'El pedido desaparecerá de tu perfil. Si aún está pendiente, la empresa lo verá como cancelado. ¿Quieres continuar?';
  if (!confirm(warning)) return;
  const { error } = await db.rpc('customer_remove_order', { p_order_id:id });
  if (error) return toast('No se pudo eliminar el pedido.', true);
  toast('Pedido eliminado de tu perfil.');
  await loadCustomerOrders();
}

async function submitClaim(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = new FormData(form).get('message').trim();
  if (message.length < 5) return toast('Explica el motivo de la reclamación.', true);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Enviando…';
  const { error } = await db.rpc('create_order_claim', {
    p_order_id:form.dataset.claimForm,
    p_message:message,
  });
  button.disabled = false; button.textContent = 'Enviar reclamación';
  if (error) {
    const duplicate = error.code === '23505' || error.message?.includes('reclamación pendiente');
    return toast(duplicate ? 'Este pedido ya tiene una reclamación pendiente.' : error.message || 'No se pudo enviar la reclamación.', true);
  }
  toast('Reclamación enviada a la empresa.');
  await loadCustomerOrders();
}

// 21. Panel de trabajo
// Protege la pagina del panel: solo worker, boss y admin entran. Todo el equipo
// puede ver pedidos, dudas y reclamaciones. Boss y admin cargan además catálogo,
// solicitudes de trabajo y gestión de trabajadores.
async function initPanel() {
  if (!document.querySelector('.admin-page')) return;
  const denied = document.querySelector('#access-denied');
  const dashboard = document.querySelector('#staff-dashboard');
  if (!db || !currentSession || !staffRoles.includes(currentProfile?.role)) { denied.hidden = false; return; }
  dashboard.hidden = false;
  document.querySelector('#staff-identity').textContent = `${currentProfile.full_name} · ${roleNames[currentProfile.role]}`;
  document.querySelector('#panel-logout').addEventListener('click', async () => { await db.auth.signOut(); location.href = 'index.html'; });
  const isManagement = managementRoles.includes(currentProfile.role);
  document.querySelector('#admin-stats').hidden = !isManagement;
  document.querySelectorAll('.management-only').forEach(element => element.hidden = !isManagement);
  initPanelTabs(); initOrderFilters(); initMessageTabs(isManagement); initInquiryFilters(); initClaimFilters(); initExpenseForm();
  await loadStaffOrders();
  await loadInquiries();
  await loadClaims();
  if (isManagement) { await loadApplications(); await loadFinancialData(); await loadAdminProducts(); await loadWorkers(); }
  const requestedSection = new URLSearchParams(location.search).get('section');
  const initialPanel = requestedSection === 'employees' && isManagement ? 'workers' : 'orders';
  document.querySelector(`.panel-tab[data-panel="${initialPanel}"]`)?.click();
}

// 22. Pestanas principales del panel
// Alterna entre pedidos, catalogo, mensajes, trabajadores y gastos. Tambien actualiza
// la URL con ?section=orders o ?section=employees sin recargar la pagina.
function initPanelTabs() {
  document.querySelectorAll('.panel-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(item => item.classList.toggle('is-active', item === tab));
    ['orders','catalog','messages','workers','expenses'].forEach(name => { document.querySelector(`#${name}-panel`).hidden = tab.dataset.panel !== name; });
    const employeePanel = tab.dataset.panel === 'workers';
    const section = employeePanel ? 'employees' : 'orders';
    const url = new URL(location.href);
    url.searchParams.set('section', section);
    history.replaceState({}, '', url);
    const titles = { orders:'Gestión minera', catalog:'Gestión minera', workers:'Gestión de empleados', messages:'Dudas y reclamaciones', expenses:'Gastos e ingresos' };
    document.querySelector('#dashboard-title').textContent = titles[tab.dataset.panel] || 'Gestión minera';
    document.querySelectorAll('.orders-link').forEach(link => link.toggleAttribute('aria-current', !employeePanel));
    document.querySelectorAll('.employees-link').forEach(link => link.toggleAttribute('aria-current', employeePanel));
  }));
}

// 23. Subpestanas y filtros del panel
// Controlan los filtros de pedidos y la vista de solicitudes/dudas dentro del
// panel de mensajes.
function initMessageTabs(isManagement) {
  document.querySelectorAll('.secondary-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.secondary-tab').forEach(item => item.classList.toggle('is-active', item === tab));
    document.querySelector('#applications-view').hidden = tab.dataset.messagePanel !== 'applications';
    document.querySelector('#inquiries-view').hidden = tab.dataset.messagePanel !== 'inquiries';
    document.querySelector('#claims-view').hidden = tab.dataset.messagePanel !== 'claims';
  }));
  document.querySelector(`[data-message-panel="${isManagement ? 'applications' : 'inquiries'}"]`)?.click();
}

function initInquiryFilters() {
  document.querySelectorAll('[data-inquiry-filter]').forEach(button => button.addEventListener('click', () => {
    activeInquiryFilter = button.dataset.inquiryFilter;
    document.querySelectorAll('[data-inquiry-filter]').forEach(item => item.classList.toggle('is-active', item === button));
    renderInquiries();
  }));
}

function initClaimFilters() {
  document.querySelectorAll('[data-claim-filter]').forEach(button => button.addEventListener('click', () => {
    activeClaimFilter = button.dataset.claimFilter;
    document.querySelectorAll('[data-claim-filter]').forEach(item => item.classList.toggle('is-active', item === button));
    renderClaims();
  }));
}

function initOrderFilters() {
  document.querySelectorAll('.order-filters button').forEach(button => button.addEventListener('click', () => {
    activeOrderFilter = button.dataset.status;
    document.querySelectorAll('.order-filters button').forEach(item => item.classList.toggle('is-active', item === button));
    renderStaffOrders();
  }));
}

// 24. Pedidos del equipo
// Carga todos los pedidos con sus order_items, los guarda en staffOrders y
// refresca tarjetas, materiales necesarios y estadisticas.
async function loadStaffOrders() {
  const { data, error } = await db.from('orders').select('*, order_items(*)').is('company_deleted_at', null).order('created_at', { ascending:false });
  if (error) return toast('No se pudieron cargar los pedidos.', true);
  staffOrders = data || []; renderStaffOrders(); renderMaterialsNeeded(); renderStats();
}

// 25. Render de pedidos
// Pinta cada pedido interno con cliente, teléfono, productos, total, estado y
// botón para quitarlo de la vista de la empresa. El borrado físico lo decide
// Supabase según las marcas de ambas partes, los 7 días y las reclamaciones.
function renderStaffOrders() {
  const target = document.querySelector('#staff-orders'); if (!target) return;
  const visible = activeOrderFilter === 'all' ? staffOrders : staffOrders.filter(order => order.status === activeOrderFilter);
  if (!visible.length) { target.innerHTML = '<p class="loading-message">No hay pedidos en esta sección.</p>'; return; }
  target.innerHTML = visible.map(order => `<article class="staff-order-card"><div><h3>${escapeHTML(order.customer_name)}</h3><p>${new Date(order.created_at).toLocaleString('es-ES')}</p><p>Tel. ${escapeHTML(order.phone)}</p>${order.customer_deleted_at ? '<span class="customer-cancelled-label">El cliente lo eliminó</span>' : ''}</div><div><p class="order-products">${order.order_items.map(item => `${item.quantity}× ${escapeHTML(item.product_name)}`).join('<br>')}</p>${order.notes ? `<p>Nota: ${escapeHTML(order.notes)}</p>` : ''}</div><p class="order-money">${money(order.total)}</p><div><select class="order-status-select" data-order-status="${order.id}" aria-label="Estado del pedido">${Object.entries(statusNames).map(([value,label]) => `<option value="${value}"${order.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select><button class="delete-order" type="button" data-delete-order="${order.id}" aria-label="Eliminar pedido">×</button></div></article>`).join('');
  target.querySelectorAll('[data-order-status]').forEach(select => select.addEventListener('change', updateOrderStatus));
  target.querySelectorAll('[data-delete-order]').forEach(button => button.addEventListener('click', deleteOrder));
}

// 26. Cambiar estado y borrar pedidos
// Actualiza Supabase y despues actualiza la copia local para que la pantalla no
// se quede antigua.
async function updateOrderStatus(event) {
  const { error } = await db.from('orders').update({ status:event.target.value }).eq('id', event.target.dataset.orderStatus);
  if (error) return toast('No se pudo cambiar el estado.', true);
  const order = staffOrders.find(item => item.id === event.target.dataset.orderStatus); if (order) order.status = event.target.value;
  toast('Estado actualizado.'); renderStaffOrders(); renderMaterialsNeeded();
  if (managementRoles.includes(currentProfile?.role)) await loadFinancialData();
}

async function deleteOrder(event) {
  const id = event.currentTarget.dataset.deleteOrder;
  if (!confirm('¿Quitar este pedido de la vista de la empresa? Solo se borrará del servidor cuando también lo elimine el cliente o hayan pasado 7 días.')) return;
  const { error } = await db.rpc('staff_remove_order', { p_order_id:id });
  if (error) return toast('No se pudo eliminar.', true);
  staffOrders = staffOrders.filter(order => order.id !== id); renderStaffOrders(); renderMaterialsNeeded(); renderStats(); toast('Pedido eliminado de la vista de la empresa.');
}

// 27. Materiales necesarios y estadisticas
// Suma cantidades de pedidos pendientes/preparando. Los ingresos ya no se
// calculan desde los pedidos visibles, sino desde revenue_ledger, para que un
// pedido completado pueda borrarse sin hacer desaparecer el dinero ganado.
function renderMaterialsNeeded() {
  const totals = {};
  staffOrders.filter(order => ['pending','preparing'].includes(order.status)).forEach(order => order.order_items.forEach(item => { totals[item.product_name] = (totals[item.product_name] || 0) + item.quantity; }));
  const target = document.querySelector('#materials-needed');
  target.innerHTML = Object.keys(totals).length ? Object.entries(totals).map(([name,qty]) => `<span>${escapeHTML(name)} · ${qty}</span>`).join('') : '<span>No hay pedidos pendientes.</span>';
}

function renderStats() {
  if (!managementRoles.includes(currentProfile?.role)) return;
  const grossIncome = revenueEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const totalExpenses = expenseLedger.filter(expense => !expense.cancelled_at).reduce((sum, expense) => sum + Number(expense.amount), 0);
  document.querySelector('#total-income').textContent = money(grossIncome - totalExpenses);
  document.querySelector('#active-orders').textContent = staffOrders.filter(order => ['pending','preparing','ready'].includes(order.status)).length;
}

// 28. Solicitudes de trabajo
// Carga solicitudes pendientes/aceptadas/rechazadas. Al aceptar, se puede dar
// rol worker o boss mediante la funcion SQL review_application.
async function loadApplications() {
  const { data, error } = await db.from('job_applications').select('*').eq('status', 'pending').order('created_at', { ascending:false });
  if (error) return;
  document.querySelector('#pending-applications').textContent = data.filter(item => item.status === 'pending').length;
  document.querySelector('#application-tab-count').textContent = data.filter(item => item.status === 'pending').length;
  const target = document.querySelector('#applications-list');
  target.innerHTML = data.length ? data.map(item => `<article class="application-card"><div><h3>${escapeHTML(item.applicant_name)}</h3><p>${new Date(item.created_at).toLocaleDateString('es-ES')} · ${item.status}</p><p>${escapeHTML(item.message || 'Sin mensaje')}</p></div><div class="row-actions"><button class="approve" data-review="approved" data-role="worker" data-id="${item.id}" type="button">Aceptar como trabajador</button><button class="approve" data-review="approved" data-role="boss" data-id="${item.id}" type="button">Aceptar como jefe</button><button data-review="pending" data-id="${item.id}" type="button">En espera</button><button class="danger" data-review="rejected" data-id="${item.id}" type="button">Rechazar</button></div></article>`).join('') : '<p class="loading-message">No hay solicitudes.</p>';
  target.querySelectorAll('[data-review]').forEach(button => button.addEventListener('click', reviewApplication));
}

// 29. Dudas y mensajes de contacto
// Carga las dudas para todo el equipo. Los trabajadores pueden leerlas;
// jefe y admin también pueden resolverlas, reabrirlas o eliminarlas.
async function loadInquiries() {
  const { data, error } = await db.from('inquiries').select('*').order('created_at', { ascending:false });
  if (error) return toast('No se pudieron cargar las dudas.', true);
  inquiries = data || [];
  const pending = inquiries.filter(item => item.status === 'new').length;
  const pendingTarget = document.querySelector('#pending-inquiries');
  if (pendingTarget) pendingTarget.textContent = pending;
  document.querySelector('#inquiry-tab-count').textContent = pending;
  renderInquiries();
}

function renderInquiries() {
  const target = document.querySelector('#inquiries-list');
  if (!target) return;
  const visible = activeInquiryFilter === 'all' ? inquiries : inquiries.filter(item => item.status === activeInquiryFilter);
  const canManage = managementRoles.includes(currentProfile?.role);
  target.innerHTML = visible.length ? visible.map(item => `<article class="application-card inquiry-card${item.status === 'resolved' ? ' is-resolved' : ''}"><div><h3>${escapeHTML(item.name)}</h3><p>${new Date(item.created_at).toLocaleString('es-ES')} · Tel. ${escapeHTML(item.phone)}</p><p class="inquiry-text">${escapeHTML(item.message)}</p></div>${canManage ? `<div class="row-actions">${item.status === 'new' ? `<button class="approve" type="button" data-inquiry-status="resolved" data-id="${item.id}">Marcar resuelta</button>` : `<button type="button" data-inquiry-status="new" data-id="${item.id}">Reabrir</button>`}<button class="danger" type="button" data-delete-inquiry="${item.id}">Eliminar</button></div>` : '<span class="read-only-label">Solo lectura</span>'}</article>`).join('') : '<p class="loading-message">No hay dudas en esta sección.</p>';
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
  const { error } = await db.rpc('review_application', { p_application_id:event.currentTarget.dataset.id, p_decision:event.currentTarget.dataset.review, p_role:event.currentTarget.dataset.role || 'worker' });
  if (error) return toast('No se pudo revisar la solicitud.', true);
  toast('Solicitud actualizada.'); await loadApplications();
}

// 30. Reclamaciones de pedidos
// Se muestran separadas de las dudas. Incluyen el pedido, los materiales y el
// mensaje del cliente. Todo el equipo puede resolverlas o reabrirlas.
async function loadClaims() {
  const { data, error } = await db
    .from('order_claims')
    .select('*, orders(*, order_items(*))')
    .order('created_at', { ascending:false });
  if (error) return toast('No se pudieron cargar las reclamaciones.', true);
  claims = data || [];
  const pending = claims.filter(item => item.status === 'new').length;
  document.querySelector('#claim-tab-count').textContent = pending;
  renderClaims();
}

function renderClaims() {
  const target = document.querySelector('#claims-list');
  if (!target) return;
  const visible = activeClaimFilter === 'all' ? claims : claims.filter(item => item.status === activeClaimFilter);
  target.innerHTML = visible.length ? visible.map(item => {
    const order = item.orders;
    const products = order?.order_items?.map(product => `${product.quantity}× ${escapeHTML(product.product_name)}`).join('<br>') || 'Pedido no disponible';
    return `<article class="application-card inquiry-card claim-card${item.status === 'resolved' ? ' is-resolved' : ''}"><div><h3>Reclamación · pedido ${escapeHTML(String(item.order_id).slice(0, 8).toUpperCase())}</h3><p>${new Date(item.created_at).toLocaleString('es-ES')}${order ? ` · ${escapeHTML(order.customer_name)} · Tel. ${escapeHTML(order.phone)}` : ''}</p>${order ? `<div class="claim-order-data"><p>${products}</p><strong>${money(order.total)}</strong><span class="status-badge status-${order.status}">${statusNames[order.status]}</span></div>` : ''}<p class="inquiry-text">${escapeHTML(item.message)}</p></div><div class="row-actions">${item.status === 'new' ? `<button class="approve" type="button" data-claim-status="resolved" data-id="${item.id}">Marcar resuelta</button>` : `<button type="button" data-claim-status="new" data-id="${item.id}">Reabrir</button>`}</div></article>`;
  }).join('') : '<p class="loading-message">No hay reclamaciones en esta sección.</p>';
  target.querySelectorAll('[data-claim-status]').forEach(button => button.addEventListener('click', updateClaimStatus));
}

async function updateClaimStatus(event) {
  const status = event.currentTarget.dataset.claimStatus;
  const { error } = await db.from('order_claims').update({ status }).eq('id', event.currentTarget.dataset.id);
  if (error) return toast('No se pudo actualizar la reclamación.', true);
  toast(status === 'resolved' ? 'Reclamación marcada como resuelta.' : 'Reclamación reabierta.');
  await loadClaims();
  await loadStaffOrders();
}

// 31. Gastos e ingresos históricos
// Solo boss y admin cargan esta información. Los tickets cancelados se
// conservan pero dejan de restarse. El botón eliminar borra la tarjeta visible,
// pero el gasto activo se queda en expense_ledger para seguir descontando.
function initExpenseForm() {
  const form = document.querySelector('#expense-form');
  form?.addEventListener('submit', createExpense);
}

async function loadFinancialData() {
  const [revenueResult, expenseResult, expenseLedgerResult] = await Promise.all([
    db.from('revenue_ledger').select('*').order('completed_at', { ascending:false }),
    db.from('expenses').select('*').order('created_at', { ascending:false }),
    db.from('expense_ledger').select('amount,cancelled_at'),
  ]);
  if (revenueResult.error || expenseResult.error || expenseLedgerResult.error) return toast('No se pudieron cargar las cuentas.', true);
  revenueEntries = revenueResult.data || [];
  expenses = expenseResult.data || [];
  expenseLedger = expenseLedgerResult.data || [];
  renderExpenses();
  renderStats();
}

function renderExpenses() {
  const target = document.querySelector('#expenses-list');
  if (!target) return;
  const grossIncome = revenueEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const activeExpenses = expenseLedger.filter(expense => !expense.cancelled_at);
  const totalExpenses = activeExpenses.reduce((sum, expense) => sum + Number(expense.amount), 0);
  document.querySelector('#gross-income').textContent = money(grossIncome);
  document.querySelector('#total-expenses').textContent = money(totalExpenses);
  document.querySelector('#net-income').textContent = money(grossIncome - totalExpenses);

  target.innerHTML = expenses.length ? expenses.map(expense => `<article class="application-card expense-ticket${expense.cancelled_at ? ' is-cancelled' : ''}"><div><h3>${escapeHTML(expense.concept)}</h3><p>${new Date(expense.created_at).toLocaleString('es-ES')} · ${escapeHTML(expense.created_by_name)}</p>${expense.cancelled_at ? `<span class="expense-cancelled-label">Cancelado el ${new Date(expense.cancelled_at).toLocaleString('es-ES')}</span>` : ''}</div><strong class="expense-amount">−${money(expense.amount)}</strong><div class="row-actions">${expense.cancelled_at ? '' : `<button type="button" data-cancel-expense="${expense.id}">Cancelar ticket</button>`}<button class="danger" type="button" data-delete-expense="${expense.id}">Eliminar</button></div></article>`).join('') : '<p class="loading-message">Todavía no hay tickets de gastos.</p>';
  target.querySelectorAll('[data-cancel-expense]').forEach(button => button.addEventListener('click', cancelExpense));
  target.querySelectorAll('[data-delete-expense]').forEach(button => button.addEventListener('click', deleteExpense));
}

async function createExpense(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const amount = Number(data.get('amount'));
  const concept = data.get('concept').trim();
  if (!Number.isFinite(amount) || amount <= 0 || concept.length < 2) return toast('Completa el importe y el concepto.', true);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; button.textContent = 'Creando…';
  const { error } = await db.rpc('create_expense', { p_amount:amount, p_concept:concept });
  button.disabled = false; button.textContent = 'Crear ticket';
  if (error) return toast('No se pudo crear el ticket.', true);
  form.reset(); toast('Ticket de gasto creado.'); await loadFinancialData();
}

async function cancelExpense(event) {
  if (!confirm('¿Cancelar este ticket? Dejará de restarse de los ingresos y podrás crear uno nuevo.')) return;
  const { error } = await db.rpc('cancel_expense', { p_expense_id:event.currentTarget.dataset.cancelExpense });
  if (error) return toast('No se pudo cancelar el ticket.', true);
  toast('Ticket cancelado.'); await loadFinancialData();
}

async function deleteExpense(event) {
  const id = event.currentTarget.dataset.deleteExpense;
  const expense = expenses.find(item => item.id === id);
  if (!expense) return;
  if (!expense.cancelled_at && !confirm('¿Seguro que quieres eliminar este ticket de la lista? El gasto seguirá restándose de los ingresos porque ya forma parte del historial contable.')) return;
  const { error } = await db.rpc('delete_expense', { p_expense_id:id });
  if (error) return toast('No se pudo eliminar el gasto.', true);
  toast('Ticket eliminado.');
  await loadFinancialData();
}

// 32. Trabajadores y jefes
// Lista perfiles con rol worker o boss. Permite cambiar entre trabajador/jefe
// o quitar permisos para devolver la cuenta a customer.
async function loadWorkers() {
  const { data, error } = await db.from('profiles').select('id, full_name, username, role, created_at').in('role', ['worker', 'boss']).order('full_name');
  if (error) return toast('No se pudo cargar el equipo.', true);
  const target = document.querySelector('#workers-list');
  target.innerHTML = data.length ? data.map(worker => `<article class="application-card"><div><h3>${escapeHTML(worker.full_name || 'Sin nombre')}</h3><p>@${escapeHTML(worker.username)}</p><p>${roleNames[worker.role]} · en el equipo desde ${new Date(worker.created_at).toLocaleDateString('es-ES')}</p></div><div class="row-actions">${worker.id === currentSession.user.id ? '<strong>Tu cuenta</strong>' : `<select data-worker-role="${worker.id}" aria-label="Rol de ${escapeHTML(worker.full_name)}"><option value="worker"${worker.role === 'worker' ? ' selected' : ''}>Trabajador</option><option value="boss"${worker.role === 'boss' ? ' selected' : ''}>Jefe</option></select><button class="danger" type="button" data-remove-worker="${worker.id}">Quitar permisos</button>`}</div></article>`).join('') : '<p class="loading-message">No hay trabajadores ni jefes activos.</p>';
  target.querySelectorAll('[data-worker-role]').forEach(select => select.addEventListener('change', changeWorkerRole));
  target.querySelectorAll('[data-remove-worker]').forEach(button => button.addEventListener('click', removeWorker));
}

// No borra la cuenta del usuario: solo le cambia el rol a customer.
async function removeWorker(event) {
  if (!confirm('¿Quitar a esta persona el acceso de trabajador? Su cuenta seguirá existiendo como cliente.')) return;
  const { error } = await db.from('profiles').update({ role:'customer' }).eq('id', event.currentTarget.dataset.removeWorker).in('role', ['worker', 'boss']);
  if (error) return toast('No se pudieron retirar los permisos.', true);
  toast('Permisos de trabajador retirados.');
  await loadWorkers();
}

async function changeWorkerRole(event) {
  const { error } = await db.from('profiles').update({ role:event.currentTarget.value }).eq('id', event.currentTarget.dataset.workerRole).in('role', ['worker', 'boss']);
  if (error) return toast('No se pudo cambiar el rol.', true);
  toast(`Rol cambiado a ${roleNames[event.currentTarget.value].toLowerCase()}.`);
  await loadWorkers();
}

// 33. Catalogo admin
// Carga todos los productos, incluidos ocultos/inactivos, para que admin/jefe
// pueda revisar, editar o borrar materiales desde el panel.
async function loadAdminProducts() {
  await loadProducts(true); renderAdminProducts();
}

// 34. Formulario de materiales
// Conecta el formulario de crear/editar material y actualiza la vista previa de
// imagen en vivo mientras se escribe la URL.
function initProductForm() {
  const form = document.querySelector('#product-form');
  if (!form) return;
  form.addEventListener('submit', saveProduct);
  document.querySelector('#cancel-product-edit')?.addEventListener('click', resetProductForm);
  form.elements.image_url.addEventListener('input', updateProductFormPreview);
  updateProductFormPreview();
}

// 35. Vista previa de imagenes
// Intenta cargar la URL en un <img>. Si carga, marca la imagen como disponible;
// si falla, ensena un aviso para detectar enlaces rotos antes de publicar.
function showImagePreview(container, url, statusTarget = null) {
  if (!container) return;
  const image = container.querySelector('img');
  const errorMessage = container.querySelector('.image-preview-error');
  const source = String(url || '').trim();
  const showError = message => {
    container.classList.add('is-error');
    image.hidden = true;
    errorMessage.hidden = false;
    if (statusTarget) { statusTarget.textContent = message; statusTarget.className = 'image-preview-status is-error'; }
  };
  container.classList.remove('is-error');
  image.hidden = false;
  errorMessage.hidden = true;
  if (statusTarget) { statusTarget.textContent = 'Comprobando imagen…'; statusTarget.className = 'image-preview-status'; }
  if (!source) { image.removeAttribute('src'); showError('Escribe una URL para comprobar la imagen.'); return; }
  image.onload = () => {
    container.classList.remove('is-error');
    image.hidden = false;
    errorMessage.hidden = true;
    if (statusTarget) { statusTarget.textContent = 'Imagen disponible.'; statusTarget.className = 'image-preview-status is-valid'; }
  };
  image.onerror = () => showError('La imagen no se puede cargar. Revisa la URL antes de guardar.');
  image.src = source;
}

function updateProductFormPreview() {
  const form = document.querySelector('#product-form');
  if (!form) return;
  showImagePreview(
    document.querySelector('#product-preview-frame'),
    form.elements.image_url.value,
    document.querySelector('#product-image-status')
  );
}

// 36. Lista admin de materiales
// Pinta cada material con miniatura, precio, categoria y acciones. La miniatura
// tambien usa showImagePreview para detectar imagenes rotas en la lista.
function renderAdminProducts() {
  const target = document.querySelector('#admin-products');
  target.innerHTML = products.map(product => `<article class="admin-product-row"><div class="admin-product-thumb image-preview-frame" data-image-url="${escapeHTML(product.image_url || '')}"><img alt="Vista previa de ${escapeHTML(product.name)}"><span class="image-preview-error" hidden>Sin imagen</span></div><div><h3>${escapeHTML(product.name)} · ${money(product.price)}</h3><p>${escapeHTML(product.category)}${product.active ? '' : ' · Oculto'}</p></div><div class="row-actions"><button type="button" data-edit-product="${product.id}">Editar</button><button class="danger" type="button" data-delete-product="${product.id}">Eliminar</button></div></article>`).join('');
  target.querySelectorAll('[data-image-url]').forEach(preview => showImagePreview(preview, preview.dataset.imageUrl));
  target.querySelectorAll('[data-edit-product]').forEach(button => button.addEventListener('click', editProduct));
  target.querySelectorAll('[data-delete-product]').forEach(button => button.addEventListener('click', deleteProduct));
}

// 37. Guardar material
// Si el campo hidden id tiene valor, actualiza un producto existente. Si no lo
// tiene, inserta uno nuevo en la tabla products.
async function saveProduct(event) {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const payload = { name:data.get('name').trim(), price:Number(data.get('price')), category:data.get('category').trim(), image_url:data.get('image_url').trim(), description:data.get('description').trim(), active:true };
  const id = data.get('id');
  const result = id ? await db.from('products').update(payload).eq('id', id) : await db.from('products').insert(payload);
  if (result.error) return toast('No se pudo guardar el material.', true);
  toast(id ? 'Material actualizado.' : 'Material añadido.'); resetProductForm(); await loadAdminProducts();
}

// Rellena el formulario con los datos del producto seleccionado para editarlo.
function editProduct(event) {
  const product = products.find(item => String(item.id) === event.currentTarget.dataset.editProduct); const form = document.querySelector('#product-form');
  ['id','name','price','category','image_url','description'].forEach(key => form.elements[key].value = product[key] ?? '');
  document.querySelector('#product-form-title').textContent = 'Editar material'; document.querySelector('#cancel-product-edit').hidden = false; updateProductFormPreview(); form.scrollIntoView({ behavior:'smooth' });
}

// Limpia el formulario y vuelve al modo "Anadir material".
function resetProductForm() {
  const form = document.querySelector('#product-form'); form.reset(); form.elements.id.value = ''; form.elements.image_url.value = 'assets/logo.png';
  document.querySelector('#product-form-title').textContent = 'Añadir material'; document.querySelector('#cancel-product-edit').hidden = true; updateProductFormPreview();
}

// Intenta borrar el producto. Si ya aparece en pedidos, Supabase puede impedirlo
// para no romper el historial de pedidos antiguos.
async function deleteProduct(event) {
  if (!confirm('¿Eliminar este material del catálogo?')) return;
  const { error } = await db.from('products').delete().eq('id', event.currentTarget.dataset.deleteProduct);
  if (error) return toast('No se puede eliminar porque ya aparece en pedidos. Puedes editarlo u ocultarlo.', true);
  toast('Material eliminado.'); await loadAdminProducts();
}

// 38. Formulario publico de dudas
// Envia consultas a la tabla inquiries. Valida que el telefono sean exactamente
// 10 numeros antes de intentar guardar.
function initInquiryForm() {
  const form = document.querySelector('#inquiry-form');
  if (!form) return;
  if (currentProfile) {
    form.elements.name.value ||= currentProfile.full_name || '';
    form.elements.phone.value ||= currentProfile.phone || '';
  }
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
    if (!/^[0-9]{10}$/.test(payload.phone)) { messageTarget.textContent = 'El teléfono debe contener exactamente 10 números.'; return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.textContent = 'Enviando…'; messageTarget.textContent = '';
    const { error } = await db.from('inquiries').insert(payload);
    button.disabled = false; button.innerHTML = 'Enviar duda <span>↗</span>';
    if (error) { messageTarget.textContent = 'No se pudo enviar la duda. Inténtalo de nuevo.'; return; }
    form.reset(); messageTarget.textContent = 'Duda enviada correctamente.'; toast('Duda enviada con éxito.');
  });
}

// 39. Avisos por parametros de URL
// Permite mostrar avisos o abrir el carrito cuando la pagina viene con
// parametros como ?duda=ok o ?carrito=1.
function showQueryToast() {
  const params = new URLSearchParams(location.search);
  if (params.get('duda') === 'ok') { toast('Duda enviada con éxito.'); history.replaceState({}, '', location.pathname); }
  if (params.get('carrito') === '1') setTimeout(openCart, 250);
}

// 40. Arranque general
// Este es el orden en el que se enciende la web. Cada init comprueba si su zona
// existe, por eso el mismo script sirve para inicio, productos, cuenta y panel.
async function start() {
  initNavigation(); initCarousel(); initNumericInputs(); await loadSession();
  createCartDrawer();
  initProductForm();
  await initCatalog(); await initAccountPage(); await initPanel(); initInquiryForm();
  showQueryToast();
}

start();
