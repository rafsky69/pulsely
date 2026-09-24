import './style.css'
import { icon, toast, openDialog, confirmAction, copyText, errorMessage, type IconName } from './lib/ui'
import { loadWorkspaces, setWorkspace, getTeam, inviteMember, inviteLink, revokeInvite, acceptInvite, changeMember, renameWorkspace, canManage, type Workspace } from './lib/team'

import { supabase } from './lib/supabase'

import {
  signIn,
  signOut,
  signUp,
  getUser,
} from './lib/auth'

import {
  getWebsites,
  addWebsite,
  deleteWebsite,
  type Website,
} from './lib/websites'

import {
  scanWebsite,
} from './lib/scanner'

import {
  getSubscription,
  openCheckout,
  openBillingPortal,
  type SubscriptionView,
} from './lib/billing'

import {
  PLANS,
  PLAN_ORDER,
  limitLabel,
  uptimeLabel,
  scanLabel,
  type PlanId,
} from './lib/plans'

import {
  getPages,
  getReviewQueue,
  getIssues,
  getAlerts,
  getReports,
  getUsage,
  generateReport,
  getPageLinks,
  getMonitoringRuns,
  markAlertRead,
  completeReview,
  updateIssueStatus,
  type PageRecord,
  type IssueRecord,
  type AlertRecord,
  type ReportRecord,
  type PageLinkRecord,
} from './lib/appdata'

const app =
  document.querySelector<HTMLDivElement>('#app')!

let currentView = 'overview'
let selectedWebsiteId: string | null = null
let selectedPageId: string | null = null
let selectedIssueId: string | null = null
let selectedAlertId: string | null = null
let selectedReportId: string | null = null

function esc(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatDate(value: string | null) {
  if (!value) return 'Never'

  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
  }).format(new Date(value))
}

function percent(used: number, limit: number) {
  if (!Number.isFinite(limit)) return 0
  if (limit <= 0) return 0

  return Math.min(
    100,
    Math.round((used / limit) * 100)
  )
}

function faviconUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}/favicon.ico`
  } catch {
    return ''
  }
}

function websiteInitial(value: string) {
  const cleaned = value.trim()
  return cleaned ? cleaned.charAt(0).toUpperCase() : 'W'
}

function healthLabel(value: string) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) =>
      letter.toUpperCase()
    )
}

function pathLabel(value: string) {
  try {
    const url = new URL(value)
    return `${url.pathname}${url.search}` || '/'
  } catch {
    return value
  }
}

function websiteFor(
  state: AppState,
  websiteId: string
) {
  return state.websites.find(
    (site) => site.id === websiteId
  )
}

function issuesForPage(
  state: AppState,
  pageId: string
) {
  return state.issues.filter(
    (issue) =>
      issue.page_id === pageId &&
      issue.status !== 'resolved' &&
      issue.status !== 'ignored'
  )
}

function issuesForWebsite(
  state: AppState,
  websiteId: string
) {
  return state.issues.filter(
    (issue) =>
      issue.website_id === websiteId &&
      issue.status !== 'resolved' &&
      issue.status !== 'ignored'
  )
}

function healthScore(
  page: PageRecord,
  issues: IssueRecord[]
) {
  let score = 100

  if ((page.http_status ?? 200) >= 500) score -= 55
  else if ((page.http_status ?? 200) >= 400) score -= 38

  if ((page.response_ms ?? 0) > 3000) score -= 14
  if (!page.title) score -= 12
  if (!page.meta_description) score -= 8
  if ((page.h1_count ?? 1) === 0) score -= 10
  if ((page.h1_count ?? 1) > 1) score -= 4
  if ((page.redirect_count ?? 0) >= 2) score -= 7

  for (const issue of issues) {
    if (issue.severity === 'critical') score -= 28
    if (issue.severity === 'high') score -= 18
    if (issue.severity === 'warning') score -= 9
    if (issue.severity === 'info') score -= 4
  }

  return Math.max(0, Math.min(100, score))
}

function scoreBand(score: number) {
  if (score >= 90) return 'healthy'
  if (score >= 72) return 'needs_attention'
  if (score >= 45) return 'action_required'
  return 'critical'
}

function sparkline(values: number[]) {
  const cleaned =
    values
      .filter((value) =>
        Number.isFinite(value)
      )
      .slice(0, 12)
      .reverse()

  if (!cleaned.length) {
    return '<div class="sparkline muted-line"></div>'
  }

  const max =
    Math.max(...cleaned, 1)

  return `
    <div class="sparkline">
      ${cleaned
        .map(
          (value) => `
            <span style="height:${Math.max(12, Math.round((value / max) * 100))}%"></span>
          `
        )
        .join('')}
    </div>
  `
}

function emptyState(
  title: string,
  text: string
) {
  return `
    <div class="empty-state">
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
    </div>
  `
}

function authScreen() {
  app.innerHTML = `
    <div class="auth-page">
      <section class="auth-card">
        <div class="auth-brand">
          <div class="logo-box">P</div>
          <strong>Pulsely</strong>
        </div>

        <h1>Welcome to Pulsely</h1>

        <p class="muted">
          ${location.hash.startsWith('#invite=') ? 'Sign in with your invited email to join your team.' : 'Sign in to your workspace.'}
        </p>

        <form id="auth-form" class="stack">
          <label>
            Email
            <input
              id="email"
              type="email"
              autocomplete="email"
              required
            >
          </label>

          <label>
            Password
            <input
              id="password"
              type="password"
              autocomplete="current-password"
              minlength="6"
              required
            >
          </label>

          <div id="auth-error" class="error-text"></div>

          <button
            class="button primary"
            type="submit"
          >
            Log in
          </button>

          <button
            id="signup"
            class="button secondary"
            type="button"
          >
            Create account
          </button>
        </form>
      </section>
    </div>
  `

  const form =
    document.querySelector<HTMLFormElement>(
      '#auth-form'
    )!

  const email =
    document.querySelector<HTMLInputElement>(
      '#email'
    )!

  const password =
    document.querySelector<HTMLInputElement>(
      '#password'
    )!

  const error =
    document.querySelector<HTMLDivElement>(
      '#auth-error'
    )!

  form.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault()

      try {
        error.textContent = ''

        await signIn(
          email.value,
          password.value
        )

      } catch (err) {
        error.textContent =
          err instanceof Error
            ? err.message
            : 'Login failed.'
      }
    }
  )

  document
    .querySelector('#signup')
    ?.addEventListener(
      'click',
      async () => {
        try {
          error.textContent = ''

          await signUp(
            email.value,
            password.value
          )

          error.textContent =
            'Account created. Check your email if confirmation is enabled.'
        } catch (err) {
          error.textContent =
            err instanceof Error
              ? err.message
              : 'Signup failed.'
        }
      }
    )
}

type AppState = {
  workspace: Workspace
  workspaces: Workspace[]
  userId: string
  team: Awaited<ReturnType<typeof getTeam>>
  websites: Website[]
  pages: PageRecord[]
  reviews: PageRecord[]
  issues: IssueRecord[]
  alerts: AlertRecord[]
  reports: ReportRecord[]
  subscription: SubscriptionView
  usage: {
    websites: number
    pages: number
    members: number
  }
}

async function loadState(): Promise<AppState> {
  const context = await loadWorkspaces()
  const [
    websites,
    pages,
    reviews,
    issues,
    alerts,
    reports,
    subscription,
    usage,
    team,
  ] = await Promise.all([
    getWebsites(),
    getPages(),
    getReviewQueue(),
    getIssues(),
    getAlerts(),
    getReports(),
    getSubscription(),
    getUsage(),
    getTeam(),
  ])

  usage.members = team.members.length + 1
  if (context.workspace.role !== 'owner') {
    subscription.plan = context.workspace.plan
    subscription.adminOverridePlan = context.workspace.has_override ? context.workspace.plan : null
    subscription.paddleCustomerId = null
    subscription.paddleSubscriptionId = null
  }

  return {
    ...context,
    team,
    websites,
    pages,
    reviews,
    issues,
    alerts,
    reports,
    subscription,
    usage,
  }
}

function usageCard(
  label: string,
  used: number,
  limit: number
) {
  const pct = percent(used, limit)

  return `
    <article class="usage-card">
      <div class="usage-row">
        <span>${esc(label)}</span>
        <strong>
          ${used.toLocaleString()}
          /
          ${limitLabel(limit)}
        </strong>
      </div>

      ${
        Number.isFinite(limit)
          ? `
            <div class="progress">
              <div
                class="progress-bar"
                style="width:${pct}%"
              ></div>
            </div>
          `
          : `
            <div class="unlimited-line">
              Unlimited
            </div>
          `
      }
    </article>
  `
}

async function dashboardScreen(
  email: string
) {
  let state: AppState

  try {
    state = await loadState()
  } catch (error) {
    app.innerHTML = `
      <div class="fatal-error">
        <h2>Could not load Pulsely</h2>
        <pre>${esc(
          error instanceof Error
            ? error.message
            : String(error)
        )}</pre>
      </div>
    `
    return
  }

  const currentPlan =
    PLANS[state.subscription.plan]

  const unreadAlerts =
    state.alerts.filter(
      (alert) => !alert.read_at
    ).length

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo-box">P</div>
          <span>Pulsely</span>
        </div>

        <label class="workspace-picker">
          <span>Workspace</span>
          <select id="workspace-switch" aria-label="Switch workspace">
            ${state.workspaces.map(item => `<option value="${esc(item.owner_user_id)}" ${item.owner_user_id === state.workspace.owner_user_id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
          </select>
          <small>${esc(healthLabel(state.workspace.role))} access</small>
        </label>

        <nav class="nav">
          ${[
            ['overview', 'Overview'],
            ['websites', 'Websites'],
            ['pages', 'Pages'],
            ['reviews', 'Review Queue'],
            ['issues', 'Issues'],
            ['alerts', `Alerts${unreadAlerts ? ` · ${unreadAlerts}` : ''}`],
            ['reports', 'Reports'],
            ['team', 'Team'],
            ['settings', 'Settings'],
          ]
            .map(
              ([id, label]) => `
                <button
                  class="nav-item ${
                    currentView === id
                      ? 'active'
                      : ''
                  }"
                  data-view="${id}"
                >
                  ${icon(id as IconName)}<span>${label}</span>
                </button>
              `
            )
            .join('')}
        </nav>

        <div class="sidebar-footer">
          <div class="plan-pill">
            ${esc(currentPlan.name)}
          </div>

          <button
            id="open-plans"
            class="text-button"
          >
            Plans
          </button>
        </div>
      </aside>

      <section class="workspace">
        <header class="topbar">
          <div>
            <button id="mobile-menu" class="icon-button mobile-menu" aria-label="Open navigation" aria-expanded="false">${icon('menu')}</button>
            <strong id="view-title">
              Pulsely
            </strong>
          </div>

          <div class="topbar-right">
            <label class="global-search">
              ${icon('search', 16)}
              <input
                id="global-search"
                aria-label="Search workspace"
                placeholder="Search pages, issues, alerts..."
              >
              <div id="search-results" class="search-results hidden" role="region" aria-label="Search results"></div>
            </label>

            <span class="email">
              ${esc(email)}
            </span>

            <button
              id="logout"
              class="text-button"
            >
              ${icon('logout', 17)}<span>Log out</span>
            </button>
          </div>
        </header>

        <main
          id="view-content"
          class="content"
        ></main>
      </section>

      <div
        id="billing-modal"
        class="modal hidden"
      >
        <section class="modal-card">
          <header class="modal-header">
            <div>
              <h2>Pulsely plans</h2>
              <p>
                Monitoring that scales with your sites.
              </p>
            </div>

            <button
              id="close-plans"
              class="icon-button"
            >
              ×
            </button>
          </header>

          <div
            id="plan-grid"
            class="plan-grid"
          ></div>
        </section>
      </div>
    </div>
  `

  const content =
    document.querySelector<HTMLDivElement>(
      '#view-content'
    )!

  const title =
    document.querySelector<HTMLElement>(
      '#view-title'
    )!

  async function rerender() {
    await dashboardScreen(email)
  }

  function renderOverview() {
    title.textContent = 'Overview'

    const openIssues =
      state.issues.filter(
        (issue) =>
          issue.status === 'open' ||
          issue.status === 'in_progress'
      ).length

    const critical =
      state.issues.filter(
        (issue) =>
          issue.severity === 'critical' &&
          issue.status !== 'resolved'
      ).length

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Overview</h1>
          <p>
            Health across everything you manage.
          </p>
        </div>

        <div class="plan-summary">
          <strong>${esc(currentPlan.name)}</strong>
          ${
            state.subscription.adminOverridePlan
              ? '<span>Admin override</span>'
              : `<span>${esc(state.subscription.status)}</span>`
          }
        </div>
      </div>

      <section class="stat-grid">
        <article class="stat-card">
          <span>Websites</span>
          <strong>${state.usage.websites}</strong>
        </article>

        <article class="stat-card">
          <span>Pages</span>
          <strong>${state.usage.pages.toLocaleString()}</strong>
        </article>

        <article class="stat-card">
          <span>Open issues</span>
          <strong>${openIssues}</strong>
        </article>

        <article class="stat-card">
          <span>Critical</span>
          <strong>${critical}</strong>
        </article>

        <article class="stat-card">
          <span>Reviews due</span>
          <strong>${state.reviews.length}</strong>
        </article>

        <article class="stat-card">
          <span>Unread alerts</span>
          <strong>${unreadAlerts}</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Plan usage</h2>
            <p>
              Limits are enforced server-side.
            </p>
          </div>
        </div>

        <div class="usage-grid">
          ${usageCard(
            'Websites',
            state.usage.websites,
            currentPlan.websites
          )}

          ${usageCard(
            'Pages',
            state.usage.pages,
            currentPlan.pages
          )}

          ${usageCard(
            'Members',
            state.usage.members,
            currentPlan.members
          )}
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Maintenance focus</h2>
            <p>
              What needs attention before the next customer notices.
            </p>
          </div>
        </div>

        <div class="focus-grid">
          ${state.issues
            .filter(
              (issue) =>
                issue.status !== 'resolved' &&
                issue.status !== 'ignored'
            )
            .slice(0, 4)
            .map(
              (issue) => `
                <button
                  class="focus-card open-focus-issue"
                  data-id="${issue.id}"
                >
                  <span class="status-badge severity-${esc(issue.severity)}">
                    ${esc(issue.severity)}
                  </span>
                  <strong>${esc(issue.title)}</strong>
                  <span>${esc(issue.description ?? 'Open maintenance item')}</span>
                </button>
              `
            )
            .join('') ||
            `
              <div class="notice">
                No active maintenance issues. The board is clean.
              </div>
            `}
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Monitoring cadence</h2>
            <p>
              Your current plan controls how often workers will check the web.
            </p>
          </div>
        </div>

        <div class="detail-grid">
          <div>
            <span>Uptime checks</span>
            <strong>
              Every ${uptimeLabel(
                currentPlan.uptimeSeconds
              )}
            </strong>
          </div>

          <div>
            <span>Site scans</span>
            <strong>
              Every ${scanLabel(
                currentPlan.scanMinutes
              )}
            </strong>
          </div>

          <div>
            <span>Human review</span>
            <strong>
              Every 12 months
            </strong>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>In-app alerts</h2>
            <p>
              Pulsely keeps alerting inside this workspace. Email alerts are intentionally disabled.
            </p>
          </div>
        </div>
        <div class="detail-grid">
          <div>
            <span>Delivery</span>
            <strong>In-app only</strong>
          </div>
          <div>
            <span>Unread alerts</span>
            <strong>${unreadAlerts}</strong>
          </div>
          <div>
            <span>Critical open issues</span>
            <strong>${state.issues.filter((issue) => issue.severity === 'critical' && issue.status !== 'resolved').length}</strong>
          </div>
        </div>
      </section>
    `

    document
      .querySelectorAll<HTMLElement>(
        '.open-focus-issue'
      )
      .forEach((card) => {
        card.addEventListener('click', () => {
          selectedIssueId =
            card.dataset.id ?? null
          currentView = 'issue-detail'
          renderView(currentView)
        })
      })
  }

  function renderWebsites() {
    title.textContent = 'Websites'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Websites</h1>
          <p>
            ${state.usage.websites}
            of
            ${limitLabel(currentPlan.websites)}
            websites used.
          </p>
        </div>
      </div>

      <section class="panel">
        <form
          id="add-site"
          class="add-site-form"
        >
          <input
            id="site-name"
            placeholder="Website name"
          >

          <input
            id="site-url"
            placeholder="https://example.com"
            required
          >

          <button
            class="button primary"
            type="submit"
          >
            Add website
          </button>
        </form>

        <div
          id="site-error"
          class="error-text"
        ></div>
      </section>

      ${
        state.websites.length
          ? `
            <div class="website-grid">
              ${state.websites
                .map(
                  (site) => `
                    <article
                      class="website-card clickable website-detail"
                      data-id="${site.id}"
                    >
                      <div class="website-main">
                        <div class="website-favicon-shell">
                          <img
                            class="website-favicon"
                            src="${esc(faviconUrl(site.url))}"
                            alt=""
                            loading="lazy"
                            onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';"
                          >
                          <span
                            class="website-favicon-fallback"
                            style="display:none"
                          >
                            ${esc(websiteInitial(site.name))}
                          </span>
                        </div>

                        <div class="website-copy">
                          <div class="website-title-row">
                            <span
                              class="health-dot health-${esc(site.health_status ?? 'healthy')}"
                            ></span>

                            <h3>
                              ${esc(site.name)}
                            </h3>
                          </div>

                          <a
                            href="${esc(site.url)}"
                            target="_blank"
                            rel="noreferrer"
                          >
                            ${esc(site.url)}
                          </a>
                        </div>
                      </div>

                      <div class="website-actions">
                        <button
                          class="text-button scan-site"
                          data-id="${site.id}"
                        >
                          Scan now
                        </button>

                        <button
                          class="text-button delete-site"
                          data-id="${site.id}"
                        >
                          Delete
                        </button>
                      </div>

                      <div class="site-monitor-data">
                        <span>
                          ${esc(
                            healthLabel(
                              site.health_status ?? 'healthy'
                            )
                          )}
                        </span>

                        <span>
                          ${
                            site.http_status
                              ? `HTTP ${site.http_status}`
                              : 'Not checked'
                          }
                        </span>

                        <span>
                          ${
                            site.last_response_ms != null
                              ? `${site.last_response_ms}ms`
                              : ''
                          }
                        </span>

                        <span>
                          ${
                            state.pages.filter(
                              (page) =>
                                page.website_id ===
                                site.id
                            ).length
                          } pages
                        </span>
                      </div>
                    </article>
                  `
                )
                .join('')}
            </div>
          `
          : emptyState(
              'No websites yet',
              'Add your first website above.'
            )
      }
    `

    const form =
      document.querySelector<HTMLFormElement>(
        '#add-site'
      )

    form?.addEventListener(
      'submit',
      async (event) => {
        event.preventDefault()

        const name =
          document.querySelector<HTMLInputElement>(
            '#site-name'
          )!

        const url =
          document.querySelector<HTMLInputElement>(
            '#site-url'
          )!

        const error =
          document.querySelector<HTMLDivElement>(
            '#site-error'
          )!

        try {
          error.textContent = ''

          await addWebsite(
            name.value,
            url.value
          )

          await rerender()
        } catch (err) {
          error.textContent =
            err instanceof Error
              ? err.message
              : 'Could not add website.'
        }
      }
    )

    document
      .querySelectorAll<HTMLButtonElement>(
        '.delete-site'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async (event) => {
            event.stopPropagation()
            const id = button.dataset.id

            if (!id) return

            await deleteWebsite(id)
            await rerender()
          }
        )
      })

    document
      .querySelectorAll<HTMLButtonElement>(
        '.scan-site'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async (event) => {
            event.stopPropagation()
            const id =
              button.dataset.id

            if (!id) return

            const original =
              button.textContent

            try {
              button.disabled = true
              button.textContent =
                'Scanning…'

              const result =
                await scanWebsite(id)

              toast(
                `Scan complete. ${result.scannedPages ?? 0} pages checked, ${result.discovered ?? 0} links discovered.`
              )

              await rerender()
            } catch (error) {
              toast(
                error instanceof Error
                  ? error.message
                  : 'Scan failed.'
              )

              button.disabled = false
              button.textContent =
                original
            }
          }
        )
      })

    document
      .querySelectorAll<HTMLElement>(
        '.website-detail'
      )
      .forEach((card) => {
        card.addEventListener(
          'click',
          () => {
            selectedWebsiteId =
              card.dataset.id ?? null
            currentView = 'website-detail'
            renderView(currentView)
          }
        )
      })
  }

  function renderPages() {
    title.textContent = 'Pages'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Pages</h1>
          <p>
            ${state.usage.pages.toLocaleString()}
            of
            ${limitLabel(currentPlan.pages)}
            indexed pages.
          </p>
        </div>
      </div>

      ${
        state.pages.length
          ? `
            <section class="panel table-panel">
              <table>
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Health</th>
                    <th>HTTP</th>
                    <th>Last scan</th>
                    <th>Review due</th>
                  </tr>
                </thead>

                <tbody>
                  ${state.pages
                    .map(
                      (page) => `
                        <tr
                          class="clickable page-detail-row"
                          data-id="${page.id}"
                        >
                          <td>
                            <strong>
                              ${esc(
                                page.title ||
                                  pathLabel(page.url)
                              )}
                            </strong>
                            <div class="table-subtext">
                              ${esc(page.url)}
                            </div>
                          </td>

                          <td>
                            <span class="status-badge health-badge-${esc(page.health_status)}">
                              ${esc(
                                healthLabel(
                                  page.health_status
                                )
                              )}
                            </span>
                          </td>

                          <td>
                            ${page.http_status ?? '—'}
                            ${
                              page.response_ms
                                ? `<div class="table-subtext">${page.response_ms}ms</div>`
                                : ''
                            }
                          </td>

                          <td>
                            ${formatDate(
                              page.last_scan_at
                            )}
                          </td>

                          <td>
                            ${formatDate(
                              page.next_human_review_at
                            )}
                          </td>
                        </tr>
                      `
                    )
                    .join('')}
                </tbody>
              </table>
            </section>
          `
          : emptyState(
              'No pages discovered yet',
              'The crawler will populate pages after the monitoring worker is connected.'
            )
      }
    `

    document
      .querySelectorAll<HTMLElement>(
        '.page-detail-row'
      )
      .forEach((row) => {
        row.addEventListener(
          'click',
          () => {
            selectedPageId =
              row.dataset.id ?? null
            currentView = 'page-detail'
            renderView(currentView)
          }
        )
      })
  }

  async function renderWebsiteDetail() {
    const site =
      selectedWebsiteId
        ? websiteFor(state, selectedWebsiteId)
        : null

    if (!site) {
      currentView = 'websites'
      renderWebsites()
      return
    }

    title.textContent = site.name

    const pages =
      state.pages.filter(
        (page) =>
          page.website_id === site.id
      )

    const issues =
      issuesForWebsite(state, site.id)

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <button class="text-button back-to-websites">
            ← Websites
          </button>
          <h1>${esc(site.name)}</h1>
          <p>${esc(site.url)}</p>
        </div>

        <div class="button-row compact">
          <a
            class="button secondary"
            href="${esc(site.url)}"
            target="_blank"
            rel="noreferrer"
          >
            Open site
          </a>
          <button
            class="button primary scan-site-detail"
            data-id="${site.id}"
          >
            Scan website
          </button>
        </div>
      </div>

      <section class="stat-grid">
        <article class="stat-card">
          <span>Health</span>
          <strong>${esc(healthLabel(site.health_status))}</strong>
        </article>
        <article class="stat-card">
          <span>Pages</span>
          <strong>${pages.length}</strong>
        </article>
        <article class="stat-card">
          <span>Open issues</span>
          <strong>${issues.length}</strong>
        </article>
        <article class="stat-card">
          <span>HTTP</span>
          <strong>${site.http_status ?? '—'}</strong>
        </article>
        <article class="stat-card">
          <span>Response</span>
          <strong>${site.last_response_ms != null ? `${site.last_response_ms}ms` : '—'}</strong>
        </article>
        <article class="stat-card">
          <span>Last scan</span>
          <strong>${formatDate(site.last_scan_at)}</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Infrastructure checks</h2>
            <p>Worker-derived status for crawling, indexing and certificates.</p>
          </div>
        </div>
        <div class="detail-grid">
          <div>
            <span>robots.txt</span>
            <strong>${(site as any).robots_status ?? 'Not checked'}</strong>
          </div>
          <div>
            <span>Sitemap</span>
            <strong>${(site as any).sitemap_status ?? 'Not checked'}</strong>
          </div>
          <div>
            <span>SSL expires</span>
            <strong>${formatDate((site as any).ssl_expires_at ?? null)}</strong>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Scan history</h2>
            <p>Recent worker runs and response-time trend.</p>
          </div>
        </div>
        <div id="scan-history">
          <div class="loader">Loading scan history...</div>
        </div>
      </section>

      <section class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>Score</th>
              <th>Health</th>
              <th>HTTP</th>
              <th>Last scan</th>
            </tr>
          </thead>
          <tbody>
            ${pages
              .map((page) => {
                const score =
                  healthScore(
                    page,
                    issuesForPage(state, page.id)
                  )

                return `
                  <tr class="clickable page-detail-row" data-id="${page.id}">
                    <td>
                      <strong>${esc(page.title || pathLabel(page.url))}</strong>
                      <div class="table-subtext">${esc(page.url)}</div>
                    </td>
                    <td>
                      <span class="score-pill score-${scoreBand(score)}">${score}</span>
                    </td>
                    <td>
                      <span class="status-badge health-badge-${esc(page.health_status)}">
                        ${esc(healthLabel(page.health_status))}
                      </span>
                    </td>
                    <td>${page.http_status ?? '—'}</td>
                    <td>${formatDate(page.last_scan_at)}</td>
                  </tr>
                `
              })
              .join('')}
          </tbody>
        </table>
      </section>
    `

    document
      .querySelector('.back-to-websites')
      ?.addEventListener('click', () => {
        currentView = 'websites'
        renderView(currentView)
      })

    document
      .querySelector('.scan-site-detail')
      ?.addEventListener('click', async (event) => {
        const button =
          event.currentTarget as HTMLButtonElement

        button.disabled = true
        button.textContent = 'Scanning...'

        try {
          const result =
            await scanWebsite(site.id)
          toast(
            `Scan complete. ${result.scannedPages ?? 0} pages checked.`
          )
          await rerender()
        } catch (error) {
          toast(
            error instanceof Error
              ? error.message
              : 'Scan failed.'
          )
          button.disabled = false
          button.textContent = 'Scan website'
        }
      })

    document
      .querySelectorAll<HTMLElement>(
        '.page-detail-row'
      )
      .forEach((row) => {
        row.addEventListener('click', () => {
          selectedPageId =
            row.dataset.id ?? null
          currentView = 'page-detail'
          renderView(currentView)
        })
      })

    try {
      const runs =
        await getMonitoringRuns(site.id)

      const history =
        document.querySelector('#scan-history')

      if (history) {
        history.innerHTML = runs.length
          ? `
            ${sparkline(
              runs
                .map((run) => run.response_ms ?? 0)
            )}
            <div class="mini-grid">
              ${runs
                .slice(0, 8)
                .map(
                  (run) => `
                    <div>
                      <span>${formatDate(run.checked_at)}</span>
                      <strong>${run.status_code ?? '—'} · ${run.response_ms ?? '—'}ms</strong>
                    </div>
                  `
                )
                .join('')}
            </div>
          `
          : emptyState(
              'No runs yet',
              'Run a scan to start building history.'
            )
      }
    } catch (error) {
      const history =
        document.querySelector('#scan-history')

      if (history) {
        history.innerHTML =
          '<div class="warning-notice">Scan history could not be loaded.</div>'
      }
    }
  }

  async function renderPageDetail() {
    const page =
      selectedPageId
        ? state.pages.find(
            (item) => item.id === selectedPageId
          )
        : null

    if (!page) {
      currentView = 'pages'
      renderPages()
      return
    }

    const site =
      websiteFor(state, page.website_id)

    const pageIssues =
      issuesForPage(state, page.id)

    const score =
      healthScore(page, pageIssues)

    title.textContent =
      page.title || pathLabel(page.url)

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <button class="text-button back-to-pages">
            ← Pages
          </button>
          <h1>${esc(page.title || pathLabel(page.url))}</h1>
          <p>${esc(page.url)}</p>
        </div>
        <div class="button-row compact">
          <a
            class="button secondary"
            href="${esc(page.url)}"
            target="_blank"
            rel="noreferrer"
          >
            Open page
          </a>
          <button class="button secondary copy-page-url">
            Copy URL
          </button>
        </div>
      </div>

      <section class="stat-grid">
        <article class="stat-card">
          <span>Health score</span>
          <strong>${score}</strong>
        </article>
        <article class="stat-card">
          <span>HTTP</span>
          <strong>${page.http_status ?? '—'}</strong>
        </article>
        <article class="stat-card">
          <span>Response</span>
          <strong>${page.response_ms != null ? `${page.response_ms}ms` : '—'}</strong>
        </article>
        <article class="stat-card">
          <span>Open issues</span>
          <strong>${pageIssues.length}</strong>
        </article>
        <article class="stat-card">
          <span>Review due</span>
          <strong>${formatDate(page.next_human_review_at)}</strong>
        </article>
        <article class="stat-card">
          <span>Source site</span>
          <strong>${esc(site?.name ?? 'Website')}</strong>
        </article>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Analytics and SEO</h2>
            <p>Signals gathered by the crawler during the latest scan.</p>
          </div>
          <span class="score-pill score-${scoreBand(score)}">${score}/100</span>
        </div>
        <div class="detail-grid">
          <div>
            <span>Title</span>
            <strong>${esc(page.title || 'Missing')}</strong>
          </div>
          <div>
            <span>Meta description</span>
            <strong>${esc(page.meta_description || 'Missing')}</strong>
          </div>
          <div>
            <span>H1 count</span>
            <strong>${page.h1_count ?? 'Unknown'}</strong>
          </div>
          <div>
            <span>Canonical URL</span>
            <strong>${esc(page.canonical_url || 'None')}</strong>
          </div>
          <div>
            <span>Redirects</span>
            <strong>${page.redirect_count ?? 0}</strong>
          </div>
          <div>
            <span>Content fingerprint</span>
            <strong>${esc(page.content_hash?.slice(0, 12) ?? 'Not captured')}</strong>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Human review</h2>
            <p>Record manual QA notes and reset the annual review clock.</p>
          </div>
        </div>
        <form id="review-form" class="review-form">
          <input
            id="review-notes"
            placeholder="Notes from this review"
          >
          <button class="button primary" type="submit">
            Mark reviewed
          </button>
        </form>
      </section>

      <section class="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Detected</th>
            </tr>
          </thead>
          <tbody>
            ${pageIssues.length
              ? pageIssues
                  .map(
                    (issue) => `
                      <tr class="clickable issue-detail-row" data-id="${issue.id}">
                        <td>
                          <strong>${esc(issue.title)}</strong>
                          <div class="table-subtext">${esc(issue.description ?? '')}</div>
                        </td>
                        <td><span class="status-badge severity-${esc(issue.severity)}">${esc(issue.severity)}</span></td>
                        <td>${esc(healthLabel(issue.status))}</td>
                        <td>${formatDate(issue.detected_at)}</td>
                      </tr>
                    `
                  )
                  .join('')
              : '<tr><td colspan="4">No open issues for this page.</td></tr>'}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Links found</h2>
            <p>Internal and external links checked by the incremental worker.</p>
          </div>
        </div>
        <div id="page-links">
          <div class="loader">Loading links...</div>
        </div>
      </section>
    `

    document
      .querySelector('.back-to-pages')
      ?.addEventListener('click', () => {
        currentView = selectedWebsiteId
          ? 'website-detail'
          : 'pages'
        renderView(currentView)
      })

    document
      .querySelector('.copy-page-url')
      ?.addEventListener('click', async () => {
        await navigator.clipboard.writeText(page.url)
        toast('Page URL copied.')
      })

    document
      .querySelector('#review-form')
      ?.addEventListener('submit', async (event) => {
        event.preventDefault()

        const notes =
          document.querySelector<HTMLInputElement>(
            '#review-notes'
          )!

        await completeReview(page.id, notes.value)
        toast('Review completed.')
        await rerender()
      })

    document
      .querySelectorAll<HTMLElement>(
        '.issue-detail-row'
      )
      .forEach((row) => {
        row.addEventListener('click', () => {
          selectedIssueId =
            row.dataset.id ?? null
          currentView = 'issue-detail'
          renderView(currentView)
        })
      })

    try {
      const links =
        await getPageLinks(page.id)

      const linksNode =
        document.querySelector('#page-links')

      if (linksNode) {
        linksNode.innerHTML = renderLinksTable(links)
      }
    } catch {
      const linksNode =
        document.querySelector('#page-links')

      if (linksNode) {
        linksNode.innerHTML =
          '<div class="warning-notice">Links could not be loaded.</div>'
      }
    }
  }

  function renderLinksTable(
    links: PageLinkRecord[]
  ) {
    if (!links.length) {
      return emptyState(
        'No links captured',
        'The next scan will populate link data for this page.'
      )
    }

    return `
      <div class="table-panel">
        <table>
          <thead>
            <tr>
              <th>Target</th>
              <th>Type</th>
              <th>Status</th>
              <th>Last checked</th>
            </tr>
          </thead>
          <tbody>
            ${links
              .map(
                (link) => `
                  <tr>
                    <td>
                      <a href="${esc(link.target_url)}" target="_blank" rel="noreferrer">
                        ${esc(link.target_url)}
                      </a>
                    </td>
                    <td>${link.is_internal ? 'Internal' : 'External'}</td>
                    <td>
                      <span class="status-badge ${link.is_broken ? 'severity-high' : 'health-badge-healthy'}">
                        ${link.last_status ?? (link.is_broken ? 'Broken' : 'Queued')}
                      </span>
                    </td>
                    <td>${formatDate(link.last_checked_at)}</td>
                  </tr>
                `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
  }

  function renderReviews() {
    title.textContent = 'Review Queue'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Human review queue</h1>
          <p>
            Every live page is due for a human health check at least once every 12 months.
          </p>
        </div>
      </div>

      ${
        state.reviews.length
          ? `
            <section class="panel table-panel">
              <table>
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Due</th>
                    <th>Last reviewed</th>
                  </tr>
                </thead>

                <tbody>
                  ${state.reviews
                    .map(
                      (page) => `
                        <tr
                          class="clickable review-page-row"
                          data-id="${page.id}"
                        >
                          <td>
                            ${esc(
                              page.title ||
                                page.url
                            )}
                          </td>

                          <td>
                            ${formatDate(
                              page.next_human_review_at
                            )}
                          </td>

                          <td>
                            ${formatDate(
                              page.last_human_review_at
                            )}
                          </td>
                        </tr>
                      `
                    )
                    .join('')}
                </tbody>
              </table>
            </section>
          `
          : emptyState(
              'Nothing due',
              'No pages currently need a human review.'
            )
      }
    `

    document
      .querySelectorAll<HTMLElement>(
        '.review-page-row'
      )
      .forEach((row) => {
        row.addEventListener(
          'click',
          () => {
            selectedPageId =
              row.dataset.id ?? null
            currentView = 'page-detail'
            renderView(currentView)
          }
        )
      })
  }

  function renderIssueDetail() {
    const issue =
      selectedIssueId
        ? state.issues.find(
            (item) => item.id === selectedIssueId
          )
        : null

    if (!issue) {
      currentView = 'issues'
      renderIssues()
      return
    }

    const page =
      issue.page_id
        ? state.pages.find(
            (item) => item.id === issue.page_id
          )
        : null

    const site =
      websiteFor(state, issue.website_id)

    title.textContent = issue.title

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <button class="text-button back-to-issues">
            ← Issues
          </button>
          <h1>${esc(issue.title)}</h1>
          <p>${esc(issue.description ?? 'No description captured.')}</p>
        </div>
        <span class="status-badge severity-${esc(issue.severity)}">
          ${esc(issue.severity)}
        </span>
      </div>

      <section class="panel">
        <div class="detail-grid">
          <div>
            <span>Status</span>
            <strong>${esc(healthLabel(issue.status))}</strong>
          </div>
          <div>
            <span>Type</span>
            <strong>${esc(issue.type ?? 'general')}</strong>
          </div>
          <div>
            <span>Detected</span>
            <strong>${formatDate(issue.detected_at)}</strong>
          </div>
          <div>
            <span>Website</span>
            <strong>${esc(site?.name ?? 'Website')}</strong>
          </div>
          <div>
            <span>Page</span>
            <strong>${esc(page ? pathLabel(page.url) : 'Site-level')}</strong>
          </div>
          <div>
            <span>Resolved</span>
            <strong>${formatDate(issue.resolved_at ?? null)}</strong>
          </div>
        </div>

        <div class="button-row">
          ${['open', 'in_progress', 'resolved', 'ignored']
            .map(
              (status) => `
                <button
                  class="button secondary issue-status"
                  data-status="${status}"
                  ${issue.status === status ? 'disabled' : ''}
                >
                  ${esc(healthLabel(status))}
                </button>
              `
            )
            .join('')}
        </div>
      </section>

      ${
        page
          ? `
            <section class="panel">
              <div class="panel-heading">
                <div>
                  <h2>Affected page</h2>
                  <p>${esc(page.url)}</p>
                </div>
                <button class="button secondary open-affected-page">
                  View page analytics
                </button>
              </div>
            </section>
          `
          : ''
      }
    `

    document
      .querySelector('.back-to-issues')
      ?.addEventListener('click', () => {
        currentView = 'issues'
        renderView(currentView)
      })

    document
      .querySelector('.open-affected-page')
      ?.addEventListener('click', () => {
        if (!page) return
        selectedPageId = page.id
        currentView = 'page-detail'
        renderView(currentView)
      })

    document
      .querySelectorAll<HTMLButtonElement>(
        '.issue-status'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async () => {
            const status =
              button.dataset.status

            if (!status) return

            await updateIssueStatus(
              issue.id,
              status
            )
            toast('Issue updated.')
            await rerender()
          }
        )
      })
  }

  function renderIssues() {
    title.textContent = 'Issues'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Issues</h1>
          <p>
            Problems found by monitoring and human review.
          </p>
        </div>
      </div>

      ${
        state.issues.length
          ? `
            <section class="panel table-panel">
              <table>
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Detected</th>
                  </tr>
                </thead>

                <tbody>
                  ${state.issues
                    .map(
                      (issue) => `
                        <tr
                          class="clickable issue-detail-row"
                          data-id="${issue.id}"
                        >
                          <td>
                            <strong>
                              ${esc(issue.title)}
                            </strong>

                            ${
                              issue.description
                                ? `
                                  <div class="table-subtext">
                                    ${esc(
                                      issue.description
                                    )}
                                  </div>
                                `
                                : ''
                            }
                          </td>

                          <td>
                            <span class="status-badge severity-${esc(issue.severity)}">
                              ${esc(
                                issue.severity
                              )}
                            </span>
                          </td>

                          <td>
                            ${esc(
                              healthLabel(
                                issue.status
                              )
                            )}
                          </td>

                          <td>
                            ${formatDate(
                              issue.detected_at
                            )}
                          </td>
                        </tr>
                      `
                    )
                    .join('')}
                </tbody>
              </table>
            </section>
          `
          : emptyState(
              'No issues',
              'Nothing has been flagged yet.'
            )
      }
    `

    document
      .querySelectorAll<HTMLElement>(
        '.issue-detail-row'
      )
      .forEach((row) => {
        row.addEventListener(
          'click',
          () => {
            selectedIssueId =
              row.dataset.id ?? null
            currentView = 'issue-detail'
            renderView(currentView)
          }
        )
      })
  }

  function renderAlerts() {
    title.textContent = 'Alerts'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Alerts</h1>
          <p>
            Important monitoring events and changes.
          </p>
        </div>
      </div>

      ${
        state.alerts.length
          ? `
            <div class="alert-list">
              ${state.alerts
                .map(
                  (alert) => `
                    <article
                      class="alert-card clickable alert-detail-row ${
                      alert.read_at
                        ? ''
                        : 'unread'
                    }"
                      data-id="${alert.id}"
                    >
                      <div>
                        <h3>
                          ${esc(alert.title)}
                        </h3>

                        ${
                          alert.message
                            ? `
                              <p>
                                ${esc(
                                  alert.message
                                )}
                              </p>
                            `
                            : ''
                        }

                        <span>
                          ${formatDate(
                            alert.created_at
                          )}
                        </span>
                      </div>

                      ${
                        !alert.read_at
                          ? `
                            <button
                              class="text-button read-alert"
                              data-id="${alert.id}"
                            >
                              Mark read
                            </button>
                          `
                          : ''
                      }
                    </article>
                  `
                )
                .join('')}
            </div>
          `
          : emptyState(
              'No alerts',
              'Pulsely has nothing urgent to tell you. Suspiciously peaceful.'
            )
      }
    `

    document
      .querySelectorAll<HTMLButtonElement>(
        '.read-alert'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async (event) => {
            event.stopPropagation()
            const id = button.dataset.id

            if (!id) return

            await markAlertRead(id)
            await rerender()
          }
        )
      })

    document
      .querySelectorAll<HTMLElement>(
        '.alert-detail-row'
      )
      .forEach((card) => {
        card.addEventListener('click', () => {
          selectedAlertId =
            card.dataset.id ?? null
          currentView = 'alert-detail'
          renderView(currentView)
        })
      })
  }

  function renderAlertDetail() {
    const alert =
      selectedAlertId
        ? state.alerts.find(
            (item) => item.id === selectedAlertId
          )
        : null

    if (!alert) {
      currentView = 'alerts'
      renderAlerts()
      return
    }

    title.textContent = alert.title

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <button class="text-button back-to-alerts">
            ← Alerts
          </button>
          <h1>${esc(alert.title)}</h1>
          <p>${esc(alert.message ?? 'No message captured.')}</p>
        </div>
        <span class="status-badge ${alert.read_at ? '' : 'severity-high'}">
          ${alert.read_at ? 'Read' : 'Unread'}
        </span>
      </div>

      <section class="panel">
        <div class="detail-grid">
          <div>
            <span>Severity</span>
            <strong>${esc(alert.severity ?? 'info')}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>${formatDate(alert.created_at)}</strong>
          </div>
          <div>
            <span>Read</span>
            <strong>${formatDate(alert.read_at)}</strong>
          </div>
        </div>

        ${
          !alert.read_at
            ? `
              <div class="button-row">
                <button class="button primary mark-alert-read">
                  Mark read
                </button>
              </div>
            `
            : ''
        }
      </section>
    `

    document
      .querySelector('.back-to-alerts')
      ?.addEventListener('click', () => {
        currentView = 'alerts'
        renderView(currentView)
      })

    document
      .querySelector('.mark-alert-read')
      ?.addEventListener('click', async () => {
        await markAlertRead(alert.id)
        toast('Alert marked read.')
        await rerender()
      })
  }

  function renderReports() {
    title.textContent = 'Reports'

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Reports</h1>
          <p>
            Historical website health and maintenance summaries.
          </p>
        </div>
        <button
          id="generate-report"
          class="button primary"
        >
          Generate report
        </button>
      </div>

      ${
        state.reports.length
          ? `
            <div class="report-grid">
              ${state.reports
                .map(
                  (report) => `
                    <article
                      class="panel clickable report-detail-row"
                      data-id="${report.id}"
                    >
                      <h3>
                        ${esc(report.name)}
                      </h3>

                      <p class="muted">
                        Generated
                        ${formatDate(
                          report.created_at
                        )}
                      </p>
                      <div class="mini-grid">
                        <div>
                          <span>Open issues</span>
                          <strong>${esc((report.summary as any)?.open_issues ?? '—')}</strong>
                        </div>
                        <div>
                          <span>Pages scanned</span>
                          <strong>${esc((report.summary as any)?.pages_scanned ?? (report.summary as any)?.pages ?? '—')}</strong>
                        </div>
                      </div>
                    </article>
                  `
                )
                .join('')}
            </div>
          `
          : emptyState(
              'No reports yet',
              'Reports will build from monitoring history once scans are running.'
            )
      }
    `

    document
      .querySelector('#generate-report')
      ?.addEventListener('click', async (event) => {
        const button =
          event.currentTarget as HTMLButtonElement

        button.disabled = true
        button.textContent = 'Generating...'

        try {
          await generateReport(30)
          toast('Report generated.')
          await rerender()
        } catch (error) {
          toast(
            error instanceof Error
              ? error.message
              : 'Report failed.'
          )
          button.disabled = false
          button.textContent = 'Generate report'
        }
      })

    document
      .querySelectorAll<HTMLElement>(
        '.report-detail-row'
      )
      .forEach((card) => {
        card.addEventListener('click', () => {
          selectedReportId =
            card.dataset.id ?? null
          currentView = 'report-detail'
          renderView(currentView)
        })
      })
  }

  function renderReportDetail() {
    const report =
      selectedReportId
        ? state.reports.find(
            (item) => item.id === selectedReportId
          )
        : null

    if (!report) {
      currentView = 'reports'
      renderReports()
      return
    }

    title.textContent = report.name

    const entries =
      Object.entries(report.summary ?? {})

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <button class="text-button back-to-reports">
            ← Reports
          </button>
          <h1>${esc(report.name)}</h1>
          <p>Generated ${formatDate(report.created_at)}</p>
        </div>
      </div>

      <section class="panel">
        <div class="detail-grid">
          ${entries.length
            ? entries
                .map(
                  ([key, value]) => `
                    <div>
                      <span>${esc(healthLabel(key))}</span>
                      <strong>${esc(typeof value === 'object' ? JSON.stringify(value) : value)}</strong>
                    </div>
                  `
                )
                .join('')
            : `
              <div>
                <span>Summary</span>
                <strong>No summary values captured.</strong>
              </div>
            `}
        </div>
      </section>
    `

    document
      .querySelector('.back-to-reports')
      ?.addEventListener('click', () => {
        currentView = 'reports'
        renderView(currentView)
      })
  }

  function renderTeam() {
    title.textContent = 'Team'
    const { members, invites, incoming, activity } = state.team
    const manager = canManage(state.workspace.role)
    const pending = invites.filter(item => item.status === 'pending' && new Date(item.expires_at).getTime() > Date.now())
    const occupied = members.length + 1 + pending.length
    const seatsAvailable = occupied < currentPlan.members
    const options = (role: string) => ['viewer', 'editor', ...(state.workspace.role === 'owner' ? ['admin'] : [])].map(value => `<option value="${value}" ${value === role ? 'selected' : ''}>${healthLabel(value)}</option>`).join('')
    content.innerHTML = `
      <div class="page-heading"><div><h1>Team</h1><p>${esc(state.workspace.name)}</p></div>
        ${manager ? `<button id="invite-member" class="button primary" ${seatsAvailable ? '' : 'disabled'}>${icon('plus', 16)}Invite member</button>` : ''}
      </div>
      ${incoming.length ? `<section class="incoming-invites"><h2>Your invitations</h2>${incoming.map(item => `<div class="invite-banner"><div>${icon('mail')}<div><strong>${esc(item.workspace_name)}</strong><p>${healthLabel(item.role)} access · Expires ${formatDate(item.expires_at)}</p></div></div><button class="button primary accept-invite" data-token="${esc(item.token)}">Join workspace</button></div>`).join('')}</section>` : ''}
      <div class="team-summary"><div><span class="metric-value">${members.length + 1}</span><span>Active members</span></div><div><span class="metric-value">${pending.length}</span><span>Pending invitations</span></div><div><span class="metric-value">${limitLabel(currentPlan.members)}</span><span>Plan seats</span></div><div><span class="status-badge">${healthLabel(state.workspace.role)}</span><span>Your role</span></div></div>
      ${manager && !seatsAvailable ? `<div class="warning-notice">All seats are occupied or reserved by pending invitations. <button id="team-plans" class="text-button">View plans</button></div>` : ''}
      <div class="section-heading"><h2>Members <span class="count-badge">${members.length + 1}</span></h2><button id="team-permissions" class="text-button">${icon('shield', 16)}Permissions</button></div>
      <div class="table-panel"><table><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th class="actions-cell">Actions</th></tr></thead><tbody>
        <tr><td><div class="person-cell"><span class="avatar">${esc(state.workspace.owner_email.charAt(0).toUpperCase())}</span><div><strong>${esc(state.workspace.owner_email)}</strong><small>Workspace owner${state.workspace.role === 'owner' ? ' · You' : ''}</small></div></div></td><td><span class="role-badge owner">${icon('shield', 14)}Owner</span></td><td class="muted">—</td><td></td></tr>
        ${members.map(member => { const editable = manager && (state.workspace.role === 'owner' || member.role !== 'admin'); const self = member.member_user_id === state.userId; return `<tr>
          <td><div class="person-cell"><span class="avatar ${member.role}">${esc(member.member_email.charAt(0).toUpperCase())}</span><div><strong>${esc(member.member_email)}</strong><small>${self ? 'You' : 'Active member'}</small></div></div></td>
          <td>${editable ? `<select class="member-role" aria-label="Role for ${esc(member.member_email)}" data-id="${member.id}">${options(member.role)}</select>` : `<span class="role-badge">${healthLabel(member.role)}</span>`}</td><td>${formatDate(member.created_at)}</td>
          <td class="actions-cell">${editable || self ? `<button class="icon-button remove-member" data-id="${member.id}" aria-label="${self ? 'Leave workspace' : 'Remove ' + esc(member.member_email)}" title="${self ? 'Leave workspace' : 'Remove member'}">${icon(self ? 'logout' : 'trash', 16)}</button>` : ''}</td></tr>` }).join('')}
      </tbody></table></div>
      ${manager ? `<div class="section-heading"><h2>Invitations <span class="count-badge">${invites.length}</span></h2></div>${invites.length ? `<div class="table-panel"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th class="actions-cell">Actions</th></tr></thead><tbody>${invites.map(item => {
        const expired = item.status === 'pending' && new Date(item.expires_at).getTime() <= Date.now(); const editable = state.workspace.role === 'owner' || item.role !== 'admin'
        return `<tr><td>${esc(item.email)}</td><td>${healthLabel(item.role)}</td><td><span class="status-badge ${item.status === 'accepted' ? 'health-badge-healthy' : ''}">${expired ? 'Expired' : healthLabel(item.status)}</span></td><td>${formatDate(item.expires_at)}</td><td class="actions-cell"><div class="row-actions">${item.status === 'pending' && editable ? `${!expired ? `<button class="icon-button copy-invite" data-id="${item.id}" title="Copy invitation link" aria-label="Copy invitation link">${icon('copy', 16)}</button>` : ''}<button class="icon-button renew-invite" data-id="${item.id}" title="Create fresh invitation link" aria-label="Create fresh invitation link">${icon('refresh', 16)}</button><button class="icon-button revoke-invite" data-id="${item.id}" title="Revoke invitation" aria-label="Revoke invitation">${icon('close', 16)}</button>` : ''}</div></td></tr>`
      }).join('')}</tbody></table></div>` : emptyState('No pending invitations', 'Your next teammate starts here.')}` : ''}
      <div class="section-heading"><h2>Recent activity</h2></div>
      ${activity.length ? `<ol class="activity-list">${activity.map(item => `<li><span class="activity-mark">${icon('activity', 15)}</span><div><strong>${esc(item.action)}</strong><p>${esc(item.subject)}</p></div><time datetime="${esc(item.created_at)}">${formatDate(item.created_at)}</time></li>`).join('')}</ol>` : emptyState('A fresh workspace', 'Team activity will appear here.')}
    `
    document.querySelector('#team-plans')?.addEventListener('click', showPlans)
    document.querySelector('#team-permissions')?.addEventListener('click', () => openDialog('Workspace permissions', `<div class="table-panel"><table><thead><tr><th>Access</th><th>Owner</th><th>Admin</th><th>Editor</th><th>Viewer</th></tr></thead><tbody>${[
      ['View sites, history and reports', true, true, true, true], ['Run scans, manage issues and reviews', true, true, true, false], ['Add and remove websites', true, true, false, false], ['Invite editors and viewers', true, true, false, false], ['Manage admins and billing', true, false, false, false]
    ].map(([label, ...values]) => `<tr><td>${label}</td>${values.map(value => `<td>${value ? icon('check', 16) : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`, { wide: true }))
    const showInvite = (link: string) => {
      const dialog = openDialog('Invitation ready', `<div class="dialog-success">${icon('check', 24)}<span>Invitation link created</span></div><label>Invitation link<input id="invitation-link" readonly value="${esc(link)}"></label><p class="field-hint">Valid for 7 days. Only the invited email address can accept.</p><div class="dialog-actions"><button id="copy-created-invite" class="button primary">${icon('copy', 16)}Copy link</button></div>`)
      dialog.querySelector('#copy-created-invite')!.addEventListener('click', () => copyText(link))
    }
    document.querySelector('#invite-member')?.addEventListener('click', () => {
      const dialog = openDialog('Invite a teammate', `<form id="invite-form" class="stack"><label>Email address<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="teammate@company.com" autofocus></label><label>Role<select name="role">${options('viewer')}</select></label><p class="field-hint">Viewers can read. Editors can scan and review. Admins can manage sites and teammates.</p><p class="form-error" role="alert"></p><div class="dialog-actions"><button class="button primary" type="submit">${icon('link', 16)}Create invitation link</button></div></form>`)
      dialog.querySelector('form')!.addEventListener('submit', async event => {
        event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector('button')!; button.disabled = true
        try { const data = new FormData(form); const invite = await inviteMember(String(data.get('email')), String(data.get('role'))); dialog.close(); await rerender(); showInvite(inviteLink(invite.token)) }
        catch (error) { form.querySelector('.form-error')!.textContent = errorMessage(error); button.disabled = false }
      })
    })
    content.querySelectorAll<HTMLButtonElement>('.copy-invite').forEach(button => button.onclick = () => { const item = invites.find(invite => invite.id === button.dataset.id); if (item) void copyText(inviteLink(item.token)) })
    content.querySelectorAll<HTMLButtonElement>('.accept-invite').forEach(button => button.onclick = async () => {
      button.disabled = true
      try { await acceptInvite(button.dataset.token!); history.replaceState(null, '', '#team'); toast('You have joined the workspace'); await rerender() }
      catch (error) { toast(errorMessage(error), 'error'); button.disabled = false }
    })
    content.querySelectorAll<HTMLButtonElement>('.revoke-invite, .renew-invite').forEach(button => button.onclick = async () => {
      const item = invites.find(invite => invite.id === button.dataset.id); if (!item) return
      const renew = button.classList.contains('renew-invite')
      if (!await confirmAction(renew ? 'Replace invitation link?' : 'Revoke invitation?', `The current link for ${item.email} will stop working.`, renew ? 'Create new link' : 'Revoke invitation')) return
      button.disabled = true
      try { if (renew) { const invite = await inviteMember(item.email, item.role); await rerender(); showInvite(inviteLink(invite.token)) } else { await revokeInvite(item.id); toast('Invitation revoked'); await rerender() } }
      catch (error) { toast(errorMessage(error), 'error'); button.disabled = false }
    })
    content.querySelectorAll<HTMLSelectElement>('.member-role').forEach(select => select.onchange = async () => {
      const member = members.find(item => item.id === select.dataset.id)!; select.disabled = true
      try { await changeMember(member.id, select.value); toast('Role updated'); await rerender() }
      catch (error) { toast(errorMessage(error), 'error'); select.value = member.role; select.disabled = false }
    })
    content.querySelectorAll<HTMLButtonElement>('.remove-member').forEach(button => button.onclick = async () => {
      const member = members.find(item => item.id === button.dataset.id)!; const self = member.member_user_id === state.userId
      if (!await confirmAction(self ? 'Leave this workspace?' : 'Remove team member?', `${member.member_email} will lose access to this workspace.`, self ? 'Leave workspace' : 'Remove member')) return
      button.disabled = true
      try { await changeMember(member.id, null); toast(self ? 'You left the workspace' : 'Member removed'); await rerender() }
      catch (error) { toast(errorMessage(error), 'error'); button.disabled = false }
    })
  }

  function renderSettings() {
    title.textContent = 'Settings'

    const scheduledCancel =
      state.subscription.cancelAtPeriodEnd

    content.innerHTML = `
      <div class="page-heading">
        <div>
          <h1>Settings</h1>
          <p>
            Account, subscription and monitoring configuration.
          </p>
        </div>
      </div>

      <section class="panel settings-section">
        <div class="panel-heading"><div><h2>Workspace</h2><p>${esc(state.workspace.owner_email)}</p></div><span class="role-badge">${healthLabel(state.workspace.role)}</span></div>
        <form id="workspace-settings" class="settings-form"><label>Workspace name<input name="name" required maxlength="80" value="${esc(state.workspace.name)}" ${canManage(state.workspace.role) ? '' : 'disabled'}></label>${canManage(state.workspace.role) ? `<button class="button primary" type="submit">Save changes</button>` : ''}</form>
      </section>
      <section class="panel settings-section"><div class="panel-heading"><div><h2>Monitoring schedule</h2><p>${esc(currentPlan.name)} plan</p></div>${icon('clock')}</div><div class="detail-grid"><div><span>Uptime checks</span><strong>Every ${uptimeLabel(currentPlan.uptimeSeconds)}</strong></div><div><span>Content scans</span><strong>${scanLabel(currentPlan.scanMinutes)}</strong></div><div><span>Human reviews</span><strong>Every ${currentPlan.humanReviewMonths} months</strong></div></div></section>
      <section class="panel settings-section"><div class="panel-heading"><div><h2>Notifications</h2><p>In-app alerts</p></div>${icon('alerts')}</div><div class="setting-row"><div><strong>Maintenance alerts</strong><p>Outages, issues and review reminders</p></div><span class="status-badge health-badge-healthy">Active</span></div></section>
      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>Subscription</h2>
            <p>
              Billing and plan access.
            </p>
          </div>

          <span class="plan-pill large">
            ${esc(currentPlan.name)}
          </span>
        </div>

        ${
          state.subscription.adminOverridePlan
            ? `
              <div class="notice">
                This account has an administrator override:
                <strong>
                  ${esc(
                    PLANS[
                      state.subscription
                        .adminOverridePlan
                    ].name
                  )}
                </strong>.
                Paddle billing cannot remove this override.
              </div>
            `
            : ''
        }

        ${
          scheduledCancel
            ? `
              <div class="warning-notice">
                Your Paddle subscription is scheduled to cancel
                ${
                  state.subscription
                    .scheduledChangeAt
                    ? `on ${formatDate(
                        state.subscription
                          .scheduledChangeAt
                      )}`
                    : 'at the end of the billing period'
                }.
                Paid access remains active until then.
              </div>
            `
            : ''
        }

        <div class="detail-grid">
          <div>
            <span>Plan</span>
            <strong>
              ${esc(currentPlan.name)}
            </strong>
          </div>

          <div>
            <span>Billing status</span>
            <strong>
              ${esc(
                state.subscription
                  .adminOverridePlan
                  ? 'Admin granted'
                  : state.subscription.status
              )}
            </strong>
          </div>

          <div>
            <span>Current period ends</span>
            <strong>
              ${formatDate(
                state.subscription
                  .currentPeriodEnd
              )}
            </strong>
          </div>
        </div>

        <div class="button-row">
          <button
            id="settings-plans"
            class="button secondary"
          >
            View plans
          </button>

          ${
            state.subscription
              .paddleCustomerId
              ? `
                <button
                  id="manage-billing"
                  class="button secondary"
                >
                  Manage billing
                </button>
              `
              : ''
          }

          ${
            state.subscription
                .paddleSubscriptionId &&
              state.subscription.status !==
                'canceled' &&
              !scheduledCancel
              ? `
                <button
                  id="cancel-subscription"
                  class="button danger"
                >
                  Cancel subscription
                </button>
              `
              : ''
          }
        </div>
      </section>
    `

    document.querySelector('#workspace-settings')?.addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const button = form.querySelector('button')!; button.disabled = true
      try { await renameWorkspace(String(new FormData(form).get('name'))); toast('Workspace updated'); await rerender() }
      catch (error) { toast(errorMessage(error), 'error'); button.disabled = false }
    })
    if (state.workspace.role !== 'owner') {
      content.querySelectorAll<HTMLButtonElement>('#settings-plans, #manage-billing, #cancel-subscription').forEach(button => button.remove())
    }

    document
      .querySelector('#settings-plans')
      ?.addEventListener(
        'click',
        showPlans
      )

    document
      .querySelector('#manage-billing')
      ?.addEventListener(
        'click',
        async () => {
          await openBillingPortal(
            'overview'
          )
        }
      )

    document
      .querySelector(
        '#cancel-subscription'
      )
      ?.addEventListener(
        'click',
        async () => {
          await openBillingPortal(
            'cancel'
          )
        }
      )
  }

  function renderView(view: string) {
    document
      .querySelectorAll('.nav-item')
      .forEach((button) => {
        button.classList.toggle(
          'active',
          (button as HTMLElement)
            .dataset.view === view
        )
      })

    switch (view) {
      case 'websites':
        renderWebsites()
        break

      case 'pages':
        renderPages()
        break

      case 'website-detail':
        void renderWebsiteDetail()
        break

      case 'page-detail':
        void renderPageDetail()
        break

      case 'reviews':
        renderReviews()
        break

      case 'issues':
        renderIssues()
        break

      case 'issue-detail':
        renderIssueDetail()
        break

      case 'alerts':
        renderAlerts()
        break

      case 'alert-detail':
        renderAlertDetail()
        break

      case 'reports':
        renderReports()
        break

      case 'report-detail':
        renderReportDetail()
        break

      case 'team':
        renderTeam()
        break

      case 'settings':
        renderSettings()
        break

      default:
        renderOverview()
    }
  }

  async function showPlans() {
    const modal =
      document.querySelector<HTMLDivElement>(
        '#billing-modal'
      )!

    const grid =
      document.querySelector<HTMLDivElement>(
        '#plan-grid'
      )!

    grid.innerHTML = PLAN_ORDER
      .map((id) => {
        const plan = PLANS[id]

        const isCurrent =
          id === state.subscription.plan

        const hasPaddleSubscription =
          Boolean(
            state.subscription
              .paddleSubscriptionId &&
              state.subscription.status !==
                'canceled'
          )

        let action = ''

        if (isCurrent) {
          action = `
            <div class="current-plan-button">
              Current plan
            </div>
          `
        } else if (
          state.subscription.adminOverridePlan
        ) {
          action = `
            <button
              class="button secondary"
              disabled
            >
              Admin override active
            </button>
          `
        } else if (
          hasPaddleSubscription
        ) {
          action = `
            <button
              class="button secondary manage-from-plan"
            >
              Manage subscription
            </button>
          `
        } else if (id === 'free') {
          action = `
            <div class="current-plan-button">
              Free
            </div>
          `
        } else {
          action = `
            <button
              class="button primary choose-plan"
              data-plan="${id}"
            >
              Choose ${esc(plan.name)}
            </button>
          `
        }

        return `
          <article class="plan-card ${
            isCurrent ? 'selected' : ''
          }">
            <h3>${esc(plan.name)}</h3>

            <div class="price">
              <strong>
                $${plan.price}
              </strong>

              <span>
                ${
                  plan.price
                    ? '/ month'
                    : 'forever'
                }
              </span>
            </div>

            <div class="plan-features">
              <span>
                ${limitLabel(plan.websites)}
                websites
              </span>

              <span>
                ${limitLabel(plan.pages)}
                pages
              </span>

              <span>
                ${limitLabel(plan.members)}
                members
              </span>

              <span>
                ${uptimeLabel(
                  plan.uptimeSeconds
                )}
                uptime checks
              </span>

              <span>
                ${scanLabel(
                  plan.scanMinutes
                )}
                scans
              </span>

              <span>
                Annual human page review
              </span>
            </div>

            ${action}
          </article>
        `
      })
      .join('')

    modal.classList.remove('hidden')

    document
      .querySelectorAll<HTMLButtonElement>(
        '.choose-plan'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async () => {
            const plan =
              button.dataset.plan as
                | PlanId
                | undefined

            if (!plan) return

            try {
              button.disabled = true
              button.textContent =
                'Opening checkout…'

              await openCheckout(plan)
            } catch (error) {
              window.alert(
                error instanceof Error
                  ? error.message
                  : 'Checkout failed.'
              )

              button.disabled = false
              button.textContent =
                `Choose ${PLANS[plan].name}`
            }
          }
        )
      })

    document
      .querySelectorAll(
        '.manage-from-plan'
      )
      .forEach((button) => {
        button.addEventListener(
          'click',
          async () => {
            await openBillingPortal(
              'overview'
            )
          }
        )
      })
  }

  document
    .querySelectorAll<HTMLButtonElement>(
      '.nav-item'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          const view =
            button.dataset.view

          if (!view) return

          currentView = view
          renderView(view)
        }
      )
    })

  document.querySelector<HTMLSelectElement>('#workspace-switch')!.onchange = async event => {
    const select = event.currentTarget as HTMLSelectElement
    const workspace = state.workspaces.find(item => item.owner_user_id === select.value)
    if (!workspace) return
    select.disabled = true
    setWorkspace(workspace)
    currentView = 'overview'
    selectedWebsiteId = selectedPageId = selectedIssueId = null
    await rerender()
  }
  document.querySelector('#mobile-menu')?.addEventListener('click', () => {
    const open = document.querySelector('.app-shell')!.classList.toggle('nav-open')
    document.querySelector('#mobile-menu')!.setAttribute('aria-expanded', String(open))
  })

  document
    .querySelector<HTMLInputElement>(
      '#global-search'
    )
    ?.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return

        const input =
          event.currentTarget as HTMLInputElement

        const query =
          input.value.trim().toLowerCase()

        if (!query) return

        const page =
          state.pages.find(
            (item) =>
              item.url.toLowerCase().includes(query) ||
              item.title?.toLowerCase().includes(query)
          )

        if (page) {
          selectedPageId = page.id
          currentView = 'page-detail'
          renderView(currentView)
          return
        }

        const issue =
          state.issues.find(
            (item) =>
              item.title.toLowerCase().includes(query) ||
              item.description?.toLowerCase().includes(query)
          )

        if (issue) {
          selectedIssueId = issue.id
          currentView = 'issue-detail'
          renderView(currentView)
          return
        }

        const site =
          state.websites.find(
            (item) =>
              item.name.toLowerCase().includes(query) ||
              item.url.toLowerCase().includes(query)
          )

        if (site) {
          selectedWebsiteId = site.id
          currentView = 'website-detail'
          renderView(currentView)
          return
        }

        toast('No matching website, page or issue found.')
      }
    )

  document
    .querySelector('#logout')
    ?.addEventListener(
      'click',
      async () => {
        await signOut()
        currentView = 'overview'
        await render()
      }
    )

  document
    .querySelector('#open-plans')
    ?.addEventListener(
      'click',
      showPlans
    )

  document
    .querySelector('#close-plans')
    ?.addEventListener(
      'click',
      () => {
        document
          .querySelector(
            '#billing-modal'
          )
          ?.classList.add('hidden')
      }
    )

  document
    .querySelector('#billing-modal')
    ?.addEventListener(
      'click',
      (event) => {
        if (
          event.target ===
          document.querySelector(
            '#billing-modal'
          )
        ) {
          document
            .querySelector(
              '#billing-modal'
            )
            ?.classList.add('hidden')
        }
      }
    )

  renderView(currentView)
}

async function render() {
  const user = await getUser()

  if (!user) {
    authScreen()
    return
  }

  await dashboardScreen(
    user.email ?? 'Account'
  )
}

let renderPending = false
function scheduleRender() {
  if (renderPending) return
  renderPending = true
  setTimeout(() => { renderPending = false; void render().catch(error => toast(errorMessage(error), 'error')) }, 0)
}
supabase.auth.onAuthStateChange(event => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') scheduleRender()
})
if (location.hash.startsWith('#invite=')) currentView = 'team'
scheduleRender()
