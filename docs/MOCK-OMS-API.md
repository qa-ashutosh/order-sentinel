# Mock OMS — REST API Reference

The mock OMS is a Fastify server that ships with order-sentinel. It implements a realistic subset of a prop trading Order/Profile Management System, including a risk check engine, order lifecycle state machine, and in-memory state store.

**Base URL:** `http://localhost:3000`

Start it with:

```bash
npm run mock
```

Or it starts automatically when you run any test suite — no manual start needed for testing.

---

## General Conventions

**Request headers** for all endpoints that send a body:

```
Content-Type: application/json
```

**Success envelope:**

```json
{ "data": { ...resource } }
```

**List envelope:**

```json
{ "data": [...], "meta": { "total": 3 } }
```

**Error envelope:**

```json
{
  "code": "TRADER_NOT_FOUND",
  "message": "Trader abc-123 not found",
  "timestamp": "2024-04-23T10:00:00.000Z"
}
```

---

## Utility

### Health Check

```
GET /health
```

```bash
curl http://localhost:3000/health
```

**Response `200`:**

```json
{ "status": "ok", "service": "mock-oms", "timestamp": "2024-04-23T10:00:00.000Z" }
```

---

### Reset Store

Clears all traders, orders, fills, and audit log entries. Call this between test runs to start from a clean state.

```
POST /reset
```

```bash
curl -X POST http://localhost:3000/reset
```

**Response `200`:**

```json
{ "data": { "message": "Store reset" } }
```

---

## Traders

### Create Trader

```
POST /traders
```

```bash
curl -X POST http://localhost:3000/traders \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Chen",
    "email": "alice@propfirm.internal",
    "capitalAllocated": 500000,
    "riskLimits": {
      "maxOrderSize": 1000,
      "maxPositionSize": 5000,
      "maxDailyLoss": 50000,
      "maxOpenOrders": 20
    }
  }'
```

**Fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | ✅ | Min 2 characters |
| `email` | string | ✅ | Valid email, unique |
| `capitalAllocated` | number | ✅ | Must be positive |
| `riskLimits.maxOrderSize` | number | ✅ | Max quantity per single order |
| `riskLimits.maxPositionSize` | number | ✅ | Max total position size |
| `riskLimits.maxDailyLoss` | number | ✅ | Daily loss limit in base currency |
| `riskLimits.maxOpenOrders` | number | ✅ | Max concurrent open orders |
| `riskLimits.allowedSymbols` | string[] | ❌ | If set, restricts tradeable symbols |

**Response `201`:**

```json
{
  "data": {
    "id": "d5a5328f-6cde-47e2-9ee0-253d6149da9b",
    "name": "Alice Chen",
    "email": "alice@propfirm.internal",
    "status": "PENDING_APPROVAL",
    "capitalAllocated": 500000,
    "capitalUsed": 0,
    "dailyPnL": 0,
    "totalPnL": 0,
    "riskLimits": {
      "maxOrderSize": 1000,
      "maxPositionSize": 5000,
      "maxDailyLoss": 50000,
      "maxOpenOrders": 20
    },
    "createdAt": "2024-04-23T10:00:00.000Z",
    "updatedAt": "2024-04-23T10:00:00.000Z"
  }
}
```

**Error responses:**
- `400` — validation error (invalid email, negative capital, etc.)
- `409` — duplicate email

**Trader status lifecycle:**

New traders start as `PENDING_APPROVAL`. Use the direct state patch below to set them `ACTIVE` for order placement.

---

### List Traders

```
GET /traders
GET /traders?status=ACTIVE
```

```bash
curl "http://localhost:3000/traders?status=ACTIVE"
```

**Query params:**

| Param | Values |
|---|---|
| `status` | `PENDING_APPROVAL`, `ACTIVE`, `SUSPENDED` |

**Response `200`:**

```json
{
  "data": [...],
  "meta": { "total": 3 }
}
```

---

### Get Trader

```
GET /traders/:id
```

```bash
curl http://localhost:3000/traders/d5a5328f-6cde-47e2-9ee0-253d6149da9b
```

**Response `200`** — trader object. **`404`** if not found.

---

### Force-Update Trader State (Test Utility)

Directly patches any trader field — bypasses all business logic. Used in tests to activate traders, inject PnL, etc.

```
PATCH /traders/:id
```

