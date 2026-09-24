import { initializePaddle, type Paddle } from '@paddle/paddle-js'

let paddle: Paddle | undefined

export async function getPaddle() {
  if (paddle) return paddle

  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN

  if (!token) {
    throw new Error('Missing Paddle client-side token')
  }

  paddle = await initializePaddle({
    token,
  })

  if (!paddle) {
    throw new Error('Could not initialize Paddle')
  }

  return paddle
}
