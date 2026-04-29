import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DndProvider, useDrag, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  deleteFile, getFileBlob, getThumbnailBlob,
  listFiles, saveFile, setDuration, setOrder, type StoredFile,
} from "../db";

type FileEntry = Omit<StoredFile, "data">;

const DRAG_TYPE = "SORTABLE_FILE";

interface StorageInfo {
  quota: number;
  usage: number;
  cacheUsage: number | null;
}

function formatDuration(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function FileIcon({ type }: { type: string }) {
  if (type.startsWith("video/")) return <>&#127916;</>;
  if (type.startsWith("image/")) return <>&#128444;&#65039;</>;
  if (type.startsWith("audio/")) return <>&#127925;</>;
  return <>&#128196;</>;
}

function DragHandle() {
  return (
    <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" className="text-gray-600 shrink-0">
      <circle cx="3.5" cy="3"  r="1.4" /><circle cx="8.5" cy="3"  r="1.4" />
      <circle cx="3.5" cy="8"  r="1.4" /><circle cx="8.5" cy="8"  r="1.4" />
      <circle cx="3.5" cy="13" r="1.4" /><circle cx="8.5" cy="13" r="1.4" />
    </svg>
  );
}

// --- Preview modal ---

function PreviewModal({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    getFileBlob(file.id).then((blob) => {
      if (blob) { url = URL.createObjectURL(blob); setBlobUrl(url); }
    });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="relative max-w-4xl w-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between w-full">
          <p className="text-white text-sm font-medium truncate pr-4">{file.name}</p>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none cursor-pointer shrink-0">✕</button>
        </div>
        <div className="w-full flex items-center justify-center bg-gray-900 rounded-lg overflow-hidden min-h-32">
          {!blobUrl && (
            <svg className="animate-spin h-6 w-6 text-gray-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          )}
          {blobUrl && file.type.startsWith("image/") && <img src={blobUrl} alt={file.name} className="max-w-full max-h-[80vh] object-contain" />}
          {blobUrl && file.type.startsWith("video/") && <video src={blobUrl} controls autoPlay className="max-w-full max-h-[80vh]" />}
          {blobUrl && file.type.startsWith("audio/") && <audio src={blobUrl} controls autoPlay className="w-full m-6" />}
          {blobUrl && !file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/") && (
            <p className="text-gray-400 text-sm p-6">No preview available</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Confirm delete modal ---

function ConfirmModal({ fileName, onConfirm, onCancel }: { fileName: string; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-gray-800 rounded-xl p-6 w-full max-w-sm flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <p className="text-white text-sm">Delete <span className="font-medium break-all">{fileName}</span>?</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-gray-300 hover:text-white rounded hover:bg-gray-700 transition-colors cursor-pointer">Cancel</button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors cursor-pointer">Delete</button>
        </div>
      </div>
    </div>
  );
}

// --- Sortable list item ---

interface SortableItemProps {
  file: FileEntry;
  index: number;
  thumbnail?: string;
  onMove: (from: number, to: number) => void;
  onDragEnd: () => void;
  onPreview: (file: FileEntry) => void;
  onDelete: (id: string) => void;
  onDurationChange: (id: string, seconds: number) => void;
}

function SortableItem({ file, index, thumbnail, onMove, onDragEnd, onPreview, onDelete, onDurationChange }: SortableItemProps) {
  const ref = useRef<HTMLLIElement>(null);
  const [durationInput, setDurationInput] = useState(String(file.duration));

  const [{ isDragging }, drag, preview] = useDrag({
    type: DRAG_TYPE,
    item: { index },
    collect: (m) => ({ isDragging: m.isDragging() }),
    end: onDragEnd,
  });

  const [, drop] = useDrop<{ index: number }>({
    accept: DRAG_TYPE,
    hover(item) {
      if (item.index === index) return;
      onMove(item.index, index);
      item.index = index;
    },
  });

  drop(preview(ref));

  return (
    <li
      ref={ref}
      className="flex items-center gap-3 bg-gray-800/60 rounded-lg px-3 py-2 transition-opacity"
      style={{ opacity: isDragging ? 0.35 : 1 }}
    >
      <span ref={(node) => { drag(node); }} className="cursor-grab active:cursor-grabbing p-1 -ml-1">
        <DragHandle />
      </span>
      <div
        className="w-12 h-12 rounded overflow-hidden bg-gray-700 flex items-center justify-center shrink-0 cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all"
        onClick={() => onPreview(file)}
      >
        {thumbnail
          ? <img src={thumbnail} alt="" className="w-full h-full object-cover" />
          : <span className="text-lg"><FileIcon type={file.type} /></span>}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm truncate">{file.name}</p>
        <p className="text-gray-500 text-xs">
          {formatBytes(file.size)}
          {file.mediaDuration != null && <span className="ml-1.5">{formatDuration(file.mediaDuration)}</span>}
        </p>
      </div>
      <label className="flex items-center gap-1 shrink-0">
        <input
          type="number"
          min={1}
          value={durationInput}
          onChange={(e) => setDurationInput(e.target.value)}
          onBlur={() => {
            const ms = Math.max(1, Math.round(Number(durationInput)));
            setDurationInput(String(ms));
            onDurationChange(file.id, ms);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-14 bg-gray-700 text-white text-xs text-center rounded px-1 py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-gray-500 text-xs">ms</span>
      </label>
      <button
        onClick={() => onDelete(file.id)}
        className="text-gray-400 hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors cursor-pointer"
      >
        Delete
      </button>
    </li>
  );
}

// --- Manage page ---

export default function ManagePage() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fetchedRef = useRef<Set<string>>(new Set());
  const filesRef = useRef<FileEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  filesRef.current = files;

  // Escape → back to player; Ctrl+U → trigger file input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !previewFile && !confirmDeleteId) navigate("/");
      if (e.ctrlKey && e.key === "u") { e.preventDefault(); inputRef.current?.click(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, previewFile, confirmDeleteId]);

  const refreshStorage = useCallback(async () => {
    const est = await navigator.storage.estimate();
    setStorage({
      quota: est.quota ?? 0,
      usage: est.usage ?? 0,
      cacheUsage: (est as { usageDetails?: { caches?: number } }).usageDetails?.caches ?? null,
    });
  }, []);

  const reload = useCallback(async () => {
    setFiles(await listFiles());
    await refreshStorage();
    setLoading(false);
  }, [refreshStorage]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    for (const f of files) {
      if (fetchedRef.current.has(f.id)) continue;
      fetchedRef.current.add(f.id);
      getThumbnailBlob(f.id).then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        setThumbnails((prev) => ({ ...prev, [f.id]: url }));
      });
    }
  }, [files]);

  useEffect(() => {
    return () => {
      setThumbnails((prev) => { Object.values(prev).forEach(URL.revokeObjectURL); return {}; });
    };
  }, []);

  const moveFile = useCallback((from: number, to: number) => {
    setFiles((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const handleDurationChange = useCallback((id: string, seconds: number) => {
    setDuration(id, seconds);
    setFiles((prev) => prev.map((f) => f.id === id ? { ...f, duration: seconds } : f));
  }, []);

  const handleDragEnd = useCallback(() => {
    setOrder(filesRef.current.map((f) => f.id));
    refreshStorage();
  }, [refreshStorage]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    for (const file of Array.from(fileList)) await saveFile(file);
    await reload();
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleDelete(id: string) {
    await deleteFile(id);
    setThumbnails((prev) => {
      if (prev[id]) URL.revokeObjectURL(prev[id]);
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    fetchedRef.current.delete(id);
    if (previewFile?.id === id) setPreviewFile(null);
    await reload();
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-white">File Cache</h1>
          <button
            onClick={() => navigate("/")}
            className="text-gray-400 hover:text-white text-xs px-3 py-1.5 rounded hover:bg-gray-700 transition-colors cursor-pointer"
          >
            ← Player
          </button>
        </div>

        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors mb-6 ${
            dragOver ? "border-blue-400 bg-blue-950/30" : "border-gray-600 hover:border-gray-400"
          }`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        >
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          <p className="text-gray-400 text-sm">{uploading ? "Saving…" : "Drop files here or click to upload"}</p>
          <p className="text-gray-600 text-xs mt-1">
            Images, videos, audio, documents — any size
            <span className="ml-2 opacity-50">· Ctrl+U</span>
          </p>
        </div>

        {storage && (
          <div className="mb-6 bg-gray-800/60 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-2">
            <div className="flex justify-between">
              <span>App cache <span className="text-white font-medium">{formatBytes(storage.cacheUsage ?? storage.usage)}</span></span>
              <span>Free <span className="text-white font-medium">{formatBytes(Math.max(0, storage.quota - storage.usage))}</span> of {formatBytes(storage.quota)}</span>
            </div>
            <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${Math.min(100, (storage.usage / storage.quota) * 100).toFixed(2)}%` }}
              />
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <svg className="animate-spin h-6 w-6 text-gray-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
          </div>
        ) : files.length === 0 ? (
          <p className="text-gray-500 text-center text-sm">No cached files yet.</p>
        ) : (
          <ul className="space-y-2">
            {files.map((f, index) => (
              <SortableItem
                key={f.id}
                file={f}
                index={index}
                thumbnail={thumbnails[f.id]}
                onMove={moveFile}
                onDragEnd={handleDragEnd}
                onPreview={setPreviewFile}
                onDelete={setConfirmDeleteId}
                onDurationChange={handleDurationChange}
              />
            ))}
          </ul>
        )}
      </div>

      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

      {confirmDeleteId && (() => {
        const file = files.find((f) => f.id === confirmDeleteId);
        return file ? (
          <ConfirmModal
            fileName={file.name}
            onConfirm={() => { setConfirmDeleteId(null); handleDelete(confirmDeleteId); }}
            onCancel={() => setConfirmDeleteId(null)}
          />
        ) : null;
      })()}
    </DndProvider>
  );
}
