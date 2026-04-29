import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fileStreamUrl, getFileBlob, listFiles, type StoredFile } from "../db";

interface Slot {
  file: StoredFile | null;
  url: string | null;
}

const EMPTY_SLOT: Slot = { file: null, url: null };

async function resolveUrl(file: StoredFile): Promise<string | null> {
  if (file.type.startsWith("image/")) {
    const blob = await getFileBlob(file.id);
    return blob ? URL.createObjectURL(blob) : null;
  }
  // Stream videos via SW — but fall back to a blob URL when the SW is
  // bypassed (e.g. hard refresh with Ctrl+Shift+R), otherwise the request
  // returns 404 and the video never plays.
  if (file.type.startsWith("video/") && navigator.serviceWorker?.controller) {
    return fileStreamUrl(file.id);
  }
  const blob = await getFileBlob(file.id);
  return blob ? URL.createObjectURL(blob) : null;
}

// Revoke only blob: URLs; SW stream paths don't need cleanup.
function releaseUrl(slot: Slot) {
  if (slot.url?.startsWith("blob:")) URL.revokeObjectURL(slot.url);
}

export default function PlayerPage() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<0 | 1>(0);
  const [slots, setSlots] = useState<[Slot, Slot]>([EMPTY_SLOT, EMPTY_SLOT]);

  const filesRef     = useRef<StoredFile[]>([]);
  const indexRef     = useRef(0);
  const activeRef    = useRef<0 | 1>(0);
  const slotsRef     = useRef<[Slot, Slot]>([EMPTY_SLOT, EMPTY_SLOT]);
  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoRefs    = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  filesRef.current  = files;
  activeRef.current = active;
  slotsRef.current  = slots;

  // Ctrl+M → manage
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "m") navigate("/manage");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    listFiles().then((f) => { setFiles(f); setLoading(false); });
  }, []);

  const advance = useCallback(() => {
    const allFiles = filesRef.current;
    if (!allFiles.length) return;

    const curActive  = activeRef.current;
    const curIndex   = indexRef.current;
    const nextActive = (1 - curActive) as 0 | 1;
    const nextIndex  = (curIndex + 1) % allFiles.length;
    const preloadIdx = (nextIndex + 1) % allFiles.length;

    // Free image blob URL for the slot we're leaving
    releaseUrl(slotsRef.current[curActive]);

    indexRef.current = nextIndex;
    setActive(nextActive);

    // Load the slot-after-next into the now-hidden slot
    resolveUrl(allFiles[preloadIdx]).then((url) => {
      setSlots((prev) => {
        const next: [Slot, Slot] = [{ ...prev[0] }, { ...prev[1] }];
        next[curActive] = { file: allFiles[preloadIdx], url };
        return next;
      });
    });

    timerRef.current = setTimeout(advance, allFiles[nextIndex].duration);
  }, []);

  // Bootstrap: load slot 0 (current) and slot 1 (preloaded next)
  useEffect(() => {
    if (!files.length) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    indexRef.current = 0;

    containerRef.current?.requestFullscreen().catch(() => {});

    resolveUrl(files[0]).then((url) => {
      setSlots((prev) => {
        const next: [Slot, Slot] = [{ ...prev[0] }, { ...prev[1] }];
        next[0] = { file: files[0], url };
        return next;
      });
      timerRef.current = setTimeout(advance, files[0].duration);
    });

    const preloadIdx = files.length > 1 ? 1 : 0;
    resolveUrl(files[preloadIdx]).then((url) => {
      setSlots((prev) => {
        const next: [Slot, Slot] = [{ ...prev[0] }, { ...prev[1] }];
        next[1] = { file: files[preloadIdx], url };
        return next;
      });
    });
  }, [files, advance]);

  // Play active video, pause+reset inactive.
  // Also fires when activeSlotUrl changes so the first video (active=0 from the start) starts playing.
  const activeSlotUrl = slots[active].url;
  useEffect(() => {
    videoRefs.current.forEach((video, i) => {
      if (!video) return;
      if (i === active) {
        video.currentTime = 0;
        video.play().catch(() => {});
      } else {
        video.pause();
        video.currentTime = 0;
      }
    });
  }, [active, activeSlotUrl]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      slotsRef.current.forEach(releaseUrl);
    };
  }, []);

  if (loading) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <svg className="animate-spin h-8 w-8 text-gray-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
      </div>
    );
  }

  if (!files.length) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <p className="text-gray-500 text-sm">
          No files cached. Press <kbd className="bg-gray-800 px-1 rounded">Ctrl+M</kbd> to manage files.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-screen h-screen bg-black relative overflow-hidden cursor-none">
      {([0, 1] as const).map((slotIdx) => {
        const slot = slots[slotIdx];
        if (!slot.url || !slot.file) return null;
        const isActive = slotIdx === active;

        return (
          <div
            key={slotIdx}
            className="absolute inset-0"
            style={{ visibility: isActive ? "visible" : "hidden", zIndex: isActive ? 1 : 0 }}
          >
            {slot.file.type.startsWith("image/") && (
              <img src={slot.url} alt="" className="w-full h-full object-contain" />
            )}
            {slot.file.type.startsWith("video/") && (
              <video
                ref={(el) => { videoRefs.current[slotIdx] = el; }}
                src={slot.url}
                muted
                playsInline
                loop
                preload="auto"
                className="w-full h-full object-contain"
              />
            )}
            {!slot.file.type.startsWith("image/") && !slot.file.type.startsWith("video/") && (
              <div className="w-full h-full flex items-center justify-center">
                <p className="text-white text-xl">{slot.file.name}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
