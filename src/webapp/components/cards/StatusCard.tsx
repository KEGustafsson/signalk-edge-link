import React from "react";
import { DeltaTimerConfig, SubscriptionConfig, SentenceFilterConfig } from "../../types";
import { Card } from "./shared";

interface Props {
  deltaTimer: DeltaTimerConfig | null;
  subscription: SubscriptionConfig | null;
  sentenceFilter: SentenceFilterConfig | null;
}

export function StatusCard({ deltaTimer, subscription, sentenceFilter }: Props) {
  return (
    <Card title="Status">
      <div className="status-info">
        {deltaTimer ? (
          <div className="status-item">
            <strong>Delta Timer:</strong> {deltaTimer.deltaTimer} ms
            <span className="status-indicator success">Configured</span>
          </div>
        ) : (
          <div className="status-item">
            <strong>Delta Timer:</strong>
            <span className="status-indicator warning">Not configured</span>
          </div>
        )}

        {subscription?.subscribe && subscription.subscribe.length > 0 ? (
          <>
            <div className="status-item">
              <strong>Subscriptions:</strong> {subscription.subscribe.length} path(s) configured
              <span className="status-indicator success">Configured</span>
            </div>
            <div className="status-details">
              <strong>Context:</strong> {subscription.context}
              <br />
              <strong>Paths:</strong> {subscription.subscribe.map((s) => s.path).join(", ")}
            </div>
          </>
        ) : (
          <div className="status-item">
            <strong>Subscriptions:</strong>
            <span className="status-indicator warning">Not configured</span>
          </div>
        )}

        {sentenceFilter?.excludedSentences && sentenceFilter.excludedSentences.length > 0 ? (
          <>
            <div className="status-item">
              <strong>Sentence Filter:</strong> {sentenceFilter.excludedSentences.length}{" "}
              sentence(s) excluded
              <span className="status-indicator success">Configured</span>
            </div>
            <div className="status-details">
              <strong>Excluded:</strong> {sentenceFilter.excludedSentences.join(", ")}
            </div>
          </>
        ) : null}
      </div>
    </Card>
  );
}
