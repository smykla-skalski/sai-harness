export function fileUri(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${absolute
    .split('/')
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')}`;
}

export const MAX_CLIPBOARD_FILE_SIZE = 20 * 1024 * 1024;

export function clipboardFiles(event: {
  clipboardData?: { files: FileList | File[] } | null;
}): File[] {
  return Array.from(event.clipboardData?.files ?? []);
}

export function insertClipboardText(
  value: string,
  text: string,
  start: number,
  end: number,
): string {
  return `${value.slice(0, start)}${text}${value.slice(end)}`;
}

export async function stageClipboardFile(file: File): Promise<string> {
  if (!file.size || file.size > MAX_CLIPBOARD_FILE_SIZE)
    throw new Error(`Clipboard files must be between 1 byte and 20 MiB: ${file.name}`);
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('clipboard_save_file', {
    name: file.name || 'clipboard-image.png',
    bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
  });
}

export async function removeClipboardFile(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('clipboard_remove_file', { path });
}

export async function stageClipboardImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process clipboard image');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('Could not encode image'))),
        'image/png',
      ),
    );
    if (blob.size > 4 * 1024 * 1024) throw new Error('Clipboard image exceeds 4 MiB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('browser_save_capture', { png: btoa(binary) });
  } finally {
    bitmap.close();
  }
}
