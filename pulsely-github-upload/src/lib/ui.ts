import { createElement, LayoutDashboard, Globe, Files, ClipboardCheck, CircleAlert, Bell, ChartNoAxesCombined, Users, Settings, Search, LogOut, Plus, X, Copy, Trash2, ArrowLeft, ExternalLink, RefreshCw, ChevronDown, Menu, Check, Mail, ShieldCheck, Download, Clock, Activity, Link, MoreHorizontal } from 'lucide'

const icons = { overview: LayoutDashboard, websites: Globe, pages: Files, reviews: ClipboardCheck, issues: CircleAlert, alerts: Bell, reports: ChartNoAxesCombined, team: Users, settings: Settings, search: Search, logout: LogOut, plus: Plus, close: X, copy: Copy, trash: Trash2, back: ArrowLeft, external: ExternalLink, refresh: RefreshCw, down: ChevronDown, menu: Menu, check: Check, mail: Mail, shield: ShieldCheck, download: Download, clock: Clock, activity: Activity, link: Link, more: MoreHorizontal }
export type IconName = keyof typeof icons
export function icon(name: IconName, size = 18) {
  return createElement(icons[name], { width: size, height: size, 'aria-hidden': 'true', 'stroke-width': 1.75 }).outerHTML
}
export function escapeHtml(value: unknown) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : fallback
}
export function toast(message: string, kind: 'success' | 'error' | 'info' = 'success') {
  let region = document.querySelector<HTMLDivElement>('#toast-region')
  if (!region) {
    region = document.createElement('div')
    region.id = 'toast-region'
    region.setAttribute('aria-live', 'polite')
    document.body.append(region)
  }
  const node = document.createElement('div')
  node.className = `app-toast ${kind}`
  node.innerHTML = `${icon(kind === 'error' ? 'issues' : kind === 'success' ? 'check' : 'activity')}<span>${escapeHtml(message)}</span><button class="icon-button" aria-label="Dismiss notification">${icon('close', 16)}</button>`
  node.querySelector('button')!.onclick = () => node.remove()
  region.append(node)
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000)
}
export function openDialog(title: string, body: string, options: { wide?: boolean } = {}) {
  const previous = document.activeElement as HTMLElement | null
  const dialog = document.createElement('dialog')
  dialog.className = `app-dialog ${options.wide ? 'wide' : ''}`
  dialog.setAttribute('aria-labelledby', 'dialog-title')
  dialog.innerHTML = `<header class="dialog-header"><h2 id="dialog-title">${escapeHtml(title)}</h2><button class="icon-button" aria-label="Close dialog">${icon('close')}</button></header><div class="dialog-body">${body}</div>`
  document.body.append(dialog)
  dialog.querySelector('.dialog-header button')!.addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close() } })
  dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus() }, { once: true })
  dialog.showModal()
  return dialog
}
export function confirmAction(title: string, description: string, label = 'Confirm') {
  return new Promise<boolean>(resolve => {
    const dialog = openDialog(title, `<p class="muted">${escapeHtml(description)}</p><div class="dialog-actions"><button class="button secondary" data-cancel>Cancel</button><button class="button danger" data-confirm>${escapeHtml(label)}</button></div>`)
    let confirmed = false
    dialog.querySelector('[data-cancel]')!.addEventListener('click', () => dialog.close())
    dialog.querySelector('[data-confirm]')!.addEventListener('click', () => { confirmed = true; dialog.close() })
    dialog.addEventListener('close', () => resolve(confirmed), { once: true })
  })
}
export async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard') }
  catch { openDialog('Copy link', `<label>Link<input readonly value="${escapeHtml(value)}" autofocus></label>`).querySelector('input')!.select() }
}
export function downloadCsv(name: string, rows: unknown[][]) {
  const csv = rows.map(row => row.map(value => {
    let text = String(value ?? '')
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
