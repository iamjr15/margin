"use client";

import { FileSearch, FileText, LockKeyhole, Sparkles } from "lucide-react";
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
        <div aria-hidden="true" className="launch-spark"><Sparkles size={27} strokeWidth={1.7} /></div>
        <h1><span>Margin</span> ready to review</h1>
        <p>Bring a research paper. Margin will parse its citation graph, review the evidence, and keep every edit under your control.</p>
      </div>

      <div
        aria-label="Upload a research paper"
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
            <div className="progress-copy">
              <FileSearch aria-hidden="true" size={18} />
              <div><strong>{busyLabel}</strong><p>Layout → sections → markers → references → CSL-JSON</p></div>
            </div>
            <div aria-hidden="true" className="progress-track"><span /></div>
          </div>
        ) : (
          <div className="upload-dropzone-content">
            <div aria-hidden="true" className="upload-file-icon"><FileText size={25} strokeWidth={1.6} /></div>
            <div className="upload-dropzone-copy">
              <strong>Upload a research paper</strong>
              <span>Drag and drop your PDF here</span>
            </div>
            <button className="file-picker" onClick={() => inputRef.current?.click()} type="button">
              Choose PDF
            </button>
            <span className="upload-spec">PDF only · 20 MB maximum</span>
          </div>
        )}
      </div>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
      <div className="upload-footnote">
        <LockKeyhole aria-hidden="true" size={13} />
        <span>The original stays unchanged. Proposed edits always require approval.</span>
      </div>
    </div>
  );
}
