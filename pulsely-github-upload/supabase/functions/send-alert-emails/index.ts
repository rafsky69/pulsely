import { createClient } from 'npm:@supabase/supabase-js@2'

function escapeHtml(
  value: string
) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

Deno.serve(
  async (request: Request) => {
    const secret =
      Deno.env.get(
        'PULSELY_CRON_SECRET'
      )

    if (
      !secret ||
      request.headers.get(
        'x-pulsely-cron-secret'
      ) !== secret
    ) {
      return new Response(
        'Unauthorized',
        {
          status: 401,
        }
      )
    }

    const apiKey =
      Deno.env.get(
        'RESEND_API_KEY'
      )

    if (!apiKey) {
      return Response.json({
        configured: false,
        message:
          'RESEND_API_KEY is not configured.',
      })
    }

    const from =
      Deno.env.get(
        'PULSELY_EMAIL_FROM'
      ) ??
      'Pulsely <onboarding@resend.dev>'

    const admin =
      createClient(
        Deno.env.get(
          'SUPABASE_URL'
        )!,
        Deno.env.get(
          'SUPABASE_SERVICE_ROLE_KEY'
        )!
      )

    const {
      data: outbox,
      error,
    } =
      await admin
        .from(
          'alert_outbox'
        )
        .select(`
          id,
          user_id,
          attempts,
          alert:alerts (
            id,
            title,
            message,
            severity
          )
        `)
        .eq(
          'status',
          'pending'
        )
        .order(
          'created_at',
          {
            ascending: true,
          }
        )
        .limit(10)

    if (error) {
      throw error
    }

    let sent = 0

    for (
      const item of
        outbox ?? []
    ) {
      const alert =
        Array.isArray(
          item.alert
        )
          ? item.alert[0]
          : item.alert

      if (!alert) {
        continue
      }

      const {
        data:
          preference,
      } =
        await admin
          .from(
            'alert_preferences'
          )
          .select(
            'email_enabled,critical_only'
          )
          .eq(
            'user_id',
            item.user_id
          )
          .maybeSingle()

      if (
        preference &&
        (
          !preference
            .email_enabled ||
          (
            preference
              .critical_only &&
            ![
              'critical',
              'high',
            ].includes(
              alert.severity
            )
          )
        )
      ) {
        await admin
          .from(
            'alert_outbox'
          )
          .update({
            status:
              'suppressed',
            sent_at:
              new Date()
                .toISOString(),
          })
          .eq(
            'id',
            item.id
          )

        continue
      }

      const {
        data: userData,
      } =
        await admin.auth
          .admin
          .getUserById(
            item.user_id
          )

      const email =
        userData.user?.email

      if (!email) {
        continue
      }

      const response =
        await fetch(
          'https://api.resend.com/emails',
          {
            method: 'POST',

            headers: {
              Authorization:
                `Bearer ${apiKey}`,

              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify({
                from,
                to: [email],

                subject:
                  `[Pulsely] ${alert.title}`,

                html: `
                  <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
                    <h2>${escapeHtml(alert.title)}</h2>
                    <p>${escapeHtml(alert.message ?? '')}</p>
                    <p><strong>Severity:</strong> ${escapeHtml(alert.severity)}</p>
                    <hr>
                    <p style="color:#777;font-size:12px">
                      Sent by Pulsely website monitoring.
                    </p>
                  </div>
                `,
              }),
          }
        )

      if (response.ok) {
        sent++

        await admin
          .from(
            'alert_outbox'
          )
          .update({
            status:
              'sent',

            attempts:
              item.attempts +
              1,

            sent_at:
              new Date()
                .toISOString(),

            last_error:
              null,
          })
          .eq(
            'id',
            item.id
          )
      } else {
        const errorText =
          await response.text()

        const attempts =
          item.attempts + 1

        await admin
          .from(
            'alert_outbox'
          )
          .update({
            attempts,

            status:
              attempts >= 5
                ? 'failed'
                : 'pending',

            last_error:
              errorText.slice(
                0,
                1000
              ),
          })
          .eq(
            'id',
            item.id
          )
      }
    }

    return Response.json({
      configured: true,
      processed:
        outbox?.length ?? 0,
      sent,
    })
  }
)