```bash
# Activate a trader
curl -X PATCH http://localhost:3000/traders/d5a5328f-6cde-47e2-9ee0-253d6149da9b \
  -H "Content-Type: application/json" \
  -d '{ "status": "ACTIVE" }'

# Inject a daily loss to trigger risk checks
curl -X PATCH http://localhost:3000/traders/d5a5328f-6cde-47e2-9ee0-253d6149da9b \
  -H "Content-Type: application/json" \
  -d '{ "dailyPnL": -48000 }'
```

**Response `200`** — updated trader object. **`404`** if not found.

---

### Update Risk Limits

```
PATCH /traders/:id/risk-limits
```

```bash
curl -X PATCH http://localhost:3000/traders/d5a5328f-6cde-47e2-9ee0-253d6149da9b/risk-limits \
  -H "Content-Type: application/json" \
  -d '{
    "maxOrderSize": 500,
    "allowedSymbols": ["BTCUSDT", "ETHUSDT"]
  }'
```

Partial updates are supported — only the fields you send will change. All numeric limits must be positive (not zero).

**Response `200`** — updated trader. **`400`** if any limit is zero or negative.

---

### Suspend Trader

```
POST /traders/:id/suspend
```

```bash
curl -X POST http://localhost:3000/traders/d5a5328f-6cde-47e2-9ee0-253d6149da9b/suspend \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Exceeded daily loss limit" }'
```

**Response `200`** — trader with `status: "SUSPENDED"`.
**`409`** if already suspended. **`404`** if not found.

---

## Orders

### Create Order

Risk checks run on every order. The trader must be `ACTIVE`. All risk limits are enforced.

```
POST /orders
```

**LIMIT BUY:**

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "traderId": "d5a5328f-6cde-47e2-9ee0-253d6149da9b",
    "symbol": "BTCUSDT",
    "side": "BUY",
    "type": "LIMIT",
    "quantity": 2,
    "price": 60000,
    "timeInForce": "GTC"
  }'
```

**MARKET SELL:**

```bash
curl -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "traderId": "d5a5328f-6cde-47e2-9ee0-253d6149da9b",
    "symbol": "ETHUSDT",
    "side": "SELL",
    "type": "MARKET",
    "quantity": 5,
    "timeInForce": "IOC"
  }'
```

**Fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `traderId` | UUID | ✅ | Must exist and be ACTIVE |
| `symbol` | string | ✅ | Uppercase, e.g. `BTCUSDT` |
| `side` | string | ✅ | `BUY` or `SELL` |
| `type` | string | ✅ | `LIMIT`, `MARKET`, `STOP`, `STOP_LIMIT` |
| `quantity` | number | ✅ | Must be positive |
| `price` | number | ✅ for LIMIT | Must be positive |
| `timeInForce` | string | ✅ | `GTC`, `DAY`, `IOC`, `FOK` |
| `tags` | string[] | ❌ | Optional labels |
| `expiresAt` | ISO datetime | ❌ | For DAY/GTD orders |

**Response `201`** — order with `status: "NEW"`.

**Error responses:**

| Code | Meaning |
|---|---|
| `400` | Validation error (missing fields, invalid values) |
| `404` | Trader not found |
| `422 TRADER_SUSPENDED` | Trader is suspended |
| `422 POSITION_LIMIT_BREACH` | Exceeds maxOrderSize or maxOpenOrders |
| `422 DAILY_LOSS_LIMIT_REACHED` | Daily loss at or beyond limit |
| `422 INVALID_SYMBOL` | Symbol not in trader's allowedSymbols |
| `422 INSUFFICIENT_CAPITAL` | Trader has no capital allocated |

---

### List Orders

```
GET /orders
GET /orders?traderId=d5a5328f-...&status=NEW&symbol=BTCUSDT
```

```bash
# All open orders for a trader
curl "http://localhost:3000/orders?traderId=d5a5328f-6cde-47e2-9ee0-253d6149da9b&status=NEW"
```

**Query params:**

| Param | Notes |
|---|---|
| `traderId` | Filter by trader |
| `status` | Filter by status |
| `symbol` | Filter by symbol |

**Response `200`:**

```json
{
  "data": [...],
  "meta": { "total": 5 }
}
```

---

### Get Order

```
GET /orders/:id
```

```bash
curl http://localhost:3000/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6
```

**Response `200`** — order object. **`404`** if not found.

---

### Update Order State (with State Machine)

Transitions the order through the state machine. Invalid transitions return `409`.

```
PATCH /orders/:id
```

```bash
# Transition NEW → PENDING
curl -X PATCH http://localhost:3000/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6 \
  -H "Content-Type: application/json" \
  -d '{ "status": "PENDING" }'
