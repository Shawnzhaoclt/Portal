import { useMemo, useState } from 'react'
import { Copy, ExternalLink, Link2, PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DASHBOARD_CATALOG,
  dashboardEmbedUrl,
  dashboardUrl,
  type DashboardCatalogItem,
} from './dashboardCatalog'
import './DashboardLinksPage.css'

function iframeSnippet(item: DashboardCatalogItem) {
  return `<iframe src="${dashboardEmbedUrl(item.path)}" width="100%" height="900" style="border:0;" loading="lazy" title="${item.title}"></iframe>`
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export default function DashboardLinksPage() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const origin = useMemo(() => (typeof window === 'undefined' ? '' : window.location.origin), [])

  async function handleCopy(key: string, value: string) {
    await copyText(value)
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1600)
  }

  return (
    <main className="dashboard-links-page">
      <section className="dashboard-links-hero">
        <div className="dashboard-links-icon">
          <PanelsTopLeft size={30} />
        </div>
        <div>
          <span>Dashboard Integration</span>
          <h1>Portal Dashboard Links</h1>
          <p>Use these stable URLs for SharePoint, internal portals, and other web applications.</p>
        </div>
      </section>

      <section className="dashboard-links-note">
        <strong>Current host</strong>
        <span>{origin}</span>
      </section>

      <section className="dashboard-link-grid">
        {DASHBOARD_CATALOG.map((item) => {
          const directUrl = dashboardUrl(item.path)
          const embedUrl = dashboardEmbedUrl(item.path)
          const iframe = iframeSnippet(item)

          return (
            <article className="dashboard-link-card" key={item.id}>
              <div className="dashboard-link-card-header">
                <div>
                  <span>{item.category}</span>
                  <h2>{item.title}</h2>
                </div>
                <a href={directUrl} rel="noreferrer" target="_blank" title={`Open ${item.title}`}>
                  <ExternalLink size={18} />
                </a>
              </div>
              <p>{item.description}</p>

              <div className="dashboard-link-field">
                <label>Direct link</label>
                <code>{directUrl}</code>
              </div>

              <div className="dashboard-link-actions">
                <Button onClick={() => handleCopy(`${item.id}-link`, directUrl)} type="button" variant="outline">
                  <Link2 size={17} />
                  {copiedKey === `${item.id}-link` ? 'Copied' : 'Copy link'}
                </Button>
                <Button onClick={() => handleCopy(`${item.id}-embed`, embedUrl)} type="button" variant="outline">
                  <Copy size={17} />
                  {copiedKey === `${item.id}-embed` ? 'Copied' : 'Copy embed URL'}
                </Button>
                <Button onClick={() => handleCopy(`${item.id}-iframe`, iframe)} type="button" variant="outline">
                  <Copy size={17} />
                  {copiedKey === `${item.id}-iframe` ? 'Copied' : 'Copy iframe'}
                </Button>
              </div>
            </article>
          )
        })}
      </section>
    </main>
  )
}
