// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — RabbitMQ Adapter
//
// RabbitMQ adapter implementing the shared BrokerAdapter interface.
// RabbitMQ is common in trading systems that need:
//   - Complex routing (topic/fanout exchanges)
//   - Message acknowledgment and dead-letter queues
//   - Per-queue TTL for time-sensitive orders (IOC/FOK)
//
// The exchange/routing-key model maps well to trading subjects:
//   Exchange: "orders"   Routing key: "orders.created", "orders.filled"
//
// NOTE: Requires amqplib — install with: npm install amqplib @types/amqplib
//       Not included as default dependency since NATS is primary.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrokerAdapter, BrokerConfig, MessageEnvelope, MessageHandler } from "../adapter.js";

export class RabbitMQAdapter implements BrokerAdapter {
  private readonly config: BrokerConfig;
  private connected = false;

  // In a real implementation:
  // private connection: amqplib.Connection;
  // private channel: amqplib.Channel;

  constructor(config: BrokerConfig) {
    this.config = {
      rabbitmqUrl: "amqp://localhost:5672",
      rabbitmqExchange: "order-sentinel",
      connectionTimeoutMs: 10_000,
      ...config,
    };
  }

  async connect(): Promise<void> {
    // this.connection = await amqplib.connect(this.config.rabbitmqUrl!);
    // this.channel = await this.connection.createChannel();
    // await this.channel.assertExchange(this.config.rabbitmqExchange!, "topic", { durable: true });
    this.connected = true;
    console.log("[RabbitMQ] Adapter connected (stub)");
  }

  async disconnect(): Promise<void> {
    // await this.channel.close();
    // await this.connection.close();
    this.connected = false;
  }

  async publish<T>(subject: string, _data: T): Promise<void> {
    this.assertConnected();
    // RabbitMQ uses exchange + routing key
    // subject maps to routing key e.g. "orders.created"
    // this.channel.publish(
    //   this.config.rabbitmqExchange!,
    //   subject,
    //   Buffer.from(JSON.stringify(data)),
    //   { persistent: true, timestamp: Date.now() }
    // );
    console.log(`[RabbitMQ] Published "${subject}" (stub)`);
  }

  async subscribe<T>(
    subject: string,
    _handler: MessageHandler<T>
  ): Promise<() => Promise<void>> {
    this.assertConnected();
    // const q = await this.channel.assertQueue("", { exclusive: true, autoDelete: true });
    // await this.channel.bindQueue(q.queue, this.config.rabbitmqExchange!, subject);
    // await this.channel.consume(q.queue, async (msg) => {
    //   if (!msg) return;
    //   const data = JSON.parse(msg.content.toString()) as T;
    //   await handler({ subject, data, timestamp: new Date() });
    //   this.channel.ack(msg);
    // });
    console.log(`[RabbitMQ] Subscribed to "${subject}" (stub)`);
    return async () => {
      console.log(`[RabbitMQ] Unsubscribed from "${subject}" (stub)`);
    };
  }

  async waitForMessage<T>(subject: string, ___timeoutMs = 10_000): Promise<MessageEnvelope<T>> {
    throw new Error("[RabbitMQ] waitForMessage: implement with amqplib consumer");
  }

  async collectMessages<T>(
    subject: string,
    count: number,
    _timeoutMs = 15_000
  ): Promise<MessageEnvelope<T>[]> {
    throw new Error("[RabbitMQ] collectMessages: implement with amqplib consumer");
  }

  async drain(): Promise<void> {
    // No-op in RabbitMQ — messages are acked per-message
  }

  isConnected(): boolean {
    return this.connected;
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error("[RabbitMQ] Not connected. Call connect() first.");
    }
  }
}