```

**Valid transitions:**

| From | To |
|---|---|
| NEW | PENDING, CANCELLED, REJECTED, EXPIRED |
| PENDING | PARTIALLY_FILLED, FILLED, CANCELLED, REJECTED, EXPIRED |
| PARTIALLY_FILLED | FILLED, CANCELLED, EXPIRED |
| FILLED | — (terminal) |
| CANCELLED | — (terminal) |
| REJECTED | — (terminal) |
| EXPIRED | — (terminal) |

**`409`** on invalid transition. **`404`** if order not found.

---

### Force-Update Order State (Test Utility)

Bypasses the state machine entirely. Used in tests to set up specific states.

```
PATCH /orders/:id?force=true
```

```bash
# Force an order to PARTIALLY_FILLED for testing
curl -X PATCH "http://localhost:3000/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6?force=true" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "PARTIALLY_FILLED",
    "filledQuantity": 3,
    "remainingQuantity": 7
  }'
```

---

### Cancel Order

```
DELETE /orders/:id
```

```bash
curl -X DELETE http://localhost:3000/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6
```

**Response `200`** — order with `status: "CANCELLED"`.
**`409`** if order is already in a terminal state (FILLED, CANCELLED, REJECTED, EXPIRED).
**`404`** if not found.

---

### Get Order Fills

```
GET /orders/:id/fills
```

```bash
curl http://localhost:3000/orders/3fa85f64-5717-4562-b3fc-2c963f66afa6/fills
```

**Response `200`:**

```json
{
  "data": [
    {
      "id": "fill-uuid",
      "orderId": "3fa85f64-...",
      "quantity": 3,
      "price": 60050.00,
      "executedAt": "2024-04-23T10:05:00.000Z"
    }
  ],
  "meta": { "total": 1 }
}
```

Returns an empty array for orders with no fills yet.

---

## Full Manual Workflow Example

Here's a complete end-to-end flow to try the mock OMS manually:

```bash
# 1. Start the server
npm run mock

# 2. Create a trader
TRADER=$(curl -s -X POST http://localhost:3000/traders \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Chen",
    "email": "alice@propfirm.internal",
    "capitalAllocated": 500000,
    "riskLimits": {
      "maxOrderSize": 1000,
      "maxPositionSize": 5000,
      "maxDailyLoss": 50000,
      "maxOpenOrders": 20
    }
  }')
TRADER_ID=$(echo $TRADER | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "Trader: $TRADER_ID"

# 3. Activate the trader
curl -s -X PATCH http://localhost:3000/traders/$TRADER_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "ACTIVE"}' | python3 -m json.tool

# 4. Place a LIMIT BUY order
ORDER=$(curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"traderId\": \"$TRADER_ID\",
    \"symbol\": \"BTCUSDT\",
    \"side\": \"BUY\",
    \"type\": \"LIMIT\",
    \"quantity\": 2,
    \"price\": 60000,
    \"timeInForce\": \"GTC\"
  }")
ORDER_ID=$(echo $ORDER | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['id'])")
echo "Order: $ORDER_ID"

# 5. Transition through the lifecycle
curl -s -X PATCH http://localhost:3000/orders/$ORDER_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "PENDING"}' | python3 -m json.tool

curl -s -X PATCH "http://localhost:3000/orders/$ORDER_ID?force=true" \
  -H "Content-Type: application/json" \
  -d '{"status": "FILLED", "filledQuantity": 2, "remainingQuantity": 0}' | python3 -m json.tool

# 6. Try to cancel the filled order — should get 409
curl -s -X DELETE http://localhost:3000/orders/$ORDER_ID | python3 -m json.tool

# 7. Test risk engine — try to exceed order size
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d "{
    \"traderId\": \"$TRADER_ID\",
    \"symbol\": \"BTCUSDT\",
    \"side\": \"BUY\",
    \"type\": \"LIMIT\",
    \"quantity\": 99999,
    \"price\": 60000,
    \"timeInForce\": \"GTC\"
  }" | python3 -m json.tool
```
