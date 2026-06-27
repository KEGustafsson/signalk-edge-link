import React, { useState, useEffect } from "react";
import { DeltaTimerConfig } from "../../types";
import { configPath, DELTA_TIMER_MIN, DELTA_TIMER_MAX } from "../../utils";
import { useApi, ApiError } from "../../hooks/useApi";
import { Card } from "./shared";

interface Props {
  connId: string;
  config: DeltaTimerConfig | null;
  onNotify: (msg: string, type: string) => void;
  onSaved: (cfg: DeltaTimerConfig) => void;
}

export function DeltaTimerCard({ connId, config, onNotify, onSaved }: Props) {
  const [value, setValue] = useState<number>(config?.deltaTimer ?? 1000);
  const { request, authMessage } = useApi();

  useEffect(() => {
    if (config) setValue(config.deltaTimer);
  }, [config]);

  const handleSave = async () => {
    if (!Number.isFinite(value) || value < DELTA_TIMER_MIN || value > DELTA_TIMER_MAX) {
      onNotify(
        `Delta timer must be between ${DELTA_TIMER_MIN} and ${DELTA_TIMER_MAX} milliseconds`,
        "error"
      );
      return;
    }
    try {
      const res = await request(configPath(connId, "delta_timer.json"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deltaTimer: value })
      });
      if (res.ok) {
        onSaved({ deltaTimer: value });
        onNotify("Delta timer configuration saved successfully!", "success");
      } else {
        throw new Error("Failed to save configuration");
      }
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("saving delta timer")
          : `Error saving delta timer: ${e.message}`,
        "error"
      );
    }
  };

  return (
    <Card
      title="Delta Timer Configuration"
      subtitle="Controls how often deltas are collected and sent (in milliseconds)"
    >
      <div className="form-group">
        <label htmlFor="deltaTimer">Delta Timer (ms):</label>
        <input
          id="deltaTimer"
          type="number"
          min={DELTA_TIMER_MIN}
          max={DELTA_TIMER_MAX}
          step={100}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => setValue(Number(e.target.value))}
        />
        <small className="help-text">
          Lower values = more frequent updates, higher bandwidth usage
          <br />
          Higher values = better compression ratio, lower bandwidth usage
        </small>
      </div>
      <button className="btn btn-primary" onClick={handleSave}>
        Save Delta Timer
      </button>
    </Card>
  );
}
