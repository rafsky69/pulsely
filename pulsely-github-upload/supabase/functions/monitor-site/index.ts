import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-pulsely-cron-secret',
}

const PLAN_LIMITS: Record<string, {
  pages: number
  uptimeSeconds: number
  scanMinutes: number
}> = {
  free:          { pages: 50,      uptimeSeconds: 3600, scanMinutes: 10080 },
  developer:     { pages: 500,     uptimeSeconds: 900,  scanMinutes: 1440 },
  webmaster:     { pages: 2500,    uptimeSeconds: 300,  scanMinutes: 720 },
  freelancer:    { pages: 10000,   uptimeSeconds: 120,  scanMinutes: 360 },
  professional:  { pages: 50000,   uptimeSeconds: 60,   scanMinutes: 180 },
  studio:        { pages: 150000,  uptimeSeconds: 60,   scanMinutes: 60 },
  agency:        { pages: 500000,  uptimeSeconds: 30,   scanMinutes: 30 },
  enterprise:    { pages: 2000000, uptimeSeconds: 15,   scanMinutes: 15 },
}

const MAX_PAGES_PER_RUN = 12
const MAX_LINK_CHECKS_PER_RUN = 30
const MAX_LINKS_PER_PAGE = 80

const ASSET_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico',
  '.pdf', '.zip', '.rar', '.7z',
  '.mp3', '.wav', '.mp4', '.mov', '.avi',
  '.css', '.js', '.json',
  '.woff', '.woff2', '.ttf', '.eot',
]

function effectivePlan(subscription: any) {
  if (subscription?.admin_override_plan) {
    return subscription.admin_override_plan
  }

  if (
    ['active', 'trialing', 'past_due', 'admin_granted']
      .includes(subscription?.status)
  ) {
    return subscription?.plan ?? 'free'
  }

  return 'free'
}

function isForbiddenHost(hostname: string) {
  const host = hostname.toLowerCase()

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test') ||
    host.endsWith('.invalid') ||
    host === 'metadata.google.internal' ||
    host === '169.254.169.254' ||
    host === '::1'
  ) {
    return true
  }

  // Do not allow direct IP targets in the crawler.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return true
  }

  if (host.includes(':')) {
    return true
  }

  return false
}

function assertSafeUrl(input: string) {
  const url = new URL(input)

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('Unsupported URL protocol.')
  }

  if (isForbiddenHost(url.hostname)) {
    throw new Error(
      'Local/private/IP targets cannot be monitored.'
    )
  }

  return url
}

type FetchResult = {
  response: Response
  finalUrl: URL
  responseMs: number
  redirects: string[]
}

async function safeFetch(
  input: string,
  method: 'GET' | 'HEAD' = 'GET',
  timeout = 8000
): Promise<FetchResult> {
  let url = assertSafeUrl(input)

  const redirects: string[] = []

  const started = Date.now()

  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(
      url.toString(),
      {
        method,
        redirect: 'manual',

        headers: {
          'User-Agent':
            'PulselyMonitor/1.0 (+website maintenance monitor)',
          Accept:
            method === 'HEAD'
              ? '*/*'
              : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        },

        signal:
          AbortSignal.timeout(timeout),
      }
    )

    if (
      response.status >= 300 &&
      response.status < 400
    ) {
      const location =
        response.headers.get('location')

      if (!location) {
        return {
          response,
          finalUrl: url,
          responseMs: Date.now() - started,
          redirects,
        }
      }

      const next =
        assertSafeUrl(
          new URL(location, url).toString()
        )

      redirects.push(next.toString())

      url = next

      continue
    }

    return {
      response,
      finalUrl: url,
      responseMs: Date.now() - started,
      redirects,
    }
  }

  throw new Error('Too many redirects.')
}

