"use client";

import { ArrowUp, FileSearch, FileText, LockKeyhole, Plus, Sparkles } from "lucide-react";
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
        <p className="launch-context">Local workspace · citation-safe</p>
        <h1><span>Margin</span> ready to review</h1>
        <p>Bring a research paper. Margin will parse its citation graph, review the evidence, and keep every edit under your control.</p>
      </div>

      <div
        className="upload-composer"
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
          <>
            <button className="upload-prompt" onClick={() => inputRef.current?.click()} type="button">
              <span>Drop a research paper here, or choose a PDF</span>
            </button>
            <div className="upload-composer-footer">
              <button aria-label="Choose a PDF" className="composer-icon-button" onClick={() => inputRef.current?.click()} title="Choose PDF" type="button">
                <Plus aria-hidden="true" size={17} />
              </button>
              <button className="file-picker" onClick={() => inputRef.current?.click()} type="button">
                <FileText aria-hidden="true" size={14} /> Choose PDF
              </button>
              <span className="upload-spec">PDF · 20 MB</span>
              <button aria-label="Choose PDF to begin" className="launch-send" onClick={() => inputRef.current?.click()} type="button">
                <ArrowUp aria-hidden="true" size={17} />
              </button>
            </div>
          </>
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
