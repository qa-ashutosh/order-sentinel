// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — NATS Adapter
//
// Primary broker adapter. NATS is the company's message bus of choice.
// The nats.js client is actually the flagship implementation from the
// NATS.io team — this is first-class, not a port.
//
// Key NATS concepts used here:
//   - Core NATS: fire-and-forget pub/sub (orders.created, fills.executed)
//   - Subject wildcards: orders.* catches all order events
//   - Request/Reply: synchronous-style messaging over async transport
// ─────────────────────────────────────────────────────────────────────────────

import {
  connect,
  NatsConnection,
  Subscription,
  JSONCodec,
  StringCodec,
  NatsError,
  Msg,
} from "nats";
import type { BrokerAdapter, BrokerConfig, MessageEnvelope, MessageHandler } from "../adapter.js";

const jc = JSONCodec();
const sc = StringCodec();

export class NatsAdapter implements BrokerAdapter {
  private connection: NatsConnection | null = null;
  private readonly config: BrokerConfig;
  private readonly subscriptions: Set<Subscription> = new Set();

  constructor(config: BrokerConfig = {}) {
    this.config = {
      natsUrl: "nats://localhost:4222",
      connectionTimeoutMs: 10_000,
      retryAttempts: 3,
      ...config,
    };
  }

  async connect(): Promise<void> {
    if (this.connection) return;

    this.connection = await connect({
      servers: this.config.natsUrl!,
      timeout: this.config.connectionTimeoutMs,
      reconnect: true,
      maxReconnectAttempts: this.config.retryAttempts,
      waitOnFirstConnect: true,
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connection) return;

    // Unsubscribe all active subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();

    await this.connection.drain();
    await this.connection.close();
    this.connection = null;
  }

  async publish<T>(
    subject: string,
    data: T,
    headers?: Record<string, string>
  ): Promise<void> {
    this.assertConnected();

    const payload = jc.encode(data);
    this.connection!.publish(subject, payload);
  }

  async subscribe<T>(
    subject: string,
    handler: MessageHandler<T>
  ): Promise<() => Promise<void>> {
    this.assertConnected();

    const sub = this.connection!.subscribe(subject);
    this.subscriptions.add(sub);

    // Process messages asynchronously
    (async () => {
      for await (const msg of sub) {
        try {
          const data = this.decode<T>(msg);
          const envelope: MessageEnvelope<T> = {
            subject: msg.subject,
            data,
            timestamp: new Date(),
          };
          await handler(envelope as MessageEnvelope<unknown> as MessageEnvelope<T>);
        } catch (err) {
          console.error(`[NATS] Error handling message on ${subject}:`, err);
        }
      }
    })();

    return async () => {
      sub.unsubscribe();
      this.subscriptions.delete(sub);
    };
  }

  async waitForMessage<T>(
    subject: string,
    timeoutMs: number = 10_000
  ): Promise<MessageEnvelope<T>> {
    return new Promise<MessageEnvelope<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(
          new Error(
            `[NATS] Timeout waiting for message on subject "${subject}" after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      let unsub: () => void;

      this.subscribe<T>(subject, async (envelope: MessageEnvelope<unknown>) => {
        clearTimeout(timer);
        unsub();
        resolve(envelope as MessageEnvelope<T>);
      }).then((unsubFn) => {
        unsub = () => unsubFn();
      });
    });
  }

  async collectMessages<T>(
    subject: string,
    count: number,
    timeoutMs: number = 15_000
  ): Promise<MessageEnvelope<T>[]> {
    return new Promise<MessageEnvelope<T>[]>((resolve, reject) => {
      const collected: MessageEnvelope<T>[] = [];

      const timer = setTimeout(() => {
        unsub();
        reject(
          new Error(
            `[NATS] Timeout collecting ${count} messages on "${subject}". Got ${collected.length}/${count} in ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      let unsub: () => void;

      this.subscribe<T>(subject, async (envelope: MessageEnvelope<unknown>) => {
        collected.push(envelope as MessageEnvelope<T>);
        if (collected.length >= count) {
          clearTimeout(timer);
          unsub();
          resolve(collected);
        }
      }).then((unsubFn) => {
        unsub = () => unsubFn();
      });
    });
  }

  async drain(): Promise<void> {
    if (!this.connection) return;
    await this.connection.flush();
  }

  isConnected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private decode<T>(msg: Msg): T {
    try {
      return jc.decode(msg.data) as T;
    } catch {
      // Fallback to string if JSON decode fails
      return sc.decode(msg.data) as unknown as T;
    }
  }

  private assertConnected(): void {
    if (!this.connection || this.connection.isClosed()) {
      throw new Error(
        "[NATS] Adapter is not connected. Call connect() before publishing or subscribing."
      );
    }
  }
}
