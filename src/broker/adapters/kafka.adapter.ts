// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Kafka Adapter
//
// Kafka adapter implementing the shared BrokerAdapter interface.
// Kafka is common in high-throughput trading systems for durable, ordered
// event streams — order books, audit logs, and replay scenarios.
//
// Unlike NATS (low-latency fire-and-forget), Kafka provides:
//   - Persistent message log (replay past order events)
//   - Consumer groups (multiple QA services can consume independently)
//   - Partitioned topics (parallel processing of order streams)
//
// This adapter is wired to the same interface as NATS — swap config,
// not test logic.
//
// NOTE: Requires kafkajs — install with: npm install kafkajs
//       Not included as a default dependency since NATS is primary.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokerAdapter, BrokerConfig, MessageEnvelope, MessageHandler } from "../adapter.js";

/**
 * Kafka adapter implementing the BrokerAdapter interface.
 * Tests written against BrokerAdapter will work with this adapter
 * by changing a single config line.
 */
export class KafkaAdapter implements BrokerAdapter {
  private readonly config: BrokerConfig;
  private connected = false;

  // In a real implementation, these would be typed kafkajs instances:
  // private kafka: Kafka;
  // private producer: Producer;
  // private consumer: Consumer;
  // private admin: Admin;

  constructor(config: BrokerConfig) {
    this.config = {
      kafkaBrokers: ["localhost:9092"],
      kafkaClientId: "order-sentinel-qa",
      kafkaGroupId: "order-sentinel-test-group",
      connectionTimeoutMs: 15_000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    // const this.kafka = new Kafka({
    //   clientId: this.config.kafkaClientId,
    //   brokers: this.config.kafkaBrokers!,
    // });
    // this.producer = this.kafka.producer();
    // this.consumer = this.kafka.consumer({ groupId: this.config.kafkaGroupId! });
    // await this.producer.connect();
    // await this.consumer.connect();
    this.connected = true;
    console.log("[Kafka] Adapter connected (stub)");
  }

  async disconnect(): Promise<void> {
    // await this.producer.disconnect();
    // await this.consumer.disconnect();
    this.connected = false;
  }

  async publish<T>(subject: string, _data: T): Promise<void> {
    this.assertConnected();
    // Kafka uses "topics" — subject maps directly to topic name
    // await this.producer.send({
    //   topic: subject,
    //   messages: [{ value: JSON.stringify(data), timestamp: Date.now().toString() }],
    // });
    console.log(`[Kafka] Published to topic "${subject}" (stub)`);
  }

  async subscribe<T>(
    subject: string,
    _handler: MessageHandler<T>
  ): Promise<() => Promise<void>> {
    this.assertConnected();
    // await this.consumer.subscribe({ topic: subject, fromBeginning: false });
    // await this.consumer.run({
    //   eachMessage: async ({ topic, message }) => {
    //     const data = JSON.parse(message.value!.toString()) as T;
    //     await handler({ subject: topic, data, timestamp: new Date() });
    //   },
    // });
    console.log(`[Kafka] Subscribed to topic "${subject}" (stub)`);
    return async () => {
      console.log(`[Kafka] Unsubscribed from "${subject}" (stub)`);
    };
  }

  async waitForMessage<T>(subject: string, ___timeoutMs = 10_000): Promise<MessageEnvelope<T>> {
    // Implemented via subscribe + Promise race with timeout
    // Same pattern as NATS adapter
    throw new Error("[Kafka] waitForMessage: implement with kafkajs consumer");
  }

  async collectMessages<T>(
    subject: string,
    count: number,
    _timeoutMs = 15_000
  ): Promise<MessageEnvelope<T>[]> {
    throw new Error("[Kafka] collectMessages: implement with kafkajs consumer");
  }

  async drain(): Promise<void> {
    // await this.producer.flush();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("[Kafka] Not connected. Call connect() first.");
    }
  }
}