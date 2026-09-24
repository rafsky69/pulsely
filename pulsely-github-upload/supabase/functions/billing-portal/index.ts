import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

Deno.serve(
  async (request: Request) => {
    if (
      request.method === 'OPTIONS'
    ) {
      return new Response('ok', {
        headers: corsHeaders,
      })
    }

    if (request.method !== 'POST') {
      return new Response(
        'Method not allowed',
        {
          status: 405,
          headers: corsHeaders,
        }
      )
    }

    try {
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
              'Not authenticated',
          },
          {
            status: 401,
            headers: corsHeaders,
          }
        )
      }

      const supabaseUrl =
        Deno.env.get(
          'SUPABASE_URL'
        )!

      const serviceRoleKey =
        Deno.env.get(
          'SUPABASE_SERVICE_ROLE_KEY'
        )!

      const admin =
        createClient(
          supabaseUrl,
          serviceRoleKey
        )

      const {
        data: { user },
        error: authError,
      } =
        await admin.auth.getUser(
          token
        )

      if (
        authError ||
        !user
      ) {
        return Response.json(
          {
            error:
              'Invalid session',
          },
          {
            status: 401,
            headers: corsHeaders,
          }
        )
      }

      const {
        data: subscription,
        error: subscriptionError,
      } =
        await admin
          .from('subscriptions')
          .select(`
            paddle_customer_id,
            paddle_subscription_id
          `)
          .eq(
            'user_id',
            user.id
          )
          .maybeSingle()

      if (subscriptionError) {
        throw subscriptionError
      }

      if (
        !subscription
          ?.paddle_customer_id
      ) {
        return Response.json(
          {
            error:
              'This account has no Paddle billing profile.',
          },
          {
            status: 409,
            headers: corsHeaders,
          }
        )
      }

      const body =
        await request.json()
          .catch(() => ({}))

      const mode =
        body?.mode === 'cancel'
          ? 'cancel'
          : 'overview'

      const paddleApiKey =
        Deno.env.get(
          'PADDLE_API_KEY'
        )

      if (!paddleApiKey) {
        throw new Error(
          'PADDLE_API_KEY is not configured.'
        )
      }

      const payload =
        subscription
          .paddle_subscription_id
          ? {
              subscription_ids: [
                subscription
                  .paddle_subscription_id,
              ],
            }
          : {}

      const paddleResponse =
        await fetch(
          `https://api.paddle.com/customers/${subscription.paddle_customer_id}/portal-sessions`,
          {
            method: 'POST',

            headers: {
              Authorization:
                `Bearer ${paddleApiKey}`,

              'Content-Type':
                'application/json',
            },

            body:
              JSON.stringify(
                payload
              ),
          }
        )

      const paddleData =
        await paddleResponse.json()

      if (
        !paddleResponse.ok
      ) {
        console.error(
          'Paddle portal error',
          paddleData
        )

        throw new Error(
          'Could not create Paddle customer portal session.'
        )
      }

      const overviewUrl =
        paddleData
          ?.data
          ?.urls
          ?.general
          ?.overview

      const subscriptionUrls =
        paddleData
          ?.data
          ?.urls
          ?.subscriptions ?? []

      const cancelUrl =
        subscriptionUrls
          .find(
            (entry: any) =>
              entry.id ===
              subscription
                .paddle_subscription_id
          )
          ?.cancel_subscription

      const url =
        mode === 'cancel'
          ? cancelUrl ??
            overviewUrl
          : overviewUrl

      if (!url) {
        throw new Error(
          'Paddle returned no portal URL.'
        )
      }

      return Response.json(
        {
          url,
        },
        {
          headers: corsHeaders,
        }
      )
    } catch (error) {
      console.error(
        'Billing portal error',
        error
      )

      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Billing portal failed.',
        },
        {
          status: 500,
          headers: corsHeaders,
        }
      )
    }
  }
)
