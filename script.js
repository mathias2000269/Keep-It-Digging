const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.main-nav');

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    nav.classList.toggle('is-open', !open);
  });
}

const page = document.body.dataset.page;
document.querySelectorAll('.main-nav a').forEach(link => {
  const href = link.getAttribute('href');
  if ((page === 'inicio' && href === 'index.html') || href === `${page}.html`) {
    link.setAttribute('aria-current', 'page');
  }
});

const slides = [...document.querySelectorAll('.carousel-slide')];
const dots = [...document.querySelectorAll('.carousel-dots button')];
let currentSlide = 0;
let carouselTimer;

function showSlide(index) {
  slides[currentSlide]?.classList.remove('is-active');
  dots[currentSlide]?.classList.remove('is-active');
  currentSlide = index;
  slides[currentSlide]?.classList.add('is-active');
  dots[currentSlide]?.classList.add('is-active');
}

function startCarousel() {
  if (slides.length < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  clearInterval(carouselTimer);
  carouselTimer = setInterval(() => showSlide((currentSlide + 1) % slides.length), 99999000);
}

dots.forEach((dot, index) => dot.addEventListener('click', () => {
  showSlide(index);
  startCarousel();
}));
startCarousel();

document.querySelectorAll('.price-button').forEach(button => {
  button.addEventListener('click', () => {
    button.closest('.price-reveal').classList.add('is-revealed');
    button.remove();
  });
});

const orderForm = document.querySelector('.order-form');
const materialSelect = document.querySelector('#order-material');
const quantityInput = document.querySelector('#order-quantity');
const addOrderButton = document.querySelector('#add-order-item');
const orderItemsContainer = document.querySelector('#order-items');
const orderSummary = document.querySelector('#order-summary');
const orderCount = document.querySelector('#order-count');
const orderError = document.querySelector('#order-error');
const orderItems = [];

function updateOrderSummary() {
  orderSummary.value = orderItems.map(item => `${item.quantity} unidades de ${item.material}`).join('\n');
  orderCount.textContent = `${orderItems.length} ${orderItems.length === 1 ? 'producto' : 'productos'}`;
  orderError.textContent = '';
}

function renderOrderItems() {
  orderItemsContainer.replaceChildren();

  if (!orderItems.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-order';
    empty.textContent = 'Todavía no has añadido ningún material.';
    orderItemsContainer.append(empty);
    updateOrderSummary();
    return;
  }

  orderItems.forEach(item => {
    const card = document.createElement('article');
    card.className = 'order-item';
    card.setAttribute('role', 'listitem');

    const quantity = document.createElement('strong');
    quantity.textContent = item.quantity;
    const description = document.createElement('span');
    description.textContent = `unidades de ${item.material}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-order-item';
    remove.setAttribute('aria-label', `Quitar ${item.quantity} unidades de ${item.material}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const index = orderItems.findIndex(orderItem => orderItem.id === item.id);
      if (index !== -1) orderItems.splice(index, 1);
      renderOrderItems();
    });

    card.append(quantity, description, remove);
    orderItemsContainer.append(card);
  });

  updateOrderSummary();
}

function addOrderItem() {
  const material = materialSelect.value;
  const quantity = Number(quantityInput.value);

  if (!material) {
    orderError.textContent = 'Selecciona un material antes de añadirlo.';
    materialSelect.focus();
    return;
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    orderError.textContent = 'La cantidad debe ser un número entero mayor que cero.';
    quantityInput.focus();
    return;
  }

  orderItems.push({ id: `${Date.now()}-${orderItems.length}`, material, quantity });
  renderOrderItems();
  materialSelect.value = '';
  quantityInput.value = '';
  materialSelect.focus();
}

addOrderButton?.addEventListener('click', addOrderItem);
quantityInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addOrderItem();
  }
});

orderForm?.addEventListener('submit', event => {
  if (!orderItems.length) {
    event.preventDefault();
    orderError.textContent = 'Añade al menos un material antes de enviar el pedido.';
    materialSelect.focus();
    return;
  }
  updateOrderSummary();
});
const toast = document.querySelector('#toast');
const params = new URLSearchParams(window.location.search);

if (toast && params.get('pedido') === 'ok') {
  toast.hidden = false;
  toast.classList.add('is-visible');

  setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove('is-visible');

    window.history.replaceState({}, document.title, window.location.pathname);
  }, 3000);
}