import { portalRequestBinary } from '../desktop/request'
import { isDesktopRuntime, saveAndOpenExcelExport } from '../desktop/runtime'

type DownloadOptions = {
  openInExcel?: boolean
}

function responseFileName(headers: Record<string, string>, fallback: string) {
  const disposition = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-disposition')?.[1] ?? ''
  return disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    ? decodeURIComponent(disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? fallback)
    : disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallback
}

export async function downloadBytes(bytes: BlobPart, mediaType: string, fileName: string, options: DownloadOptions = {}) {
  const blob = new Blob([bytes], { type: mediaType })
  if (options.openInExcel && isDesktopRuntime()) {
    return saveAndOpenExcelExport(fileName, new Uint8Array(await blob.arrayBuffer()))
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // WebView2 needs the object URL to remain alive until it accepts the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  return fileName
}

export async function downloadPortalFile(path: string, fallbackFileName: string) {
  const response = await portalRequestBinary(path)
  const fileName = responseFileName(response.headers, fallbackFileName)
  const openInExcel = fileName.toLowerCase().endsWith('.xlsx') || response.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  return downloadBytes(response.bytes, response.mediaType, fileName, { openInExcel })
}
