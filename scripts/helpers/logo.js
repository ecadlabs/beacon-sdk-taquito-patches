'use strict'

const MIME_TYPES = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp'
}

function createDataUri(buffer, extension) {
  const normalizedExtension = extension.replace(/^\./, '').toLowerCase()
  const mimeType = MIME_TYPES[normalizedExtension]

  if (!mimeType) {
    throw new Error(`Unsupported logo format: ${extension}`)
  }

  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

module.exports = {
  createDataUri
}
