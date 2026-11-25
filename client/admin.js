import { acceptInvite, getUser, handleAuthCallback, login, logout, requestPasswordRecovery, updateUser } from '@netlify/identity'
import { api, categories, element, money } from '../public/shared.js'

const loginForm = document.querySelector('#login')
const passwordForm = document.querySelector('#set-password')
const authMessage = document.querySelector('#auth-message')
const authPanel = document.querySelector('#auth-panel')
const dashboard = document.querySelector('#dashboard')
const signOut = document.querySelector('#sign-out')
const productForm = document.querySelector('#product-form')
const editMessage = document.querySelector('#edit-message')
const cancelEdit = document.querySelector('#cancel-edit')
const statuses = { new: 'Nowe', confirmed: 'Potwierdzone', completed: 'Zrealizowane', cancelled: 'Anulowane' }
const dateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' })
let callback
let editing

function setAuthMessage(message) {
  authMessage.textContent = message
  authMessage.hidden = !message
}

function showLogin(message = '') {
  dashboard.hidden = true
  signOut.hidden = true
  authPanel.hidden = false
  loginForm.hidden = false
  passwordForm.hidden = true
  resetEditor()
  document.querySelector('#admin-products').replaceChildren()
  document.querySelector('#orders').replaceChildren()
  setAuthMessage(message)
}

async function showDashboard() {
  await api('/api/admin/session')
  setAuthMessage('')
  authPanel.hidden = true
  dashboard.hidden = false
  signOut.hidden = false
  await Promise.all([productsList.load(true), ordersList.load(true)])
}

function isAuthError(error) {
  if (error.status === 401 || error.status === 403) {
    showLogin(error.message)
    return true
  }
  return false
}

async function submit(form, handler) {
  const button = form.querySelector('[type="submit"]')
  button.disabled = true
  try {
    await handler()
  } finally {
    button.disabled = false
  }
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault()
  submit(loginForm, async () => {
    const data = new FormData(loginForm)
    setAuthMessage('Logowanie…')
    try {
      await login(data.get('email').trim(), data.get('password'))
    } catch {
      setAuthMessage('Nie udało się zalogować. Sprawdź e-mail i hasło oraz ważność zaproszenia.')
      return
    } finally {
      loginForm.elements.password.value = ''
    }
    await showDashboard().catch((error) => setAuthMessage(error.message))
  })
})

document.querySelector('#recover').addEventListener('click', async (event) => {
  const email = loginForm.elements.email
  if (!email.reportValidity()) return
  const button = event.currentTarget
  button.disabled = true
  try {
    await requestPasswordRecovery(email.value.trim())
  } catch {
    setAuthMessage('Nie udało się wysłać linku. Spróbuj ponownie za chwilę.')
    return
  } finally {
    button.disabled = false
  }
  setAuthMessage('Jeśli konto istnieje, otrzymasz e-mail z linkiem do zmiany hasła.')
})

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault()
  submit(passwordForm, async () => {
    const password = passwordForm.elements.password.value
    if (!callback) return
    try {
      if (callback.type === 'invite') await acceptInvite(callback.token, password)
      else await updateUser({ password })
    } catch {
      setAuthMessage('Nie udało się ustawić hasła. Sprawdź, czy link nadal jest ważny.')
      return
    } finally {
      passwordForm.reset()
    }
    callback = undefined
    showLogin('Hasło zostało ustawione.')
    await showDashboard().catch((error) => setAuthMessage(`Hasło zostało ustawione. ${error.message}`))
  })
})

signOut.addEventListener('click', async () => {
  signOut.disabled = true
  try {
    await logout()
    showLogin('Wylogowano z panelu.')
  } catch {
    showLogin('Panel zamknięto. Zaloguj się ponownie, aby kontynuować.')
  } finally {
    signOut.disabled = false
  }
})

function resetEditor() {
  editing = undefined
  productForm.reset()
  document.querySelector('#edit-title').textContent = 'Nowy produkt'
  cancelEdit.hidden = true
  editMessage.textContent = ''
}

function editProduct(product) {
  editing = product.id
  productForm.elements.name.value = product.name
  productForm.elements.description.value = product.description
  productForm.elements.category.value = product.category
  productForm.elements.price.value = (product.priceGrosz / 100).toFixed(2).replace('.', ',')
  productForm.elements.published.checked = product.published
  document.querySelector('#edit-title').textContent = 'Edytuj produkt'
  cancelEdit.hidden = false
  editMessage.textContent = ''
  productForm.elements.name.focus()
}

cancelEdit.addEventListener('click', () => { resetEditor(); productForm.elements.name.focus() })

