import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
}

Deno.serve(
  async (request: Request) => {
    if (
      request.method ===
      'OPTIONS'
    ) {
      return new Response(
        'ok',
        {
          headers:
            corsHeaders,
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
              'Not authenticated.',
          },
          {
            status: 401,
            headers:
              corsHeaders,
          }
        )
      }

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
        data: { user },
        error:
          userError,
      } =
        await admin.auth
          .getUser(token)

      if (
        userError ||
        !user
      ) {
        return Response.json(
          {
            error:
              'Invalid session.',
          },
          {
            status: 401,
            headers:
              corsHeaders,
          }
        )
      }

      const body =
        await request
          .json()
          .catch(
            () => ({})
          )

      const days =
        Math.max(
          1,
          Math.min(
            Number(
              body?.days ??
              30
            ),
            365
          )
        )

      const end =
        new Date()

      const start =
        new Date(
          end.getTime() -
            days *
              86400000
        )

      const {
        data: summary,
        error:
          summaryError,
      } =
        await admin.rpc(
          'build_report_summary',
          {
            target_user_id:
              user.id,

            start_at:
              start.toISOString(),

            end_at:
              end.toISOString(),
          }
        )

      if (summaryError) {
        throw summaryError
      }

      const {
        data: report,
        error:
          reportError,
      } =
        await admin
          .from('reports')
          .insert({
            user_id:
              user.id,

            name:
              `${days}-day health report`,

            period_start:
              start.toISOString(),

            period_end:
              end.toISOString(),

            summary,
          })
          .select('*')
          .single()

      if (reportError) {
        throw reportError
      }

      return Response.json(
        report,
        {
          headers:
            corsHeaders,
        }
      )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : (
              error &&
              typeof error ===
                'object' &&
              'message' in error
            )
            ? String(
                error.message
              )
            : 'Report failed.'

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
