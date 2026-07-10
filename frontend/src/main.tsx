import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import './index.css'
import AppRoutes from './AppRoutes'
import { applyAppTheme, getInitialTheme } from './theme'

applyAppTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoutes />
    <Toaster
      closeButton
      expand
      position="top-center"
      richColors
      toastOptions={{
        style: {
          borderRadius: 0,
          fontFamily: 'inherit',
        },
      }}
    />
  </StrictMode>,
)
