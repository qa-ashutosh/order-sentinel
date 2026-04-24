// ─────────────────────────────────────────────────────────────────────────────
// order-sentinel — Typed API Client
//
// Wraps axios with full TypeScript types for every endpoint.
// Tests use this client — never raw axios calls.
// This means contract changes surface immediately as type errors.
// ─────────────────────────────────────────────────────────────────────────────

import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import type { CreateOrderRequest, UpdateOrderRequest, CreateTraderRequest } from "../types.js";

export interface ApiClientConfig {
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface RequestResult<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

export interface ErrorResult {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(config: ApiClientConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs ?? 10_000,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...config.headers,
      },
      // Don't throw on non-2xx — we want to assert on error responses
      validateStatus: () => true,
    });
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async createOrder(payload: CreateOrderRequest): Promise<AxiosResponse> {
    return this.http.post("/orders", payload);
  }

  async getOrder(orderId: string): Promise<AxiosResponse> {
    return this.http.get(`/orders/${orderId}`);
  }

  async listOrders(params?: {
    traderId?: string;
    status?: string;
    symbol?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AxiosResponse> {
    return this.http.get("/orders", { params });
  }

  async cancelOrder(orderId: string): Promise<AxiosResponse> {
    return this.http.delete(`/orders/${orderId}`);
  }

  async updateOrder(orderId: string, payload: UpdateOrderRequest): Promise<AxiosResponse> {
    return this.http.patch(`/orders/${orderId}`, payload);
  }

  async getOrderFills(orderId: string): Promise<AxiosResponse> {
    return this.http.get(`/orders/${orderId}/fills`);
  }

  // ── Traders / Profiles ─────────────────────────────────────────────────────

  async createTrader(payload: CreateTraderRequest): Promise<AxiosResponse> {
    return this.http.post("/traders", payload);
  }

  async getTrader(traderId: string): Promise<AxiosResponse> {
    return this.http.get(`/traders/${traderId}`);
  }

  async listTraders(params?: {
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AxiosResponse> {
    return this.http.get("/traders", { params });
  }

  async suspendTrader(traderId: string, reason: string): Promise<AxiosResponse> {
    return this.http.post(`/traders/${traderId}/suspend`, { reason });
  }

  async updateRiskLimits(
    traderId: string,
    limits: Partial<CreateTraderRequest["riskLimits"]>
  ): Promise<AxiosResponse> {
    return this.http.patch(`/traders/${traderId}/risk-limits`, limits);
  }

  // ── Health / System ────────────────────────────────────────────────────────

  async healthCheck(): Promise<AxiosResponse> {
    return this.http.get("/health");
  }

  async getMetrics(): Promise<AxiosResponse> {
    return this.http.get("/metrics");
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Helper to extract error details from non-2xx responses.
   * Normalizes the error shape for cleaner test assertions.
   */
  static extractError(response: AxiosResponse): ErrorResult {
    return {
      status: response.status,
      code: response.data?.code ?? "UNKNOWN_ERROR",
      message: response.data?.message ?? "Unknown error",
      details: response.data?.details,
    };
  }

  /**
   * Creates a client from environment variables.
   * Used by integration tests that run against a live service.
   */
  static fromEnv(): ApiClient {
    return new ApiClient({
      baseUrl: process.env.API_BASE_URL ?? "http://localhost:3000",
      timeoutMs: parseInt(process.env.API_TIMEOUT_MS ?? "10000"),
      headers: process.env.API_KEY
        ? { "X-API-Key": process.env.API_KEY }
        : undefined,
    });
  }
}
