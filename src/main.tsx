import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { ConditionalPostHogProvider } from './components/ConditionalPostHogProvider'
import { PostHogAppTracker } from './components/PostHogAppTracker'
import { initObservability } from './lib/observability'
import { isElectron, isNotificationWindow } from './lib/runtime'
import { bootNative, isNativePlatform } from './lib/native'
import './styles/globals.css'

if (isElectron) document.body.classList.add('electron')
if (isNativePlatform()) document.body.classList.add('native', `native-${typeof window !== 'undefined' && (window as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || ''}`)

void initObservability()
void bootNative()

// Browser-only: Chrome/Android/desktop installability. Skip Electron,
// Capacitor WebViews, and the notification panel — those shells already
// own their own lifecycle, and a SW must not intercept `/ws`.
if (!isElectron && !isNativePlatform() && !isNotificationWindow) {
  registerSW({ immediate: true })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConditionalPostHogProvider>
      <PostHogAppTracker />
      <App />
    </ConditionalPostHogProvider>
  </StrictMode>,
)
