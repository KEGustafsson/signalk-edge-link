import React, { useState, useEffect } from "react";
import { SentenceFilterConfig } from "../../types";
import { configPath } from "../../utils";
import { useApi, ApiError } from "../../hooks/useApi";
import { Card } from "./shared";

interface Props {
  connId: string;
  config: SentenceFilterConfig | null;
  onNotify: (msg: string, type: string) => void;
  onSaved: (cfg: SentenceFilterConfig) => void;
}

export function SentenceFilterCard({ connId, config, onNotify, onSaved }: Props) {
  const [filterText, setFilterText] = useState(config?.excludedSentences?.join(", ") ?? "");
  const { request, authMessage } = useApi();

  useEffect(() => {
    setFilterText(config?.excludedSentences?.join(", ") ?? "");
  }, [config]);

  const handleSave = async () => {
    const excludedSentences = filterText
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);

    try {
      const res = await request(configPath(connId, "sentence_filter.json"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excludedSentences })
      });
      if (res.ok) {
        onSaved({ excludedSentences });
        onNotify("Sentence filter saved successfully!", "success");
      } else {
        throw new Error("Failed to save sentence filter");
      }
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("saving sentence filter")
          : `Error saving sentence filter: ${e.message}`,
        "error"
      );
    }
  };

  return (
    <Card
      title="Sentence Filter"
      subtitle="Exclude NMEA sentences from transmission (reduces bandwidth)"
    >
      <div className="form-group">
        <label htmlFor="sentenceFilter">Excluded Sentences:</label>
        <input
          id="sentenceFilter"
          type="text"
          placeholder=""
          autoComplete="off"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <small className="help-text">Comma-separated list of NMEA sentence types to exclude.</small>
      </div>
      <button className="btn btn-primary" onClick={handleSave}>
        Save Sentence Filter
      </button>
    </Card>
  );
}