async function readLimitedText(
  response: Response,
  maxBytes = 1_000_000
) {
  if (!response.body) return ''

  const reader = response.body.getReader()

  const pieces: Uint8Array[] = []

  let total = 0

  while (true) {
    const {
      done,
      value,
    } = await reader.read()

    if (done) break
    if (!value) continue

    const remaining =
      maxBytes - total

    if (remaining <= 0) {
      await reader.cancel()
      break
    }

    const piece =
      value.length > remaining
        ? value.slice(0, remaining)
        : value

    pieces.push(piece)

    total += piece.length

    if (value.length > remaining) {
      await reader.cancel()
      break
    }
  }

  const merged =
    new Uint8Array(total)

  let offset = 0

  for (const piece of pieces) {
    merged.set(piece, offset)
    offset += piece.length
  }

  return new TextDecoder().decode(merged)
}

function attribute(
  tag: string,
  name: string
) {
  const regex =
    new RegExp(
      `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      'i'
    )

  const match = tag.match(regex)

  return (
    match?.[1] ??
    match?.[2] ??
    match?.[3] ??
    null
  )
}

function extractDocument(html: string) {
  const titleMatch =
    html.match(
      /<title\b[^>]*>([\s\S]*?)<\/title>/i
    )

  const title =
    titleMatch?.[1]
      ?.replace(/\s+/g, ' ')
      .trim() || null

  const metaTags =
    html.match(/<meta\b[^>]*>/gi) ?? []

  let metaDescription: string | null = null

  for (const tag of metaTags) {
    const name =
      attribute(tag, 'name')
        ?.toLowerCase()

    if (name === 'description') {
      metaDescription =
        attribute(tag, 'content')
          ?.trim() || null

      break
    }
  }

  const linkTags =
    html.match(/<link\b[^>]*>/gi) ?? []

  let canonicalUrl: string | null = null

  for (const tag of linkTags) {
    const rel =
      attribute(tag, 'rel')
        ?.toLowerCase()

    if (
      rel?.split(/\s+/)
        .includes('canonical')
    ) {
      canonicalUrl =
        attribute(tag, 'href')

      break
    }
  }

  const h1Count =
    (
      html.match(
        /<h1\b[^>]*>/gi
      ) ?? []
    ).length

  return {
    title,
    metaDescription,
    canonicalUrl,
    h1Count,
  }
}

function extractLinks(
  html: string,
  source: URL,
  rootOrigin: string
) {
  const links =
    new Map<
      string,
      {
        url: string
        internal: boolean
      }
    >()

  const regex =
    /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi

  let match: RegExpExecArray | null

  while (
    (match = regex.exec(html)) &&
    links.size < MAX_LINKS_PER_PAGE
  ) {
    const href =
      match[1] ??
      match[2] ??
      match[3]

    if (!href) continue

    const trimmed = href.trim()

    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:') ||
      trimmed.startsWith('javascript:')
    ) {
      continue
    }

    try {
      const url =
        new URL(trimmed, source)

      if (
        url.protocol !== 'http:' &&
        url.protocol !== 'https:'
      ) {
        continue
      }

      url.hash = ''

      if (
        ASSET_EXTENSIONS.some(
          (extension) =>
            url.pathname
              .toLowerCase()
              .endsWith(extension)
        )
      ) {
        continue
      }

      links.set(
        url.toString(),
        {
          url: url.toString(),
          internal:
            url.origin === rootOrigin,
        }
      )
    } catch {
      // ignore malformed href
    }
  }

  return [...links.values()]
}

async function sha256(value: string) {
  const data =
    new TextEncoder().encode(value)

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      data
    )

  return Array.from(
    new Uint8Array(digest)
  )
    .map(
      byte =>
        byte.toString(16)
          .padStart(2, '0')
    )
    .join('')
}

function severityForHttp(
  status: number
) {
  if (status >= 500) {
    return 'critical'
  }

  if (
    status >= 400 &&
    ![401, 403, 429].includes(status)
  ) {
    return 'high'
  }

  return null
}

async function checkTlsExpiry(
  hostname: string
): Promise<string | null> {
  try {
    const tls =
      await import('node:tls')

    return await new Promise(
      (resolve) => {
        const socket =
          tls.connect(
            {
              host: hostname,
              port: 443,
              servername: hostname,
              rejectUnauthorized: true,
              timeout: 5000,
            },
            () => {
              try {
                const certificate =
                  socket.getPeerCertificate()

                const validTo =
                  certificate &&
                  'valid_to' in certificate
                    ? certificate.valid_to
                    : null

                socket.end()

                if (!validTo) {
                  resolve(null)
                  return
                }

                resolve(
                  new Date(validTo)
                    .toISOString()
                )
              } catch {
                socket.destroy()
                resolve(null)
              }
            }
          )

        socket.on(
          'error',
          () => resolve(null)
        )

        socket.on(
          'timeout',
          () => {
            socket.destroy()
            resolve(null)
          }
        )
      }
    )
  } catch {
    return null
  }
}

Deno.serve(
  async (request: Request) => {
    if (
      request.method === 'OPTIONS'
    ) {
      return new Response(
        'ok',
        { headers: corsHeaders }
      )
    }

    if (
      request.method !== 'POST'
    ) {
      return new Response(
        'Method not allowed',
        {
          status: 405,
          headers: corsHeaders,
        }
      )
    }

    const supabaseUrl =
      Deno.env.get(
        'SUPABASE_URL'
      )!

    const serviceRole =
      Deno.env.get(
        'SUPABASE_SERVICE_ROLE_KEY'
      )!

    const internalSecret =
      Deno.env.get(
        'PULSELY_CRON_SECRET'
      )

    const admin =
      createClient(
        supabaseUrl,
        serviceRole
      )

    try {
      const body =
        await request.json()

      const websiteId =
        body?.websiteId

      const mode =
        body?.mode === 'uptime'
          ? 'uptime'
          : 'scan'

      if (!websiteId) {
        throw new Error(
          'websiteId is required.'
        )
      }

      const suppliedInternal =
        request.headers.get(
          'x-pulsely-cron-secret'
        )

      let currentUserId:
        string | null = null

      const internalCall =
        Boolean(
          internalSecret &&
          suppliedInternal ===
            internalSecret
        )

      if (!internalCall) {
        const authHeader =
          request.headers.get(
            'Authorization'
          )

        const token =
          authHeader
            ?.replace(
              /^Bearer\s+/i,
              ''
            )
            .trim()

        if (!token) {
          return Response.json(
            {
              error:
                'Not authenticated.',
            },
            {
              status: 401,
              headers: corsHeaders,
            }
          )
        }

        const {
          data: { user },
          error,
        } =
          await admin.auth
            .getUser(token)

        if (
          error ||
          !user
        ) {
          return Response.json(
            {
              error:
                'Invalid session.',
            },
            {
              status: 401,
              headers: corsHeaders,
            }
          )
        }

        currentUserId =
          user.id
      }

      let websiteQuery =
        admin
          .from('websites')
          .select('*')
          .eq('id', websiteId)

      if (currentUserId) {
        websiteQuery =
          websiteQuery.eq(
            'user_id',
            currentUserId
          )
      }

      const {
        data: website,
        error: websiteError,
      } =
        await websiteQuery
          .maybeSingle()

      if (websiteError) {
        throw websiteError
      }

      if (!website) {
        return Response.json(
          {
            error:
              'Website not found.',
          },
          {
            status: 404,
            headers: corsHeaders,
          }
        )
      }

      const userId =
        website.user_id

      const {
        data: subscription,
      } =
        await admin
          .from('subscriptions')
          .select(`
            plan,
            status,
            admin_override_plan
          `)
          .eq(
            'user_id',
            userId
          )
          .maybeSingle()

      const plan =
        effectivePlan(
          subscription
        )

      const limits =
        PLAN_LIMITS[plan] ??
        PLAN_LIMITS.free

      async function syncIssue(
        fingerprint: string,
        options:
          | {
              active: true
              type: string
              severity: string
              title: string
              description: string
              pageId?: string | null
            }
          | {
              active: false
            }
      ) {
        if (!options.active) {
          const { error } =
            await admin
              .from('issues')
              .update({
                status:
                  'resolved',

                resolved_at:
                  new Date()
                    .toISOString(),

                updated_at:
                  new Date()
                    .toISOString(),
              })
              .eq(
                'user_id',
                userId
              )
              .eq(
                'fingerprint',
                fingerprint
              )
              .neq(
                'status',
                'resolved'
              )

          if (error) {
            throw error
          }

          return
        }

        const { error } =
          await admin
            .from('issues')
            .upsert(
              {
                user_id:
                  userId,

                website_id:
                  websiteId,

                page_id:
                  options.pageId ??
                  null,

                fingerprint,

                type:
                  options.type,

                severity:
                  options.severity,

                title:
                  options.title,

                description:
                  options.description,

                status: 'open',

                resolved_at:
                  null,

                updated_at:
                  new Date()
                    .toISOString(),
              },
              {
                onConflict:
                  'user_id,fingerprint',
              }
            )

        if (error) {
          throw error
        }
      }

      const now = new Date()

      const nextUptime =
        new Date(
          now.getTime() +
            limits.uptimeSeconds *
              1000
        )

      const nextScan =
        new Date(
          now.getTime() +
            limits.scanMinutes *
              60 *
              1000
        )

      let rootResult:
        FetchResult

      try {
        rootResult =
          await safeFetch(
            website.url
          )
      } catch (error) {
        await syncIssue(
          `site:${websiteId}:unreachable`,
          {
            active: true,
            type:
              'site_unreachable',
            severity:
              'critical',
            title:
              'Website unreachable',
            description:
              error instanceof Error
                ? error.message
                : 'Website could not be reached.',
          }
        )

        await admin
          .from('monitoring_runs')
          .insert({
            user_id: userId,
            website_id:
              websiteId,
            mode,
            success: false,
          })

        await admin
          .from('websites')
          .update({
            health_status:
              'critical',

            scan_error:
              error instanceof Error
                ? error.message
                : 'Website unreachable.',

            last_uptime_at:
              now.toISOString(),

            next_uptime_at:
              nextUptime
                .toISOString(),

            ...(mode === 'scan'
              ? {
                  last_scan_at:
                    now.toISOString(),

                  next_scan_at:
                    nextScan
                      .toISOString(),
                }
              : {}),
          })
          .eq(
            'id',
            websiteId
          )

        return Response.json(
          {
            ok: false,
            health:
              'critical',
            error:
              error instanceof Error
                ? error.message
                : 'Website unreachable.',
          },
          {
            headers:
              corsHeaders,
          }
        )
      }

      await syncIssue(
        `site:${websiteId}:unreachable`,
        {
          active: false,
        }
      )

      const rootStatus =
        rootResult.response.status

      const rootSeverity =
        severityForHttp(
          rootStatus
        )

      await syncIssue(
        `site:${websiteId}:http`,
        rootSeverity
          ? {
              active: true,
              type:
                'http_error',
              severity:
                rootSeverity,
              title:
                `Website returned HTTP ${rootStatus}`,
              description:
                `${rootResult.finalUrl} returned HTTP ${rootStatus}.`,
            }
          : {
              active: false,
            }
      )

      await syncIssue(
        `site:${websiteId}:slow`,
        rootResult.responseMs >
          3000
          ? {
              active: true,
              type:
                'slow_response',
              severity:
                'warning',
              title:
                'Slow website response',
              description:
                `Homepage responded in ${rootResult.responseMs}ms.`,
            }
          : {
              active: false,
            }
      )

      await admin
        .from('monitoring_runs')
        .insert({
          user_id: userId,
          website_id:
            websiteId,
          mode,
          success:
            rootStatus < 500,
          status_code:
            rootStatus,
          response_ms:
            rootResult
              .responseMs,
        })

      if (mode === 'uptime') {
        const {
          data: openIssues,
        } =
          await admin
            .from('issues')
            .select('severity')
            .eq(
              'website_id',
              websiteId
            )
            .in(
              'status',
              [
                'open',
                'in_progress',
              ]
            )

        const severities =
          new Set(
            (openIssues ?? [])
              .map(
                (issue: any) =>
                  issue.severity
              )
          )

        const health =
          severities.has(
            'critical'
          )
            ? 'critical'
            : severities.has(
                'high'
              )
              ? 'action_required'
              : (
                  severities.has(
                    'warning'
                  ) ||
                  severities.has(
                    'info'
                  )
                )
                ? 'needs_attention'
                : 'healthy'

        await admin
          .from('websites')
          .update({
            health_status:
              health,

            http_status:
              rootStatus,

            last_response_ms:
              rootResult
                .responseMs,

            last_uptime_at:
              now.toISOString(),

            next_uptime_at:
              nextUptime
                .toISOString(),

            scan_error: null,
          })
          .eq(
            'id',
            websiteId
          )

        return Response.json(
          {
            ok: true,
            mode,
            plan,
            status:
              rootStatus,
            responseMs:
              rootResult
                .responseMs,
            health,
          },
          {
            headers:
              corsHeaders,
          }
        )
      }

      const root =
        assertSafeUrl(
          website.url
        )

      let robotsStatus:
        number | null = null

      let sitemapStatus:
        number | null = null

      let sitemapUrl:
        string | null = null

      try {
        const robots =
          await safeFetch(
            new URL(
              '/robots.txt',
              root.origin
            ).toString()
          )

        robotsStatus =
          robots.response.status

        if (
          robots.response.ok
        ) {
          const robotsText =
            await readLimitedText(
              robots.response,
              200000
            )

          const sitemapMatch =
            robotsText.match(
              /^sitemap:\s*(.+)$/im
            )

          if (sitemapMatch) {
            try {
              sitemapUrl =
                new URL(
                  sitemapMatch[1]
                    .trim(),
                  root.origin
                ).toString()
            } catch {
              sitemapUrl = null
            }
          }

          const blocksEverything =
            /user-agent:\s*\*[\s\S]{0,800}?disallow:\s*\/\s*(?:\r?\n|$)/i
              .test(
                robotsText
              )

          await syncIssue(
            `site:${websiteId}:robots-block-all`,
            blocksEverything
              ? {
                  active: true,
                  type:
                    'robots_blocking',
                  severity:
                    'high',
                  title:
                    'robots.txt blocks the entire site',
                  description:
                    'User-agent * appears to be disallowed from crawling /. Verify this is intentional.',
                }
              : {
                  active: false,
                }
          )
        }
      } catch {
        robotsStatus = null
      }

      sitemapUrl ??=
        new URL(
          '/sitemap.xml',
          root.origin
        ).toString()

      try {
        const sitemap =
          await safeFetch(
            sitemapUrl,
            'HEAD'
          )

        sitemapStatus =
          sitemap.response.status

        const missing =
          !sitemap.response.ok

        await syncIssue(
          `site:${websiteId}:sitemap`,
          missing
            ? {
                active: true,
                type:
                  'sitemap',
                severity:
                  'info',
                title:
                  'Sitemap could not be loaded',
                description:
                  `${sitemapUrl} returned HTTP ${sitemap.response.status}.`,
              }
            : {
                active: false,
              }
        )
      } catch {
        sitemapStatus = null
      }

      let sslExpiresAt:
        string | null = null

      if (
        root.protocol ===
        'https:'
      ) {
        sslExpiresAt =
          await checkTlsExpiry(
            root.hostname
          )

        if (sslExpiresAt) {
          const remainingDays =
            Math.ceil(
              (
                new Date(
                  sslExpiresAt
                ).getTime() -
                Date.now()
              ) /
              86400000
            )

          if (
            remainingDays <= 30
          ) {
            const severity =
              remainingDays <= 0
                ? 'critical'
                : remainingDays <= 14
                  ? 'high'
                  : 'warning'

            await syncIssue(
              `site:${websiteId}:ssl-expiry`,
              {
                active: true,
                type:
                  'ssl_expiry',
                severity,
                title:
                  remainingDays <= 0
                    ? 'SSL certificate has expired'
                    : `SSL certificate expires in ${remainingDays} days`,
                description:
                  `Certificate expiry: ${sslExpiresAt}`,
              }
            )
          } else {
            await syncIssue(
              `site:${websiteId}:ssl-expiry`,
              {
                active: false,
              }
            )
          }
        }
      }

      const {
        count: pageCount,
      } =
        await admin
          .from('pages')
          .select(
            '*',
            {
              count:
                'exact',
              head: true,
            }
          )
          .eq(
            'user_id',
            userId
          )

      let remainingPages =
        Math.max(
          0,
          limits.pages -
            (pageCount ?? 0)
        )

      const {
        data: oldPages,
      } =
        await admin
          .from('pages')
          .select(
            'id,url,last_scan_at'
          )
          .eq(
            'website_id',
            websiteId
          )
          .order(
            'last_scan_at',
            {
              ascending:
                true,
              nullsFirst:
                true,
            }
          )
          .limit(
            MAX_PAGES_PER_RUN -
              1
          )

      const queue =
        new Set<string>()

      queue.add(
        rootResult.finalUrl
          .toString()
      )

      for (
        const page of
          oldPages ?? []
      ) {
        queue.add(page.url)
      }

      let scannedPages = 0
      let checkedLinks = 0

      const discovered =
        new Set<string>()

      for (
        const pageUrl of
          queue
      ) {
        if (
          scannedPages >=
          MAX_PAGES_PER_RUN
        ) {
          break
        }

        let result:
          FetchResult

        try {
          result =
            pageUrl ===
            rootResult.finalUrl
              .toString()
              ? rootResult
              : await safeFetch(
                  pageUrl
                )
        } catch {
          continue
        }

        scannedPages++

        const finalUrl =
          result.finalUrl
            .toString()

        let html = ''

        const contentType =
          result.response
            .headers
            .get(
              'content-type'
            ) ?? ''

        if (
          contentType.includes(
            'text/html'
          )
        ) {
          html =
            await readLimitedText(
              result.response
            )
        }

        const documentData =
          extractDocument(html)

        const contentHash =
          html
            ? await sha256(html)
            : null

        const {
          data: existing,
        } =
          await admin
            .from('pages')
            .select('id')
            .eq(
              'website_id',
              websiteId
            )
            .eq(
              'url',
              finalUrl
            )
            .maybeSingle()

        const pageSeverity =
          severityForHttp(
            result.response
              .status
          )

        const pageHealth =
          pageSeverity ===
          'critical'
            ? 'critical'
            : pageSeverity ===
              'high'
              ? 'action_required'
              : result.responseMs >
                3000
                ? 'needs_attention'
                : 'healthy'

        let pageId =
          existing?.id ??
          null

        const values = {
          title:
            documentData.title,

          meta_description:
            documentData
              .metaDescription,

          h1_count:
            documentData
              .h1Count,

          canonical_url:
            documentData
              .canonicalUrl,

          content_hash:
            contentHash,

          http_status:
            result.response
              .status,

          response_ms:
            result.responseMs,

          redirect_count:
            result.redirects
              .length,

          health_status:
            pageHealth,

          last_scan_at:
            now.toISOString(),

          updated_at:
            now.toISOString(),
        }

        if (pageId) {
          const { error } =
            await admin
              .from('pages')
              .update(values)
              .eq(
                'id',
                pageId
              )

          if (error) {
            throw error
          }
        } else if (
          remainingPages >
          0
        ) {
          const {
            data: created,
            error,
          } =
            await admin
              .from('pages')
              .insert({
                user_id:
                  userId,

                website_id:
                  websiteId,

                url:
                  finalUrl,

                ...values,

                next_human_review_at:
                  new Date(
                    Date.now() +
                    365 *
                      86400000
                  ).toISOString(),
              })
              .select('id')
              .single()

          if (!error && created) {
            pageId =
              created.id

            remainingPages--
          }
        }

        if (!pageId) {
          continue
        }

        await syncIssue(
          `page:${pageId}:http`,
          pageSeverity
            ? {
                active: true,
                pageId,
                type:
                  'http_error',
                severity:
                  pageSeverity,
                title:
                  `Page returned HTTP ${result.response.status}`,
                description:
                  finalUrl,
              }
            : {
                active: false,
              }
        )

        await syncIssue(
          `page:${pageId}:slow`,
          result.responseMs >
          3000
            ? {
                active: true,
                pageId,
                type:
                  'slow_response',
                severity:
                  'warning',
                title:
                  'Slow page response',
                description:
                  `${finalUrl} responded in ${result.responseMs}ms.`,
              }
            : {
                active: false,
              }
        )

        await syncIssue(
          `page:${pageId}:title`,
          !documentData.title
            ? {
                active: true,
                pageId,
                type:
                  'missing_title',
                severity:
                  'warning',
                title:
                  'Missing page title',
                description:
                  finalUrl,
              }
            : {
                active: false,
              }
        )

        await syncIssue(
          `page:${pageId}:meta-description`,
          !documentData
            .metaDescription
            ? {
                active: true,
                pageId,
                type:
                  'missing_meta_description',
                severity:
                  'info',
                title:
                  'Missing meta description',
                description:
                  finalUrl,
              }
            : {
                active: false,
              }
        )

        await syncIssue(
          `page:${pageId}:h1`,
          documentData.h1Count ===
          0
            ? {
                active: true,
                pageId,
                type:
                  'missing_h1',
                severity:
                  'warning',
                title:
                  'Page has no H1 heading',
                description:
                  finalUrl,
              }
            : documentData
                .h1Count > 1
              ? {
                  active: true,
                  pageId,
                  type:
                    'multiple_h1',
                  severity:
                    'info',
                  title:
                    `Page has ${documentData.h1Count} H1 headings`,
                  description:
                    finalUrl,
                }
              : {
                  active: false,
                }
        )

        await syncIssue(
          `page:${pageId}:redirect-chain`,
          result.redirects
            .length >= 2
            ? {
                active: true,
                pageId,
                type:
                  'redirect_chain',
                severity:
                  'warning',
                title:
                  'Redirect chain detected',
                description:
                  `${pageUrl} followed ${result.redirects.length} redirects.`,
              }
            : {
                active: false,
              }
        )

        if (!html) {
          continue
        }

        const links =
          extractLinks(
            html,
            result.finalUrl,
            root.origin
          )

        for (
          const link of links
        ) {
          if (link.internal) {
            discovered.add(
              link.url
            )
          }

          const {
            error:
              linkStoreError,
          } =
            await admin
              .from('page_links')
              .upsert(
                {
                  user_id:
                    userId,

                  website_id:
                    websiteId,

                  source_page_id:
                    pageId,

                  target_url:
                    link.url,

                  target_host:
                    new URL(
                      link.url
                    ).hostname,

                  is_internal:
                    link.internal,
                },
                {
                  onConflict:
                    'source_page_id,target_url',
                }
              )

          if (linkStoreError) {
            throw linkStoreError
          }

          if (
            checkedLinks >=
            MAX_LINK_CHECKS_PER_RUN
          ) {
            continue
          }

          checkedLinks++

          let targetStatus:
            number | null = null

          let broken = false

          try {
            let target =
              await safeFetch(
                link.url,
                'HEAD',
                6000
              )

            if (
              target.response
                .status === 405
            ) {
              target =
                await safeFetch(
                  link.url,
                  'GET',
                  6000
                )
            }

            targetStatus =
              target.response
                .status

            broken =
              targetStatus === 404 ||
              targetStatus === 410 ||
              targetStatus >= 500 ||
              (
                targetStatus >= 400 &&
                ![
                  401,
                  403,
                  429,
                ].includes(
                  targetStatus
                )
              )
          } catch {
            broken = true
          }

          await admin
            .from('page_links')
            .update({
              last_status:
                targetStatus,

              is_broken:
                broken,

              last_checked_at:
                now.toISOString(),
            })
            .eq(
              'source_page_id',
              pageId
            )
            .eq(
              'target_url',
              link.url
            )

          const linkHash =
            (
              await sha256(
                link.url
              )
            ).slice(0, 24)

          await syncIssue(
            `link:${pageId}:${linkHash}`,
            broken
              ? {
                  active: true,
                  pageId,

                  type:
                    link.internal
                      ? 'broken_internal_link'
                      : 'broken_external_link',

                  severity:
                    link.internal
                      ? 'high'
                      : 'warning',

                  title:
                    link.internal
                      ? 'Broken internal link'
                      : 'Broken external link',

                  description:
                    `${finalUrl} links to ${link.url}${targetStatus ? ` (HTTP ${targetStatus})` : ''}.`,
                }
              : {
                  active: false,
                }
          )
        }
      }

      if (
        remainingPages > 0
      ) {
        for (
          const url of
            [...discovered]
              .slice(
                0,
                Math.min(
                  remainingPages,
                  100
                )
              )
        ) {
          const {
            data: exists,
          } =
            await admin
              .from('pages')
              .select('id')
              .eq(
                'website_id',
                websiteId
              )
              .eq(
                'url',
                url
              )
              .maybeSingle()

          if (exists) {
            continue
          }

          const { error } =
            await admin
              .from('pages')
              .insert({
                user_id:
                  userId,

                website_id:
                  websiteId,

                url,

                next_human_review_at:
                  new Date(
                    Date.now() +
                    365 *
                      86400000
                  ).toISOString(),
              })

          if (!error) {
            remainingPages--
          }

          if (
            remainingPages <= 0
          ) {
            break
          }
        }
      }

      const {
        data: openIssues,
      } =
        await admin
          .from('issues')
          .select('severity')
          .eq(
            'website_id',
            websiteId
          )
          .in(
            'status',
            [
              'open',
              'in_progress',
            ]
          )

      const severities =
        new Set(
          (openIssues ?? [])
            .map(
              (issue: any) =>
                issue.severity
            )
        )

      const health =
        severities.has(
          'critical'
        )
          ? 'critical'
          : severities.has(
              'high'
            )
            ? 'action_required'
            : (
                severities.has(
                  'warning'
                ) ||
                severities.has(
                  'info'
                )
              )
              ? 'needs_attention'
              : 'healthy'

      await admin
        .from('websites')
        .update({
          health_status:
            health,

          http_status:
            rootStatus,

          last_response_ms:
            rootResult
              .responseMs,

          last_uptime_at:
            now.toISOString(),

          last_scan_at:
            now.toISOString(),

          next_uptime_at:
            nextUptime
              .toISOString(),

          next_scan_at:
            nextScan
              .toISOString(),

          scan_error: null,

          robots_status:
            robotsStatus,

          sitemap_status:
            sitemapStatus,

          ssl_expires_at:
            sslExpiresAt,

          last_ssl_check_at:
            now.toISOString(),
        })
        .eq(
          'id',
          websiteId
        )

      return Response.json(
        {
          ok: true,
          mode,
          plan,
          scannedPages,
          checkedLinks,
          discovered:
            discovered.size,
          health,
          nextScan:
            nextScan
              .toISOString(),
        },
        {
          headers:
            corsHeaders,
        }
      )
    } catch (error) {
      let message =
        'Monitoring failed.'

      if (
        error instanceof Error
      ) {
        message =
          error.message
      } else if (
        error &&
        typeof error ===
          'object'
      ) {
        const value =
          error as Record<
            string,
            unknown
          >

        const parts = [
          value.message,
          value.details,
          value.hint,
          value.code
            ? `Code: ${value.code}`
            : null,
        ].filter(Boolean)

        if (
          parts.length
        ) {
          message =
            parts.join(' | ')
        } else {
          message =
            JSON.stringify(error)
        }
      }

      console.error(
        'Pulsely monitor error:',
        message,
        error
      )

      return Response.json(
        {
          error: message,
        },
        {
          status: 500,
          headers:
            corsHeaders,
        }
      )
    }
  }
)
