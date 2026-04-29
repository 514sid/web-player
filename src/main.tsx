import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if ("serviceWorker" in navigator) {
  // Register relative to the app's base URL so the SW scope covers the app.
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
