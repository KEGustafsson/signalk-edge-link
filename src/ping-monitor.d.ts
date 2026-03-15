declare module "ping-monitor" {
  import { EventEmitter } from "events";

  interface MonitorOptions {
    address: string;
    port?: number;
    interval?: number;
    protocol?: string;
  }

  class Monitor extends EventEmitter {
    constructor(options: MonitorOptions);
    stop(): void;
  }

  export = Monitor;
}
