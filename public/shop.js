import { api, categories, element, money } from './shared.js'

const authParams = new URLSearchParams(location.hash.slice(1))
if (['invite_token', 'recovery_token', 'confirmation_token', 'access_token'].some((name) => authParams.has(name))) {
  location.replace(`/admin/${location.hash}`)
}

const products = document.querySelector('#products')
const template = document.querySelector('#product-card')
const filters = document.querySelector('#filters')
const status = document.querySelector('#catalog-status')
const more = document.querySelector('#load-more')
const dialog = document.querySelector('#cart')
const cartItems = document.querySelector('#cart-items')
const cartMessage = document.querySelector('#cart-message')
const checkout = document.querySelector('#checkout')
const openCart = document.querySelector('#open-cart')
const cart = new Map()
let nextPage = 1
let currentRequest
let orderId

function displayProduct(product) {
  const fragment = template.content.cloneNode(true)
  fragment.querySelector('.product').dataset.category = product.category
  fragment.querySelector('.product-category').textContent = categories[product.category]
  fragment.querySelector('h3').textContent = product.name
  fragment.querySelector('.product-description').textContent = product.description
  fragment.querySelector('.price').textContent = money(product.priceGrosz)
  const add = fragment.querySelector('.add')
  add.setAttribute('aria-label', `Dodaj do koszyka: ${product.name}`)
  add.addEventListener('click', () => {
    const count = cart.get(product.id)?.quantity ?? 0
    if ((cart.size < 10 || count) && count < 10) {
      cart.set(product.id, { ...product, quantity: count + 1 })
      orderId = undefined
      renderCart()
      cartMessage.textContent = `Dodano: ${product.name}.`
    } else {
      cartMessage.textContent = 'Koszyk pomieści do 10 produktów w maksymalnie 10 sztukach każdy.'
    }
    if (!dialog.open) dialog.showModal()
  })
  products.append(fragment)
}

async function loadProducts(reset = false) {
  if (reset) {
    currentRequest?.abort()
    nextPage = 1
    products.replaceChildren()
  }
  const controller = new AbortController()
  currentRequest = controller
  const params = new URLSearchParams(new FormData(filters))
  params.set('page', nextPage)
  more.hidden = true
  status.hidden = false
  status.textContent = 'Ładowanie produktów…'
  try {
    const result = await api(`/api/products?${params}`, { signal: controller.signal })
    if (controller.signal.aborted) return
    result.records.forEach(displayProduct)
    status.hidden = Boolean(products.childElementCount)
    status.textContent = params.get('q') || params.get('category') ? 'Brak produktów pasujących do wyszukiwania.' : 'W katalogu nie ma jeszcze produktów.'
    more.hidden = !result.hasMore
    more.textContent = 'Pokaż więcej'
    nextPage += 1
  } catch (error) {
    if (controller.signal.aborted) return
    status.textContent = error.message
    more.textContent = 'Spróbuj ponownie'
    more.hidden = false
  }
}

function total() {
  return [...cart.values()].reduce((sum, item) => sum + item.priceGrosz * item.quantity, 0)
}

function renderCart() {
  document.querySelector('#cart-count').textContent = [...cart.values()].reduce((count, item) => count + item.quantity, 0)
  checkout.hidden = cart.size === 0
  cartItems.replaceChildren()
  if (!cart.size) cartItems.append(element('p', 'Twój koszyk jest pusty.', 'notice'))
  for (const item of cart.values()) {
    const row = element('div', undefined, 'cart-item')
    const details = element('div')
    details.append(element('strong', item.name), element('small', `${item.quantity} × ${money(item.priceGrosz)}`))
    const remove = element('button', 'Usuń', 'button button-outline')
    remove.type = 'button'
    remove.setAttribute('aria-label', `Usuń z koszyka: ${item.name}`)
    remove.addEventListener('click', () => {
      cart.delete(item.id)
      orderId = undefined
      renderCart()
      cartMessage.textContent = `Usunięto: ${item.name}.`
      document.querySelector('#close-cart').focus()
    })
    row.append(details, remove)
    cartItems.append(row)
  }
  document.querySelector('#cart-total').textContent = money(total())
}

async function refreshCart() {
  await Promise.all([...cart.values()].map(async (item) => {
    try {
      const current = await api(`/api/products/${item.id}`)
      if (cart.has(item.id)) cart.set(item.id, { ...current, quantity: item.quantity })
    } catch (error) {
      if (error.status === 404) cart.delete(item.id)
    }
  }))
  renderCart()
}

filters.addEventListener('submit', (event) => { event.preventDefault(); loadProducts(true) })
filters.elements.category.addEventListener('change', () => loadProducts(true))
more.addEventListener('click', () => loadProducts())
openCart.addEventListener('click', () => { cartMessage.textContent = ''; dialog.showModal() })
document.querySelector('#close-cart').addEventListener('click', () => dialog.close())
checkout.elements.email.addEventListener('input', () => { orderId = undefined })

checkout.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!cart.size) return
  const button = checkout.querySelector('button')
  button.disabled = true
  cartItems.querySelectorAll('button').forEach((item) => { item.disabled = true })
  checkout.elements.email.readOnly = true
  const data = new FormData(checkout)
  orderId ??= crypto.randomUUID()
  cartMessage.textContent = 'Zapisywanie zamówienia…'
  try {
    const result = await api('/api/orders', {
      method: 'POST',
      body: { id: orderId, email: data.get('email'), website: data.get('website'), totalGrosz: total(), items: [...cart.values()].map(({ id, quantity }) => ({ id, quantity })) },
    })
    cart.clear()
    checkout.reset()
    orderId = undefined
    renderCart()
    cartMessage.textContent = `Zamówienie zapisane (${result.id.slice(0, 8)}). Sprzedawca skontaktuje się z Tobą. Nie pobrano opłaty.`
  } catch (error) {
    if (error.status === 409) {
      orderId = undefined
      await refreshCart()
      loadProducts(true)
    }
    cartMessage.textContent = error.message
  } finally {
    button.disabled = false
    checkout.elements.email.readOnly = false
    cartItems.querySelectorAll('button').forEach((item) => { item.disabled = false })
  }
})

renderCart()
loadProducts()
