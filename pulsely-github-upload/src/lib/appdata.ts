import { supabase } from './supabase'
import { workspaceId } from './team'

export type PageRecord = {
  id: string
  website_id: string
  url: string
  title: string | null
  meta_description?: string | null
  h1_count?: number | null
  canonical_url?: string | null
  content_hash?: string | null
  redirect_count?: number | null
  health_status: string
  http_status: number | null
  response_ms?: number | null
  last_scan_at: string | null
  last_human_review_at: string | null
  next_human_review_at: string
}

export type IssueRecord = {
  id: string
  website_id: string
  page_id: string | null
  severity: string
  title: string
  description: string | null
  status: string
  detected_at: string
  resolved_at?: string | null
  type?: string
}

export type AlertRecord = {
  id: string
  title: string
  message: string | null
  severity?: string
  created_at: string
  read_at: string | null
}

export type ReportRecord = {
  id: string
  name: string
  created_at: string
  summary: Record<string, any>
}

export type PageLinkRecord = {
  id: string
  website_id: string
  source_page_id: string
  target_url: string
  target_host: string | null
  is_internal: boolean
  last_status: number | null
  is_broken: boolean
  last_checked_at: string | null
}

export type MonitoringRunRecord = {
  id: string
  website_id: string
  page_id?: string | null
  mode: string
  success: boolean
  status_code: number | null
  response_ms: number | null
  checked_at: string
}

export async function getPages() {
  const {
    data,
    error,
  } =
    await supabase
      .from('pages')
      .select('*')
      .eq('user_id', workspaceId())
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(250)

  if (error) throw error

  return (
    data ?? []
  ) as PageRecord[]
}

export async function getPageLinks(
  pageId: string
) {
  const {
    data,
    error,
  } =
    await supabase
      .from('page_links')
      .select('*')
      .eq(
        'source_page_id',
        pageId
      )
      .order(
        'is_broken',
        {
          ascending: false,
        }
      )
      .limit(250)

  if (error) throw error

  return (
    data ?? []
  ) as PageLinkRecord[]
}

export async function getMonitoringRuns(
  websiteId: string
) {
  const {
    data,
    error,
  } =
    await supabase
      .from('monitoring_runs')
      .select('*')
      .eq(
        'website_id',
        websiteId
      )
      .order(
        'checked_at',
        {
          ascending: false,
        }
      )
      .limit(80)

  if (error) throw error

  return (
    data ?? []
  ) as MonitoringRunRecord[]
}

export async function getReviewQueue() {
  const {
    data,
    error,
  } =
    await supabase
      .from('pages')
      .select('*')
      .eq('user_id', workspaceId())
      .lte(
        'next_human_review_at',
        new Date()
          .toISOString()
      )
      .order(
        'next_human_review_at',
        {
          ascending: true,
        }
      )
      .limit(250)

  if (error) throw error

  return (
    data ?? []
  ) as PageRecord[]
}

export async function completeReview(
  pageId: string,
  notes: string
) {
  const {
    error,
  } =
    await supabase.rpc(
      'complete_human_review',
      {
        target_page_id:
          pageId,

        review_notes:
          notes || null,
      }
    )

  if (error) throw error
}

export async function updateIssueStatus(
  issueId: string,
  status: string
) {
  const {
    error,
  } =
    await supabase
      .from('issues')
      .update({
        status,
        updated_at:
          new Date()
            .toISOString(),
        resolved_at:
          status === 'resolved'
            ? new Date()
                .toISOString()
            : null,
      })
      .eq(
        'id',
        issueId
      )
      .select('id')
      .single()

  if (error) throw error
}

export async function getIssues() {
  const {
    data,
    error,
  } =
    await supabase
      .from('issues')
      .select('*')
      .eq('user_id', workspaceId())
      .order(
        'detected_at',
        {
          ascending: false,
        }
      )
      .limit(250)

  if (error) throw error

  return (
    data ?? []
  ) as IssueRecord[]
}

export async function getIssueHistory(
  issueId: string
) {
  const {
    data,
    error,
  } =
    await supabase
      .from('issue_history')
      .select('*')
      .eq(
        'issue_id',
        issueId
      )
      .order(
        'created_at',
        {
          ascending: false,
        }
      )

  if (error) throw error

  return data ?? []
}

export async function getAlerts() {
  const {
    data,
    error,
  } =
    await supabase
      .from('alerts')
      .select('*')
      .eq('user_id', workspaceId())
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(250)

  if (error) throw error

  const { data: receipts, error: receiptError } = await supabase.from('alert_receipts').select('alert_id,read_at').in('alert_id', (data ?? []).map(row => row.id))
  if (receiptError) throw receiptError
  const { data: { session } } = await supabase.auth.getSession()
  const read = new Map((receipts ?? []).map(row => [row.alert_id, row.read_at]))
  return (data ?? []).map(row => ({ ...row, read_at: read.get(row.id) ?? (row.user_id === session?.user.id ? row.read_at : null) })) as AlertRecord[]
}

export async function markAlertRead(
  id: string
) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Sign in to continue.')
  const {
    error,
  } =
    await supabase
      .from('alert_receipts')
      .upsert({
        user_id: session.user.id,
        alert_id: id,
        read_at:
          new Date()
            .toISOString(),
      })

  if (error) throw error
}

export async function getAlertPreferences() {
  const {
    data,
    error,
  } =
    await supabase
      .from(
        'alert_preferences'
      )
      .select(
        'email_enabled,critical_only'
      )
      .single()

  if (error) throw error

  return data
}

export async function setAlertPreferences(
  emailEnabled: boolean,
  criticalOnly: boolean
) {
  const {
    data: { user },
  } =
    await supabase.auth
      .getUser()

  if (!user) {
    throw new Error(
      'Not logged in.'
    )
  }

  const {
    error,
  } =
    await supabase
      .from(
        'alert_preferences'
      )
      .update({
        email_enabled:
          emailEnabled,

        critical_only:
          criticalOnly,

        updated_at:
          new Date()
            .toISOString(),
      })
      .eq(
        'user_id',
        user.id
      )

  if (error) throw error
}

export async function getReports() {
  const {
    data,
    error,
  } =
    await supabase
      .from('reports')
      .select('*')
      .eq('user_id', workspaceId())
      .order(
        'created_at',
        {
          ascending: false,
        }
      )
      .limit(100)

  if (error) throw error

  return (
    data ?? []
  ) as ReportRecord[]
}

export async function generateReport(
  days = 30
) {
  const {
    data,
    error,
  } =
    await supabase
      .functions
      .invoke(
        'generate-report',
        {
          body: {
            days,
            ownerId: workspaceId(),
          },
        }
      )

  if (error) throw error

  if (data?.error) {
    throw new Error(
      data.error
    )
  }

  return data
}

export async function getUsage() {
  const [
    sites,
    pages,
  ] =
    await Promise.all([
      supabase
        .from('websites')
        .select(
          '*',
          {
            count:
              'exact',
            head: true,
          }
        )
        .eq('user_id', workspaceId()),

      supabase
        .from('pages')
        .select(
          '*',
          {
            count:
              'exact',
            head: true,
          }
        )
        .eq('user_id', workspaceId()),
    ])

  if (sites.error) {
    throw sites.error
  }

  if (pages.error) {
    throw pages.error
  }

  return {
    websites:
      sites.count ?? 0,

    pages:
      pages.count ?? 0,

    members: 1,
  }
}
