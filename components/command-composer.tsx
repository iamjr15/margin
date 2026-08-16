"use client";

import { ArrowUp, Sparkles } from "lucide-react";
import { useState } from "react";

const SUGGESTIONS = [
  "Add citations to the introduction",
  "Find citations supporting the methodology",
  "Make the introduction shorter",
];

export function CommandComposer({
  disabled,
  placeholder,
  onSubmit,
}: {
  disabled: boolean;
  placeholder: string;
  onSubmit: (command: string) => Promise<void>;
}) {
  const [command, setCommand] = useState("");

  const submit = async () => {
    const value = command.trim();
    if (!value || disabled) return;
    await onSubmit(value);
    setCommand("");
  };

  return (
    <div className="composer-region">
      <div className="suggestion-row" aria-label="Suggested editing commands">
        {SUGGESTIONS.map((suggestion) => (
          <button
            disabled={disabled}
            key={suggestion}
            onClick={() => setCommand(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div className="command-composer">
        <label className="sr-only" htmlFor="paper-command">Editing command</label>
        <textarea
          disabled={disabled}
          id="paper-command"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={3}
          value={command}
        />
        <div className="composer-footer">
          <span><Sparkles aria-hidden="true" size={13} /> Typed operations only</span>
          <button
            aria-label="Create edit proposal"
            disabled={disabled || command.trim().length < 3}
            onClick={() => void submit()}
            type="button"
          >
            <ArrowUp aria-hidden="true" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
