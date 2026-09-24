import { createClient } from 'npm:@supabase/supabase-js@2'

const encoder = new TextEncoder()

const PRICE_TO_PLAN: Record<string, string> = {
  pri_01m39091eb9xsa4zh0nazctfz0: 'developer',
  pri_01m390b0j6xchb4br01cvfwbr9: 'webmaster',
  pri_01m390d7vkba71srk1am89jatt: 'freelancer',
  pri_01m390em8pagtx3v71b0ggqq9x: 'professional',
  pri_01m390gjkn1xbg2qske123cjbm: 'studio',
  pri_01m390hfape2sk447bzynmbzf3: 'agency',
  pri_01m390k24chg028ze7xa5zq1rh: 'enterprise',
}

function toHex(buffer: ArrayBuffer) {
  return Array
    .from(new Uint8Array(buffer))
    .map((byte) =>
      byte
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
}

function safeEqual(
  left: string,
  right: string
) {
  if (left.length !== right.length) {
    return false
  }

  let result = 0

  for (
    let i = 0;
    i < left.length;
    i++
  ) {
    result |=
      left.charCodeAt(i) ^
      right.charCodeAt(i)
  }

  return result === 0
}

async function verifySignature(
  rawBody: string,
  header: string,
  secret: string
) {
  const parts = header.split(';')

  const timestamp =
    parts
      .find((part) =>
        part.startsWith('ts=')
      )
      ?.slice(3)

  const signatures =
    parts
      .filter((part) =>
        part.startsWith('h1=')
      )
      .map((part) =>
        part.slice(3)
      )

  if (
    !timestamp ||
    signatures.length === 0
  ) {
    return false
  }

  const key =
    await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      {
        name: 'HMAC',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    )

  const digest =
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(
        `${timestamp}:${rawBody}`
      )
    )

  const expected = toHex(digest)

  return signatures.some(
    (signature) =>
      safeEqual(
        expected,
        signature
      )
  )
}

Deno.serve(
  async (request: Request) => {
    if (request.method !== 'POST') {
      return new Response(
        'Method not allowed',
        {
          status: 405,
        }
      )
    }

    try {
      const rawBody =
        await request.text()

      const signature =
        request.headers.get(
          'Paddle-Signature'
        )

      const secret =
        Deno.env.get(
          'PADDLE_WEBHOOK_SECRET'
        )

      if (!signature || !secret) {
        return new Response(
          'Missing signature',
          {
            status: 400,
          }
        )
      }

      const valid =
        await verifySignature(
          rawBody,
          signature,
          secret
        )

      if (!valid) {
        return new Response(
          'Invalid signature',
          {
            status: 401,
          }
        )
      }

      const event =
        JSON.parse(rawBody)

      if (
        !String(event.event_type)
          .startsWith('subscription.')
      ) {
        return Response.json({
          received: true,
          ignored: true,
        })
      }

      const data = event.data

      const supabase =
        createClient(
          Deno.env.get(
            'SUPABASE_URL'
          )!,
          Deno.env.get(
            'SUPABASE_SERVICE_ROLE_KEY'
          )!
        )

      const subscriptionId =
        typeof data?.id === 'string'
          ? data.id
          : null

      let userId =
        typeof data?.custom_data
          ?.user_id === 'string'
          ? data.custom_data.user_id
          : null

      if (
        !userId &&
        subscriptionId
      ) {
        const { data: existing } =
          await supabase
            .from('subscriptions')
            .select('user_id')
            .eq(
              'paddle_subscription_id',
              subscriptionId
            )
            .maybeSingle()

        userId =
          existing?.user_id ?? null
      }

      if (!userId) {
        throw new Error(
          'Could not map Paddle subscription to Pulsely user.'
        )
      }

      const {
        data: existing,
      } = await supabase
        .from('subscriptions')
        .select(`
          last_paddle_event_at,
          plan
        `)
        .eq('user_id', userId)
        .maybeSingle()

      const occurredAt =
        new Date(
          event.occurred_at
        )

      if (
        existing
          ?.last_paddle_event_at &&
        occurredAt <=
          new Date(
            existing
              .last_paddle_event_at
          )
      ) {
        return Response.json({
          received: true,
          ignored: 'stale_event',
        })
      }

      const matchingItem =
        Array.isArray(data?.items)
          ? data.items.find(
              (item: any) =>
                PRICE_TO_PLAN[
                  item?.price?.id
                ]
            )
          : undefined

      let plan =
        matchingItem
          ? PRICE_TO_PLAN[
              matchingItem.price.id
            ]
          : existing?.plan ??
            'free'

      const status =
        typeof data?.status === 'string'
          ? data.status
          : 'unknown'

      if (status === 'canceled') {
        plan = 'free'
      }

      const scheduledAction =
        data?.scheduled_change
          ?.action ?? null

      const cancelAtPeriodEnd =
        scheduledAction === 'cancel'

      const scheduledChangeAt =
        typeof data
          ?.scheduled_change
          ?.effective_at === 'string'
          ? data
              .scheduled_change
              .effective_at
          : null

      const currentPeriodEnd =
        typeof data
          ?.current_billing_period
          ?.ends_at === 'string'
          ? data
              .current_billing_period
              .ends_at
          : null

      const customerId =
        typeof data
          ?.customer_id === 'string'
          ? data.customer_id
          : null

      const { error } =
        await supabase
          .from('subscriptions')
          .upsert(
            {
              user_id: userId,

              plan,

              status,

              paddle_customer_id:
                customerId,

              paddle_subscription_id:
                subscriptionId,

              current_period_end:
                currentPeriodEnd,

              cancel_at_period_end:
                cancelAtPeriodEnd,

              scheduled_change_at:
                scheduledChangeAt,

              last_paddle_event_at:
                event.occurred_at,

              last_paddle_event_id:
                event.event_id,

              updated_at:
                new Date()
                  .toISOString(),
            },
            {
              onConflict:
                'user_id',
            }
          )

      if (error) {
        throw error
      }

      console.log(
        'Pulsely subscription synced',
        {
          userId,
          plan,
          status,
          cancelAtPeriodEnd,
        }
      )

      return Response.json({
        received: true,
      })
    } catch (error) {
      console.error(
        'Paddle webhook error',
        error
      )

      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Webhook failed',
        },
        {
          status: 500,
        }
      )
    }
  }
)
