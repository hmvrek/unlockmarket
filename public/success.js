import { api, element } from './shared.js'

const status = document.querySelector('#claim-status')
const results = document.querySelector('#claim-results')
const codeList = document.querySelector('#code-list')
const retry = document.querySelector('#retry-claim')
const sessionId = new URLSearchParams(location.search).get('session_id')
let attempts = 0
let inFlight = false

function showCode({ name, code }) {
  const item = element('li', undefined, 'code-item')
  const value = element('code', code)
  value.setAttribute('aria-label', `Kod aktywacyjny dla ${name}`)
  const copy = element('button', 'Kopiuj kod', 'button button-outline')
  copy.type = 'button'
  copy.setAttribute('aria-label', `Skopiuj kod dla produktu: ${name}`)
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(code)
      copy.textContent = 'Skopiowano'
    } catch {
      status.textContent = 'Nie można skopiować automatycznie. Zaznacz kod i skopiuj go ręcznie.'
    }
  })
  item.append(element('strong', name), value, copy)
  return item
}

async function checkPayment() {
  if (!sessionId) {
    status.textContent = 'Brak identyfikatora płatności. Wróć do sklepu lub skontaktuj się ze sprzedawcą.'
    return
  }
  if (inFlight) return
  inFlight = true
  retry.disabled = true
  try {
    const result = await api(`/api/claim?session_id=${encodeURIComponent(sessionId)}`)
    if (result.pending) {
      attempts += 1
      status.textContent = 'Płatność jest jeszcze przetwarzana. Ta strona sprawdzi jej status ponownie za chwilę.'
      retry.hidden = false
      if (attempts <= 10) window.setTimeout(checkPayment, 5000)
      return
    }
    if (!Array.isArray(result.codes) || result.codes.length === 0) {
      throw new Error('Nie znaleziono kodów dla tego zamówienia. Skontaktuj się ze sprzedawcą.')
    }
    codeList.replaceChildren(...result.codes.map(showCode))
    results.hidden = false
    retry.hidden = true
    status.textContent = 'Płatność potwierdzona. Zamówienie zostało zrealizowane.'
  } catch (error) {
    status.textContent = error.message
    retry.hidden = false
  } finally {
    inFlight = false
    retry.disabled = false
  }
}

retry.addEventListener('click', () => {
  attempts = 0
  checkPayment()
})

checkPayment()
