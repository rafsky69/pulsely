import { supabase } from './supabase'
import { workspaceId } from './team'

export type Website = {
  id: string
  user_id: string
  name: string
  url: string
  created_at: string

  health_status:
    | 'healthy'
    | 'needs_attention'
    | 'action_required'
    | 'critical'

  http_status: number | null
  last_response_ms: number | null
  last_uptime_at: string | null
  last_scan_at: string | null
  next_uptime_at: string | null
  next_scan_at: string | null
  scan_error: string | null
}

export async function getWebsites() {
  const {
    data,
    error,
  } = await supabase
    .from('websites')
    .select('*')
    .eq('user_id', workspaceId())
    .order(
      'created_at',
      {
        ascending: false,
      }
    )

  if (error) throw error

  return (
    data ?? []
  ) as Website[]
}

export async function addWebsite(
  name: string,
  inputUrl: string
) {
  const {
    data: { session },
  } =
    await supabase.auth
      .getSession()

  if (
    !session?.user
  ) {
    throw new Error(
      'You must be logged in.'
    )
  }

  let url: URL

  try {
    url =
      new URL(
        inputUrl.match(
          /^https?:\/\//i
        )
          ? inputUrl
          : `https://${inputUrl}`
      )
  } catch {
    throw new Error(
      'Enter a valid website URL.'
    )
  }

  const {
    error,
  } =
    await supabase
      .from('websites')
      .insert({
        user_id:
          workspaceId(),

        name:
          name.trim() ||
          url.hostname,

        url:
          url.toString(),
      })

  if (error) {
    if (
      error.message.includes(
        'WEBSITE_LIMIT_REACHED'
      )
    ) {
      throw new Error(
        'You have reached the website limit for your current Pulsely plan.'
      )
    }

    throw error
  }
}

export async function deleteWebsite(
  id: string
) {
  const {
    error,
  } =
    await supabase
      .from('websites')
      .delete()
      .eq(
        'id',
        id
      )
      .select('id')
      .single()

  if (error) throw error
}
