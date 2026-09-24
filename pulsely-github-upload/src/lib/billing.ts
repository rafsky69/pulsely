import { supabase } from './supabase'
import { getPaddle } from './paddle'
import { PLANS, type PlanId } from './plans'

export type SubscriptionView = {
  plan: PlanId
  billingPlan: PlanId
  adminOverridePlan: PlanId | null
  status: string
  paddleCustomerId: string | null
  paddleSubscriptionId: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  scheduledChangeAt: string | null
}

const ACTIVE_STATUSES = new Set([
  'active',
  'trialing',
  'past_due',
])

export async function getSubscription(): Promise<SubscriptionView> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.user) {
    throw new Error('You must be logged in.')
  }

  const { data, error } = await supabase
    .from('subscriptions')
    .select(`
      plan,
      admin_override_plan,
      status,
      paddle_customer_id,
      paddle_subscription_id,
      current_period_end,
      cancel_at_period_end,
      scheduled_change_at
    `)
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    return {
      plan: 'free',
      billingPlan: 'free',
      adminOverridePlan: null,
      status: 'free',
      paddleCustomerId: null,
      paddleSubscriptionId: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledChangeAt: null,
    }
  }

  const rawBillingPlan =
    (data.plan as PlanId | null) ?? 'free'

  const billingPlan =
    ACTIVE_STATUSES.has(data.status) ||
    data.status === 'admin_granted'
      ? rawBillingPlan
      : 'free'

  const adminOverridePlan =
    (data.admin_override_plan as PlanId | null) ?? null

  return {
    plan: adminOverridePlan ?? billingPlan,
    billingPlan,
    adminOverridePlan,
    status: data.status ?? 'free',
    paddleCustomerId: data.paddle_customer_id,
    paddleSubscriptionId: data.paddle_subscription_id,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
    scheduledChangeAt: data.scheduled_change_at ?? null,
  }
}

export async function openCheckout(planId: PlanId) {
  if (planId === 'free') {
    throw new Error('Free does not require checkout.')
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.user) {
    throw new Error('You must be logged in.')
  }

  const subscription = await getSubscription()

  if (subscription.adminOverridePlan) {
    throw new Error(
      'This account has an administrator plan override.'
    )
  }

  if (
    subscription.paddleSubscriptionId &&
    subscription.status !== 'canceled'
  ) {
    throw new Error(
      'You already have a Paddle subscription. Use Manage billing instead.'
    )
  }

  const plan = PLANS[planId]

  if (!plan.priceId) {
    throw new Error('Missing Paddle price ID.')
  }

  const paddle = await getPaddle()

  paddle.Checkout.open({
    items: [
      {
        priceId: plan.priceId,
        quantity: 1,
      },
    ],

    customer: session.user.email
      ? {
          email: session.user.email,
        }
      : undefined,

    customData: {
      user_id: session.user.id,
      requested_plan: planId,
    },

    settings: {
      displayMode: 'overlay',
      theme: 'light',
      locale: 'en',
    },
  })
}

export async function openBillingPortal(
  mode: 'overview' | 'cancel' = 'overview'
) {
  const { data, error } =
    await supabase.functions.invoke('billing-portal', {
      body: { mode },
    })

  if (error) throw error

  if (!data?.url) {
    throw new Error(
      'Paddle did not return a billing portal URL.'
    )
  }

  window.location.href = data.url
}
