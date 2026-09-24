import { createClient } from 'npm:@supabase/supabase-js@2'

Deno.serve(async (request: Request) => {
  const secret =
    Deno.env.get('PULSELY_CRON_SECRET')

  if (
    !secret ||
    request.headers.get('x-pulsely-cron-secret') !== secret
  ) {
    return new Response('Unauthorized', {
      status: 401,
    })
  }

  const supabaseUrl =
    Deno.env.get('SUPABASE_URL')!

  const serviceRole =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const admin =
    createClient(
      supabaseUrl,
      serviceRole
    )

  const now =
    new Date().toISOString()

  const {
    data: uptimeDue,
    error: uptimeError,
  } =
    await admin
      .from('websites')
      .select('id')
      .lte('next_uptime_at', now)
      .order('next_uptime_at', {
        ascending: true,
      })
      .limit(25)

  if (uptimeError) {
    throw uptimeError
  }

  const {
    data: scanDue,
    error: scanError,
  } =
    await admin
      .from('websites')
      .select('id')
      .lte('next_scan_at', now)
      .order('next_scan_at', {
        ascending: true,
      })
      .limit(3)

  if (scanError) {
    throw scanError
  }

  const scanIds =
    new Set(
      (scanDue ?? []).map(
        (site: any) => site.id
      )
    )

  const tasks: Promise<Response>[] = []

  for (const website of uptimeDue ?? []) {
    if (scanIds.has(website.id)) {
      continue
    }

    await admin
      .from('websites')
      .update({
        next_uptime_at:
          new Date(
            Date.now() + 60_000
          ).toISOString(),
      })
      .eq('id', website.id)

    tasks.push(
      fetch(
        `${supabaseUrl}/functions/v1/monitor-site`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'x-pulsely-cron-secret':
              secret,
          },

          body:
            JSON.stringify({
              websiteId:
                website.id,

              mode:
                'uptime',
            }),
        }
      )
    )
  }

  for (const website of scanDue ?? []) {
    await admin
      .from('websites')
      .update({
        next_scan_at:
          new Date(
            Date.now() +
              5 * 60_000
          ).toISOString(),
      })
      .eq('id', website.id)

    tasks.push(
      fetch(
        `${supabaseUrl}/functions/v1/monitor-site`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'x-pulsely-cron-secret':
              secret,
          },

          body:
            JSON.stringify({
              websiteId:
                website.id,

              mode:
                'scan',
            }),
        }
      )
    )
  }

  EdgeRuntime.waitUntil(
    Promise.allSettled(tasks)
  )

  return Response.json({
    uptime:
      uptimeDue?.length ?? 0,

    scans:
      scanDue?.length ?? 0,

    dispatched:
      tasks.length,
  })
})
