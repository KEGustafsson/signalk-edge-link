"use strict";

const { UdpSocketManager, udpSendAsync } = require("../../lib/transport/udp-socket-manager");

describe("transport/udp-socket-manager", () => {
  describe("UdpSocketManager lifecycle", () => {
    test("create() returns a udp4 socket and retains it", () => {
      const mgr = new UdpSocketManager();
      expect(mgr.socket).toBeNull();
      const socket = mgr.create();
      expect(socket).toBe(mgr.socket);
      expect(typeof socket.send).toBe("function");
      mgr.close();
    });

    test("bind() listens and address() reports the bound port", async () => {
      const mgr = new UdpSocketManager();
      mgr.create();
      const listening = new Promise((resolve) => mgr.socket.once("listening", resolve));
      mgr.bind(0); // ephemeral port
      await listening;
      const addr = mgr.address();
      expect(addr).toBeTruthy();
      expect(typeof addr.port).toBe("number");
      expect(addr.port).toBeGreaterThan(0);
      mgr.close();
    });

    test("close() is idempotent and drops the socket", () => {
      const mgr = new UdpSocketManager();
      mgr.create();
      mgr.close();
      expect(mgr.socket).toBeNull();
      expect(() => mgr.close()).not.toThrow();
      expect(mgr.address()).toBeUndefined();
    });

    test("bind() before create() throws", () => {
      const mgr = new UdpSocketManager();
      expect(() => mgr.bind(0)).toThrow(/not initialized/);
    });

    test("send() delivers a datagram over the managed socket", async () => {
      const receiver = new UdpSocketManager();
      receiver.create();
      const listening = new Promise((resolve) => receiver.socket.once("listening", resolve));
      receiver.bind(0);
      await listening;
      const { port } = receiver.address();

      const received = new Promise((resolve) => {
        receiver.socket.once("message", (msg) => resolve(msg.toString()));
      });

      const sender = new UdpSocketManager();
      sender.create();
      await sender.send(Buffer.from("hello-udp"), "127.0.0.1", port);

      await expect(received).resolves.toBe("hello-udp");
      sender.close();
      receiver.close();
    });
  });

  describe("udpSendAsync", () => {
    test("throws synchronously when no socket is provided", () => {
      expect(() => udpSendAsync(null, Buffer.from("x"), "127.0.0.1", 1234)).toThrow(
        /not initialized/
      );
    });

    test("retries on transient EAGAIN then resolves, invoking onRetry", async () => {
      let calls = 0;
      const fakeSocket = {
        send(_msg, _port, _host, cb) {
          calls += 1;
          if (calls === 1) {
            const err = new Error("try again");
            err.code = "EAGAIN";
            cb(err);
          } else {
            cb(null);
          }
        }
      };
      const onRetry = jest.fn();
      await udpSendAsync(fakeSocket, Buffer.from("x"), "127.0.0.1", 1234, { onRetry });
      expect(calls).toBe(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ code: "EAGAIN" }));
    });

    test("rejects and invokes onError for non-retryable errors", async () => {
      const fakeSocket = {
        send(_msg, _port, _host, cb) {
          const err = new Error("nope");
          err.code = "ECONNREFUSED";
          cb(err);
        }
      };
      const onError = jest.fn();
      await expect(
        udpSendAsync(fakeSocket, Buffer.from("x"), "127.0.0.1", 1234, { onError })
      ).rejects.toThrow("nope");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "ECONNREFUSED" }), 0);
    });

    test("a socket callback after the hard timeout does not retry or fire callbacks", async () => {
      jest.useFakeTimers();
      try {
        let storedCb;
        // A socket whose send never calls back synchronously — it hangs, so the
        // hard timeout wins the race.
        const hangingSocket = {
          send(_msg, _port, _host, cb) {
            storedCb = cb;
          }
        };
        const onRetry = jest.fn();
        const onError = jest.fn();

        const sendPromise = udpSendAsync(hangingSocket, Buffer.from("x"), "127.0.0.1", 1234, {
          onRetry,
          onError
        });
        const rejection = expect(sendPromise).rejects.toThrow(/timed out/);

        // Fire the hard send timeout (UDP_SEND_TIMEOUT_MS).
        jest.advanceTimersByTime(5000);
        await rejection;

        // A late callback arrives after the caller already timed out: it must
        // not schedule a retry or invoke onRetry/onError.
        const eagain = new Error("late EAGAIN");
        eagain.code = "EAGAIN";
        storedCb(eagain);
        await Promise.resolve();

        expect(onRetry).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
