const CACHE_NAME = "file-cache";

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  size: number;
  addedAt: number;
  duration: number;     // editable signage playback duration (ms)
  mediaDuration?: number; // original video length (ms), read-only
}

const DEFAULT_DURATION = 10_000;

const fileUrl  = (id: string) => `/_files/${id}`;
export const fileStreamUrl = (id: string) => `/_files/${id}`;
const thumbUrl = (id: string) => `/_thumbs/${id}`;
const ORDER_URL      = "/_order";
const DURATIONS_URL  = "/_durations";

// --- Thumbnail generation ---

function generateImageThumbnail(file: File): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const SIZE = 120;
      const ratio = Math.min(SIZE / img.naturalWidth, SIZE / img.naturalHeight, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.naturalWidth * ratio);
      canvas.height = Math.round(img.naturalHeight * ratio);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

interface VideoResult { blob: Blob | null; duration: number | null; }

function generateVideoThumbnail(file: File): Promise<VideoResult> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let done = false;
    let nativeDuration: number | null = null;

    video.onloadedmetadata = () => {
      nativeDuration = isFinite(video.duration) ? video.duration * 1000 : null;
      video.currentTime = Math.min(0.5, video.duration * 0.1);
    };
    video.onseeked = () => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      if (!video.videoWidth || !video.videoHeight) return resolve({ blob: null, duration: nativeDuration });
      const SIZE = 120;
      const ratio = Math.min(SIZE / video.videoWidth, SIZE / video.videoHeight, 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * ratio);
      canvas.height = Math.round(video.videoHeight * ratio);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => resolve({ blob: b, duration: nativeDuration }), "image/jpeg", 0.8);
    };
    video.onerror = () => { URL.revokeObjectURL(url); resolve({ blob: null, duration: null }); };
    video.src = url;
  });
}

async function generateThumbnail(file: File): Promise<{ blob: Blob | null; duration: number | null }> {
  if (file.type.startsWith("image/")) return { blob: await generateImageThumbnail(file), duration: null };
  if (file.type.startsWith("video/")) return generateVideoThumbnail(file);
  return { blob: null, duration: null };
}

// --- Durations ---

async function readDurations(): Promise<Record<string, number>> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(DURATIONS_URL);
  if (!res) return {};
  return res.json();
}

async function writeDurations(map: Record<string, number>): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    DURATIONS_URL,
    new Response(JSON.stringify(map), { headers: { "content-type": "application/json" } })
  );
}

export async function setDuration(id: string, seconds: number): Promise<void> {
  const map = await readDurations();
  await writeDurations({ ...map, [id]: seconds });
}

// --- Order ---

async function readOrder(): Promise<string[]> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(ORDER_URL);
  if (!res) return [];
  return res.json();
}

async function writeOrder(ids: string[]): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(
    ORDER_URL,
    new Response(JSON.stringify(ids), { headers: { "content-type": "application/json" } })
  );
}

export async function setOrder(ids: string[]): Promise<void> {
  await writeOrder(ids);
}

// --- File operations ---

export async function saveFile(file: File): Promise<StoredFile> {
  const cache = await caches.open(CACHE_NAME);
  const id = crypto.randomUUID();
  const meta: StoredFile = {
    id,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: Date.now(),
    duration: DEFAULT_DURATION,
  };

  const { blob: thumb, duration: videoDuration } = await generateThumbnail(file);
  if (thumb) {
    await cache.put(thumbUrl(id), new Response(thumb, { headers: { "content-type": "image/jpeg" } }));
  }

  const fileDuration = videoDuration != null ? Math.round(videoDuration) : DEFAULT_DURATION; // ms
  meta.duration = fileDuration;
  if (videoDuration != null) meta.mediaDuration = fileDuration;

  const headers: Record<string, string> = {
    "content-type": meta.type,
    "x-name": encodeURIComponent(meta.name),
    "x-size": String(meta.size),
    "x-added-at": String(meta.addedAt),
  };
  if (videoDuration != null) headers["x-media-duration"] = String(fileDuration);

  await cache.put(fileUrl(id), new Response(file, { headers }));

  const [order, durations] = await Promise.all([readOrder(), readDurations()]);
  await Promise.all([
    writeOrder([...order, id]),
    writeDurations({ ...durations, [id]: fileDuration }),
  ]);

  return meta;
}

export async function listFiles(): Promise<StoredFile[]> {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const entries: StoredFile[] = [];

  for (const req of keys) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/_files/")) continue;
    const res = await cache.match(req);
    if (!res) continue;
    const id = url.pathname.replace("/_files/", "");
    const rawMediaDuration = res.headers.get("x-media-duration");
    entries.push({
      id,
      name: decodeURIComponent(res.headers.get("x-name") ?? "unknown"),
      type: res.headers.get("content-type") ?? "",
      size: Number(res.headers.get("x-size") ?? 0),
      addedAt: Number(res.headers.get("x-added-at") ?? 0),
      duration: DEFAULT_DURATION, // overwritten below from durations store
      ...(rawMediaDuration != null && { mediaDuration: Number(rawMediaDuration) }),
    });
  }

  const [order, durations] = await Promise.all([readOrder(), readDurations()]);
  for (const entry of entries) {
    if (entry.id in durations) entry.duration = durations[entry.id];
  }
  if (order.length > 0) {
    entries.sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  return entries;
}

export async function getFileBlob(id: string): Promise<Blob | null> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(fileUrl(id));
  return res ? res.blob() : null;
}

export async function getThumbnailBlob(id: string): Promise<Blob | null> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(thumbUrl(id));
  return res ? res.blob() : null;
}

export async function deleteFile(id: string): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all([cache.delete(fileUrl(id)), cache.delete(thumbUrl(id))]);
  const [order, durations] = await Promise.all([readOrder(), readDurations()]);
  const { [id]: _, ...restDurations } = durations;
  await Promise.all([
    writeOrder(order.filter((i) => i !== id)),
    writeDurations(restDurations),
  ]);
}
