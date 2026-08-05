"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Photo = {
  id: string;
  altText: string | null;
  status: string;
  url: string | null;
};

const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp";
const MAX_BYTES = 15 * 1024 * 1024;
const POLL_INTERVAL_MS = 900;
const MAX_POLLS = 8;

type UploadState =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "uploading" }
  | { phase: "completing" }
  | { phase: "processing"; id: string; polls: number }
  | { phase: "error"; code: string };

export function PhotoManager(props: {
  memorialId: string;
  initial: Photo[];
}) {
  const t = useTranslations("memorial");
  const errors = useTranslations("errors");
  const common = useTranslations("common");
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [photos, setPhotos] = useState<Photo[]>(props.initial);
  const [upload, setUpload] = useState<UploadState>({ phase: "idle" });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function readError(payload: unknown): string {
    const error = (payload as { error?: { code?: string } })?.error;
    return error?.code ?? "unexpected";
  }

  async function pollStatus(id: string, remaining: number): Promise<void> {
    if (remaining <= 0) {
      setUpload({ phase: "idle" });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const response = await fetch(`/api/media/${id}`);
      if (!response.ok) {
        setUpload({ phase: "error", code: "uploadFailed" });
        return;
      }

      const body = await response.json();
      const status = body.data?.status;

      if (status === "ready") {
        setPhotos((current) =>
          current.map((photo) =>
            photo.id === id
              ? { ...photo, status: "ready", url: body.data.url }
              : photo,
          ),
        );
        setUpload({ phase: "idle" });
        router.refresh();
        return;
      }

      if (status === "rejected") {
        setPhotos((current) => current.filter((photo) => photo.id !== id));
        setUpload({ phase: "error", code: "imageRejected" });
        return;
      }

      // Still processing — keep polling.
      setUpload({ phase: "processing", id, polls: MAX_POLLS - remaining + 1 });
      await pollStatus(id, remaining - 1);
    } catch {
      setUpload({ phase: "error", code: "uploadFailed" });
    }
  }

  async function handleFile(file: File): Promise<void> {
    if (file.size > MAX_BYTES) {
      setUpload({ phase: "error", code: "imageTooLarge" });
      return;
    }

    if (file.size === 0) {
      setUpload({ phase: "error", code: "imageEmpty" });
      return;
    }

    // 1. Sign
    setUpload({ phase: "signing" });
    try {
      const signResponse = await fetch("/api/media/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          memorialId: props.memorialId,
          fileName: file.name,
          contentType: file.type,
          size: file.size,
        }),
      });

      if (!signResponse.ok) {
        const payload = await signResponse.json().catch(() => null);
        setUpload({ phase: "error", code: readError(payload) });
        return;
      }

      const signData = (await signResponse.json()).data;

      // 2. Upload to storage
      setUpload({ phase: "uploading" });
      const putResponse = await fetch(signData.url, {
        method: "PUT",
        headers: signData.headers,
        body: file,
      });

      if (!putResponse.ok) {
        setUpload({ phase: "error", code: "uploadFailed" });
        return;
      }

      // 3. Mark complete
      setUpload({ phase: "completing" });
      const completeResponse = await fetch(
        `/api/media/${signData.mediaAssetId}/complete`,
        { method: "POST" },
      );

      if (!completeResponse.ok) {
        const payload = await completeResponse.json().catch(() => null);
        setUpload({ phase: "error", code: readError(payload) });
        return;
      }

      // Add an optimistic "scanning" card.
      const optimisticPhoto: Photo = {
        id: signData.mediaAssetId,
        altText: null,
        status: "scanning",
        url: null,
      };
      setPhotos((current) => [optimisticPhoto, ...current]);

      // 4. Poll for ready
      setUpload({
        phase: "processing",
        id: signData.mediaAssetId,
        polls: 0,
      });
      await pollStatus(signData.mediaAssetId, MAX_POLLS);
    } catch {
      setUpload({ phase: "error", code: "uploadFailed" });
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setDeletingId(id);
    try {
      const response = await fetch(`/api/media/${id}`, { method: "DELETE" });
      if (response.ok) {
        setPhotos((current) => current.filter((photo) => photo.id !== id));
        router.refresh();
      }
    } catch {
      // Silently fail — the photo remains in the list for a retry.
    } finally {
      setDeletingId(null);
    }
  }

  const busy =
    upload.phase !== "idle" && upload.phase !== "error";

  return (
    <section className="stack measure">
      <h2>{t("photosHeading")}</h2>
      <p className="muted">{t("photosHelp")}</p>

      {upload.phase === "error" ? (
        <p className="fieldError" role="alert">
          {errors.has(upload.code) ? errors(upload.code) : t.has(upload.code) ? t(upload.code) : errors("unexpected")}
        </p>
      ) : null}

      <div>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_TYPES}
          className="visuallyHidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              handleFile(file);
            }
            // Reset so the same file can be re-selected.
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="button buttonPrimary"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? common("loading") : t("addPhoto")}
        </button>
      </div>

      {photos.length === 0 ? (
        <p className="muted">{t("photosNone")}</p>
      ) : (
        <div className="photoGrid">
          {photos.map((photo) => (
            <div className="photoTile" key={photo.id}>
              {photo.status === "ready" && photo.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="photoThumb"
                  src={photo.url}
                  alt={photo.altText ?? t("photoAltFallback")}
                  loading="lazy"
                />
              ) : (
                <div className="photoPlaceholder">
                  <span className="muted">
                    {photo.status === "rejected"
                      ? t("photoRejected")
                      : t("photoProcessing")}
                  </span>
                </div>
              )}
              <button
                type="button"
                className="button buttonQuiet"
                disabled={deletingId === photo.id}
                onClick={() => handleDelete(photo.id)}
              >
                {deletingId === photo.id ? common("loading") : t("removePhoto")}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
