export const categories = { license: 'Klucze i licencje', addon: 'Dodatki cyfrowe', other: 'Inne' }

const currency = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' })
export const money = (value) => currency.format(value / 100)

export async function api(path, options = {}) {
  const { body, ...request } = options
  const response = await fetch(path, {
    ...request,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) {
    throw Object.assign(new Error(result?.error ?? 'Nie udało się połączyć ze sklepem. Spróbuj ponownie.'), { status: response.status })
  }
  return result
}

export function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
