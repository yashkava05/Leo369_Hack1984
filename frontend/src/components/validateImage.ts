export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_BYTES = 10 * 1024 * 1024

/** Returns an error message for a file the pipeline cannot take, or null when it is fine. */
export function validateImage(file: File): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || 'That file'} is not a PNG, JPEG or WebP image.`
  }
  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    return `${file.name || 'That image'} is ${mb} MB; the limit is 10 MB.`
  }
  return null
}
