"use strict";

/**
 * Minimal typed interfaces for Express request/response objects used by route
 * handlers in this module.  Defining them here avoids a runtime dependency on
 * @types/express while still giving the TypeScript compiler enough information
 * to catch mistakes in handler bodies.
 *
 * The shapes are structural subsets of express.Request / express.Response and
 * are assignment-compatible when the real Express objects are passed at runtime.
 */

import type {
  SignalKApp,
  InstanceRegistry,
  InstanceBundle,
  InstanceState,
  Metrics,
  PluginRef,
  EffectiveNetworkQuality,
  PathStatEntry
} from "../types";

/** Subset of express.Request properties used by route handlers. */
export interface RouteRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** Remote IP address of the caller (populated by Express). */
  ip?: string;
  /** Express app reference (used for trust-proxy check). */
  app?: { get(key: string): unknown };
  /** Raw socket (used for fallback IP detection). */
  socket?: { remoteAddress?: string };
}

/** Subset of express.Response methods used by route handlers. */
export interface RouteResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: unknown): this;
  set(key: string, value: string): this;
  /** Sets the Content-Type response header. Alias for res.set('Content-Type', ...). */
  contentType(type: string): this;
  end(): void;
}

/** Express next() callback passed to middleware functions. */
export type NextFn = () => void;

/** A route handler or middleware function. */
export type RouteHandler = (req: RouteRequest, res: RouteResponse, next?: NextFn) => void;

/** Aggregate management auth telemetry exposed by route-level status/metrics endpoints. */
export interface ManagementAuthSnapshot {
  total: number;
  allowed: number;
  denied: number;
  byReason: Record<string, number>;
  byAction: Record<
    string,
    {
      total: number;
      allowed: number;
      denied: number;
      reasons: Record<string, number>;
      byDecision: { allowed: Record<string, number>; denied: Record<string, number> };
    }
  >;
}

/** Minimal Express router interface used by route sub-modules. */
export interface Router {
  get(path: string, ...handlers: RouteHandler[]): void;
  post(path: string, ...handlers: RouteHandler[]): void;
  put(path: string, ...handlers: RouteHandler[]): void;
  delete(path: string, ...handlers: RouteHandler[]): void;
}

/** Network quality data assembled for HTTP responses. */
export interface NetworkQualityResponse {
  rtt: number;
  jitter: number;
  packetLoss: number;
  retransmissions: number;
  queueDepth: number;
  acksSent: number;
  naksSent: number;
  dataSource: string;
  lastRemoteUpdate?: number;
  activeLink?: string;
  linkQuality?: number;
  retransmitRate?: number;
  timestamp?: number;
}

/** Shared context object passed to every route sub-module. */
export interface RouteContext {
  app: SignalKApp;
  instanceRegistry: InstanceRegistry;
  pluginRef: PluginRef;
  rateLimitMiddleware: RouteHandler;
  requireJson: RouteHandler;
  getFirstBundle(): InstanceBundle | null;
  getBundleById(id: string): InstanceBundle | null;
  getFirstClientBundle(): InstanceBundle | null;
  getConfigFilePath(state: InstanceState, filename: string): string | null;
  loadConfigFile(filePath: string): Promise<unknown>;
  saveConfigFile(filePath: string, data: unknown): Promise<boolean>;
  getActiveMetricsPublisher(state: InstanceState): {
    calculateLinkQuality(params: {
      rtt: number;
      jitter: number;
      packetLoss: number;
      retransmitRate: number;
    }): number;
  } | null;
  getEffectiveNetworkQuality(
    state: InstanceState,
    metrics: Metrics,
    now?: number
  ): EffectiveNetworkQuality;
  buildFullMetricsResponse(bundle: InstanceBundle): Record<string, unknown>;
  getManagementAuthSnapshot(): ManagementAuthSnapshot;
  authorizeManagement(req: RouteRequest, res: RouteResponse, action?: string): boolean;
  managementAuthMiddleware(action: string): RouteHandler;
}

// Re-export types from parent for convenience in route sub-modules
export type {
  SignalKApp,
  InstanceRegistry,
  InstanceBundle,
  InstanceState,
  Metrics,
  PluginRef,
  EffectiveNetworkQuality,
  PathStatEntry
};
