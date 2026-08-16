"use client";

import { FileSearch, LockKeyhole, Upload } from "lucide-react";
import { useRef, useState } from "react";

export function UploadSurface({
  busyLabel,
  error,
  onUpload,
}: {
  busyLabel: string | null;
  error: string | null;
  onUpload: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const choose = (file: File | undefined) => {
    if (file) void onUpload(file);
  };

  return (
    <div className="upload-page">
      <div className="upload-intro">
        <div className="document-glyph" aria-hidden="true">
          <span>REF</span><i /><i /><i />
        </div>
        <p className="eyebrow">Start with the manuscript</p>
        <h2>See what the paper says—and whether its citations agree.</h2>
        <p>Upload a text-native research PDF. The original remains unchanged while every proposed edit waits for approval.</p>
      </div>
      <div
        className="upload-dropzone"
        data-dragging={dragging}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(event.dataTransfer.files[0]);
        }}
      >
        <input
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={Boolean(busyLabel)}
          id="paper-upload"
          onChange={(event) => choose(event.target.files?.[0])}
          ref={inputRef}
          type="file"
        />
        {busyLabel ? (
          <div className="upload-progress" aria-live="polite">
            <div className="scan-line" aria-hidden="true" />
            <FileSearch aria-hidden="true" size={26} />
            <strong>{busyLabel}</strong>
            <p>Layout → sections → markers → references → CSL-JSON</p>
          </div>
        ) : (
          <>
            <Upload aria-hidden="true" size={24} />
            <strong>Drop a research paper here</strong>
            <p>PDF · up to 20 MB · text-native papers work best</p>
            <button className="action-button" onClick={() => inputRef.current?.click()} type="button">
              Choose PDF
            </button>
          </>
        )}
      </div>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
      <div className="upload-footnote">
        <LockKeyhole aria-hidden="true" size={14} />
        <span>Files stay in the local assessment workspace. Paper text is not written to logs.</span>
      </div>
    </div>
  );
}
