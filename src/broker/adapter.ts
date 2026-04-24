// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Broker Abstraction Layer
//
// This interface decouples test logic from any specific message broker.
// NATS is the primary implementation (matching the company's stack).
// Kafka and RabbitMQ adapters demonstrate awareness of the broader ecosystem
// and allow the framework to be plugged into different environments.
//
// Pattern: Program to the interface, not the implementation.
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageEnvelope<T = unknown> {
  subject: string;
  data: T;
  headers?: Record<string, string>;
  timestamp: Date;
}

export type MessageHandler<T = unknown> = (
  envelope: MessageEnvelope<T>
) => Promise<void> | void;

/**
 * Core broker interface. Any message broker used in the test suite
 * must implement this contract.
 */
export interface BrokerAdapter {
  /**
   * Connect to the broker. Must be called before publish/subscribe.
   */
  connect(): Promise<void>;

  /**
   * Gracefully disconnect and clean up resources.
   */
  disconnect(): Promise<void>;

  /**
   * Publish a message to a subject/topic.
   */
  publish<T>(subject: string, data: T, headers?: Record<string, string>): Promise<void>;

  /**
   * Subscribe to a subject/topic. Returns an unsubscribe function.
   */
  subscribe<T>(subject: string, handler: MessageHandler<T>): Promise<() => Promise<void>>;

  /**
   * Wait for a single message on a subject with a timeout.
   * Essential for integration tests that assert on async side-effects.
   */
  waitForMessage<T>(subject: string, timeoutMs?: number): Promise<MessageEnvelope<T>>;

  /**
   * Collect N messages from a subject within a time window.
   * Used for partial fill scenarios where multiple events are expected.
   */
  collectMessages<T>(
    subject: string,
    count: number,
    timeoutMs?: number
  ): Promise<MessageEnvelope<T>[]>;

  /**
   * Drain all pending messages and flush the connection.
   * Called between tests to prevent message bleed.
   */
  drain(): Promise<void>;

  /**
   * Whether the adapter is currently connected.
   */
  isConnected(): boolean;
}

/**
 * Configuration for broker adapters.
 * Each adapter picks what it needs from this shape.
 */
export interface BrokerConfig {
  // NATS
  natsUrl?: string;

  // Kafka
  kafkaBrokers?: string[];
  kafkaClientId?: string;
  kafkaGroupId?: string;

  // RabbitMQ
  rabbitmqUrl?: string;
  rabbitmqExchange?: string;

  // Common
  connectionTimeoutMs?: number;
  retryAttempts?: number;
}