productForm.addEventListener('submit', (event) => {
  event.preventDefault()
  submit(productForm, async () => {
    const data = new FormData(productForm)
    const price = data.get('price').trim()
    if (!/^\d{1,4}([,.]\d{1,2})?$/.test(price)) {
      editMessage.textContent = 'Wpisz cenę od 0,01 do 9 999,99 zł.'
      productForm.elements.price.focus()
      return
    }
    const priceGrosz = Math.round(Number(price.replace(',', '.')) * 100)
    editMessage.textContent = 'Zapisywanie produktu…'
    try {
      await api(editing ? `/api/admin/products/${editing}` : '/api/admin/products', {
        method: editing ? 'PATCH' : 'POST',
        body: { name: data.get('name'), description: data.get('description'), category: data.get('category'), priceGrosz, published: data.has('published') },
      })
      resetEditor()
      editMessage.textContent = data.has('published') ? 'Produkt zapisany i widoczny w sklepie.' : 'Produkt zapisany jako szkic.'
      await productsList.load(true)
    } catch (error) {
      if (!isAuthError(error)) editMessage.textContent = error.message
    }
  })
})

function paginated({ path, target, message, more, empty, render }) {
  const list = document.querySelector(target)
  const feedback = document.querySelector(message)
  const button = document.querySelector(more)
  let page = 1
  let active
  async function load(reset = false) {
    if (reset) {
      active?.abort()
      page = 1
      list.replaceChildren()
    }
    const controller = new AbortController()
    active = controller
    feedback.textContent = 'Ładowanie…'
    button.hidden = true
    try {
      const result = await api(`${path}?page=${page}`, { signal: controller.signal })
      if (controller.signal.aborted || dashboard.hidden) return
      result.records.forEach((record) => list.append(render(record)))
      feedback.textContent = list.childElementCount ? '' : empty
      button.hidden = !result.hasMore
      button.textContent = 'Pokaż więcej'
      page += 1
    } catch (error) {
      if (controller.signal.aborted || dashboard.hidden || isAuthError(error)) return
      feedback.textContent = error.message
      button.textContent = 'Spróbuj ponownie'
      button.hidden = false
    }
  }
  button.addEventListener('click', () => load())
  return { load }
}

const productsList = paginated({
  path: '/api/admin/products', target: '#admin-products', message: '#admin-products-message', more: '#more-products',
  empty: 'Nie masz jeszcze produktów. Dodaj pierwszy w edytorze.',
  render(product) {
    const row = element('article', undefined, 'record product-record')
    const details = element('div')
    details.append(element('h3', product.name), element('p', `${categories[product.category]} · ${money(product.priceGrosz)}`),
      element('small', product.published ? 'Opublikowany' : 'Szkic', product.published ? 'badge active' : 'badge'))
    const edit = element('button', 'Edytuj', 'button button-outline')
    edit.setAttribute('aria-label', `Edytuj: ${product.name}`)
    edit.addEventListener('click', () => editProduct(product))
    row.append(details, edit)
    return row
  },
})

const ordersList = paginated({
  path: '/api/admin/orders', target: '#orders', message: '#orders-message', more: '#more-orders',
  empty: 'Nie wpłynęły jeszcze żadne zamówienia.',
  render(order) {
    const row = element('article', undefined, 'record order-record')
    row.append(element('p', `#${order.id.slice(0, 8)} · ${dateFormat.format(new Date(order.createdAt))}`, 'eyebrow'))
    const contact = element('a', order.email)
    contact.href = `mailto:${encodeURIComponent(order.email)}`
    row.append(contact)
    const items = element('ul')
    for (const item of order.items) items.append(element('li', `${item.quantity} × ${item.name} (${money(item.priceGrosz)} za szt.)`))
    row.append(items, element('strong', `Razem: ${money(order.totalGrosz)}`))
    const form = element('form', undefined, 'order-actions')
    const label = element('label', undefined, 'field')
    const select = element('select')
    for (const [value, name] of Object.entries(statuses)) {
      const option = element('option', name)
      option.value = value
      select.append(option)
    }
    select.value = order.status
    label.append(element('span', 'Status zamówienia'), select)
    const save = element('button', 'Zapisz status', 'button button-outline')
    save.type = 'submit'
    const message = element('p', '', 'message')
    message.role = 'status'
    form.append(label, save)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit(form, async () => {
        message.textContent = 'Zapisywanie…'
        try {
          await api(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: { status: select.value } })
          message.textContent = 'Status zapisany.'
        } catch (error) {
          if (!isAuthError(error)) message.textContent = error.message
        }
      })
    })
    row.append(form, message)
    return row
  },
})

document.querySelector('#refresh-orders').addEventListener('click', () => ordersList.load(true))

try {
  if (location.hash) {
    try {
      callback = await handleAuthCallback()
    } finally {
      history.replaceState(null, '', location.pathname)
    }
  }
  if (callback?.type === 'invite' || callback?.type === 'recovery') {
    authPanel.hidden = false
    passwordForm.hidden = false
    loginForm.hidden = true
    setAuthMessage('')
  } else if (await getUser()) {
    await showDashboard()
  } else {
    showLogin()
  }
} catch (error) {
  showLogin(error.status === 403 ? error.message : 'Nie udało się otworzyć sesji. Zaloguj się ponownie lub użyj nowego linku.')
}
