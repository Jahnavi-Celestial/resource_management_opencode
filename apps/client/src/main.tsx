import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { apolloClient } from '@/apollo/client'
import { AppProviders } from '@/AppProviders'
import { AppRoutes } from '@/AppRoutes'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('#root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    <AppProviders client={apolloClient}>
      <AppRoutes />
    </AppProviders>
  </StrictMode>,
)
