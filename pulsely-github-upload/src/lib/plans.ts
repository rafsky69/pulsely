export type PlanId =
  | 'free'
  | 'developer'
  | 'webmaster'
  | 'freelancer'
  | 'professional'
  | 'studio'
  | 'agency'
  | 'enterprise'

export type PlanDefinition = {
  name: string
  price: number
  priceId: string | null
  websites: number
  pages: number
  members: number
  uptimeSeconds: number
  scanMinutes: number
  humanReviewMonths: number
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    name: 'Free',
    price: 0,
    priceId: null,
    websites: 1,
    pages: 50,
    members: 1,
    uptimeSeconds: 3600,
    scanMinutes: 10080,
    humanReviewMonths: 12,
  },

  developer: {
    name: 'Developer',
    price: 9,
    priceId: 'pri_01m39091eb9xsa4zh0nazctfz0',
    websites: 5,
    pages: 500,
    members: 1,
    uptimeSeconds: 900,
    scanMinutes: 1440,
    humanReviewMonths: 12,
  },

  webmaster: {
    name: 'Webmaster',
    price: 19,
    priceId: 'pri_01m390b0j6xchb4br01cvfwbr9',
    websites: 15,
    pages: 2500,
    members: 1,
    uptimeSeconds: 300,
    scanMinutes: 720,
    humanReviewMonths: 12,
  },

  freelancer: {
    name: 'Freelancer',
    price: 39,
    priceId: 'pri_01m390d7vkba71srk1am89jatt',
    websites: 40,
    pages: 10000,
    members: 3,
    uptimeSeconds: 120,
    scanMinutes: 360,
    humanReviewMonths: 12,
  },

  professional: {
    name: 'Professional',
    price: 69,
    priceId: 'pri_01m390em8pagtx3v71b0ggqq9x',
    websites: 100,
    pages: 50000,
    members: 10,
    uptimeSeconds: 60,
    scanMinutes: 180,
    humanReviewMonths: 12,
  },

  studio: {
    name: 'Studio',
    price: 129,
    priceId: 'pri_01m390gjkn1xbg2qske123cjbm',
    websites: 250,
    pages: 150000,
    members: 25,
    uptimeSeconds: 60,
    scanMinutes: 60,
    humanReviewMonths: 12,
  },

  agency: {
    name: 'Agency',
    price: 249,
    priceId: 'pri_01m390hfape2sk447bzynmbzf3',
    websites: 750,
    pages: 500000,
    members: 75,
    uptimeSeconds: 30,
    scanMinutes: 30,
    humanReviewMonths: 12,
  },

  enterprise: {
    name: 'Enterprise',
    price: 499,
    priceId: 'pri_01m390k24chg028ze7xa5zq1rh',
    websites: 2000,
    pages: 2000000,
    members: Number.POSITIVE_INFINITY,
    uptimeSeconds: 15,
    scanMinutes: 15,
    humanReviewMonths: 12,
  },
}

export const PLAN_ORDER: PlanId[] = [
  'free',
  'developer',
  'webmaster',
  'freelancer',
  'professional',
  'studio',
  'agency',
  'enterprise',
]

export function limitLabel(value: number) {
  return Number.isFinite(value)
    ? value.toLocaleString()
    : 'Unlimited'
}

export function uptimeLabel(seconds: number) {
  if (seconds < 60) return `${seconds} sec`
  return `${seconds / 60} min`
}

export function scanLabel(minutes: number) {
  if (minutes === 10080) return 'Weekly'
  if (minutes === 1440) return 'Daily'
  if (minutes < 60) return `${minutes} min`
  return `${minutes / 60} hr`
}
