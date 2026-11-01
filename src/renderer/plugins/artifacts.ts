export function artifactPreviewKind(mime: string): 'text' | 'image' | 'file' {
  const lower = mime.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (
    lower.startsWith('text/') ||
    lower === 'application/json' ||
    lower === 'application/javascript' ||
    lower === 'application/xml' ||
    lower.endsWith('+json') ||
    lower.endsWith('+xml')
  )
    return 'text';
  return 'file';
}
