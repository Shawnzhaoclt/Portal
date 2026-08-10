import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = join(uiRoot, 'src')
const resourcesRoot = join(sourceRoot, 'resources')
const expectedWidth = 1600
const expectedHeight = 630
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

async function filesNamed(directory, fileName) {
  const entries = await readdir(directory, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) results.push(...await filesNamed(path, fileName))
    else if (entry.name === fileName) results.push(path)
  }
  return results
}

function displayPath(path) {
  return relative(uiRoot, path).split(sep).join('/')
}

async function validatePng(path, label, errors) {
  if (extname(path).toLocaleLowerCase() !== '.png') {
    errors.push(`${label} must be a PNG: ${displayPath(path)}`)
    return
  }
  let buffer
  try {
    buffer = await readFile(path)
  } catch {
    errors.push(`${label} was not found: ${displayPath(path)}`)
    return
  }
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    errors.push(`${label} is not a readable PNG: ${displayPath(path)}`)
    return
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width !== expectedWidth || height !== expectedHeight) {
    errors.push(`${label} must be ${expectedWidth}x${expectedHeight}, found ${width}x${height}: ${displayPath(path)}`)
  }
}

const errors = []
let validatedPairs = 0
for (const metadataPath of await filesNamed(resourcesRoot, 'resource.json')) {
  let resource
  try {
    resource = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch (error) {
    errors.push(`Invalid resource metadata ${displayPath(metadataPath)}: ${error.message}`)
    continue
  }
  const presentation = resource.presentation
  const requiresThumbnail = resource.is_active === true && resource.show_in_catalog === true
  if (!presentation && !requiresThumbnail) continue
  if (!presentation?.thumbnail_light || !presentation?.thumbnail_dark) {
    errors.push(`${resource.resource_slug ?? displayPath(metadataPath)} requires explicit light and dark thumbnails.`)
    continue
  }

  const expectedBase = String(resource.resource_slug ?? '').replaceAll('_', '-')
  const expectedLight = `assets/portal-thumbnails/${expectedBase}.png`
  const expectedDark = `assets/portal-thumbnails/${expectedBase}-dark.png`
  if (presentation.thumbnail_light !== expectedLight || presentation.thumbnail_dark !== expectedDark) {
    errors.push(`${resource.resource_slug} thumbnail paths must be ${expectedLight} and ${expectedDark}.`)
  }

  await validatePng(resolve(sourceRoot, presentation.thumbnail_light), `${resource.resource_slug} light thumbnail`, errors)
  await validatePng(resolve(sourceRoot, presentation.thumbnail_dark), `${resource.resource_slug} dark thumbnail`, errors)
  validatedPairs += 1
}

if (errors.length) {
  throw new Error(`Resource thumbnail validation failed:\n- ${errors.join('\n- ')}`)
}

process.stdout.write(`Validated ${validatedPairs} resource thumbnail pairs at ${expectedWidth}x${expectedHeight}.\n`)
