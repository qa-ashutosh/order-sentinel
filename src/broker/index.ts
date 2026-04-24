// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Broker Factory
//
// Single entry point for creating broker adapters.
// Tests and fixtures import from here — they never import adapters directly.
// Swap broker type via environment variable: BROKER_TYPE=nats|kafka|rabbitmq
// ─────────────────────────────────────────────────────────────────────────────

import { NatsAdapter } from "./adapters/nats.adapter.js";
import { KafkaAdapter } from "./adapters/kafka.adapter.js";
import { RabbitMQAdapter } from "./adapters/rabbitmq.adapter.js";
import type { BrokerAdapter, BrokerConfig } from "./adapter.js";

export type BrokerType = "nats" | "kafka" | "rabbitmq";

export function createBroker(
  type: BrokerType = "nats",
  config: BrokerConfig = {}
): BrokerAdapter {
  switch (type) {
    case "nats":
      return new NatsAdapter(config);
    case "kafka":
      return new KafkaAdapter(config);
    case "rabbitmq":
      return new RabbitMQAdapter(config);
    default:
      throw new Error(`[BrokerFactory] Unknown broker type: "${type}". Expected nats|kafka|rabbitmq`);
  }
}

/**
 * Creates a broker from environment variables.
 * Used by the test suite for CI/CD flexibility.
 *
 * Environment variables:
 *   BROKER_TYPE=nats           (default: nats)
 *   NATS_URL=nats://localhost:4222
 *   KAFKA_BROKERS=localhost:9092
 *   RABBITMQ_URL=amqp://localhost:5672
 */
export function createBrokerFromEnv(): BrokerAdapter {
  const type = (process.env.BROKER_TYPE ?? "nats") as BrokerType;

  const config: BrokerConfig = {
    natsUrl: process.env.NATS_URL ?? "nats://localhost:4222",
    kafkaBrokers: process.env.KAFKA_BROKERS?.split(",") ?? ["localhost:9092"],
    kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "order-sentinel-qa",
    kafkaGroupId: process.env.KAFKA_GROUP_ID ?? "order-sentinel-test-group",
    rabbitmqUrl: process.env.RABBITMQ_URL ?? "amqp://localhost:5672",
    connectionTimeoutMs: parseInt(process.env.BROKER_TIMEOUT_MS ?? "10000"),
  };

  return createBroker(type, config);
}

export type { BrokerAdapter, BrokerConfig } from "./adapter.js";
