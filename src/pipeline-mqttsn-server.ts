"use strict";

/**
 * MQTT-SN server pipeline (v4, gateway role).
 *
 * Thin ServerPipelineApi wrapper around mqttsn-gateway.ts.
 * instance.ts calls:
 *   - receivePacket()  for each incoming UDP datagram
 *   - startACKTimer()  on socket 'listening' → starts the gateway
 *   - stopACKTimer()   on cleanup → stops the gateway
 */

import { createMqttSnGateway } from "./mqttsn-gateway";
import type {
  InstanceState,
  MetricsApi,
  MetricsPublisherApi,
  ServerPipelineApi,
  SignalKApp
} from "./types";

export function createPipelineMqttSnServer(
  app: SignalKApp,
  state: InstanceState,
  metricsApi: MetricsApi
): ServerPipelineApi {
  const gw = createMqttSnGateway(app, state, metricsApi);

  function stubMetricsPublisher(): MetricsPublisherApi {
    return {
      calculateLinkQuality: () => 0,
      publish: () => {},
      publishLinkMetrics: () => {}
    };
  }

  return {
    async receivePacket(
      packet: Buffer,
      _secretKey: string,
      rinfo: import("dgram").RemoteInfo
    ): Promise<void> {
      gw.handleMessage(packet, rinfo);
    },

    // startACKTimer is called by instance.ts in the socket 'listening' handler;
    // repurpose it as the gateway start hook.
    startACKTimer(): void {
      gw.start();
    },

    // stopACKTimer is called by instance.ts on cleanup.
    stopACKTimer(): void {
      gw.stop();
    },

    startMetricsPublishing(): void {},
    stopMetricsPublishing(): void {},
    getSequenceTracker: () => undefined,
    getPacketBuilder: () => null,
    getMetrics: () => ({}),
    getMetricsPublisher: () => stubMetricsPublisher(),
    requestFullStatusFromAllClients(): void {}
  };
}
