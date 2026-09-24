import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from '@supabase/supabase-js'

import { supabase } from './supabase'

export type ScanResult = {
  ok: boolean
  plan?: string
  scannedPages?: number
  discovered?: number
  health?: string
  error?: string
}

export async function scanWebsite(
  websiteId: string
): Promise<ScanResult> {
  const { data, error } =
    await supabase.functions.invoke(
      'monitor-site',
      {
        body: {
          websiteId,
          mode: 'scan',
        },
      }
    )

  if (error) {
    if (
      error instanceof FunctionsHttpError
    ) {
      const response =
        error.context as Response

      let message =
        `monitor-site returned HTTP ${response.status}`

      try {
        const body =
          await response
            .clone()
            .json()

        message =
          body?.error ??
          body?.message ??
          JSON.stringify(body)
      } catch {
        try {
          const text =
            await response.text()

          if (text) {
            message = text
          }
        } catch {
          // keep fallback message
        }
      }

      throw new Error(message)
    }

    if (
      error instanceof FunctionsRelayError
    ) {
      throw new Error(
        `Supabase relay error: ${error.message}`
      )
    }

    if (
      error instanceof FunctionsFetchError
    ) {
      throw new Error(
        `Could not reach monitor-site: ${error.message}`
      )
    }

    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data as ScanResult
}
