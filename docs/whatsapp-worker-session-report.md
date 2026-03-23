# WhatsApp Worker Session Flow Report

## Scope

This report covers the worker-side changes made to fix:

- `REFRESH_QR` not producing a reliable session transition for the client.
- `LOGOUT_SESSION` not producing a reliable logout flow.
- stale socket events interfering with the active session after refresh/logout.

The implementation changes are in:

- `lib/whatsapp/worker.ts`

## Root Cause

The worker had two lifecycle issues:

1. `REFRESH_QR` and `LOGOUT_SESSION` completed their command rows immediately, but they did not emit a deterministic transitional `session.updated` event first. The UI had little to react to unless a later socket event arrived.
2. Intentional socket closes used the same `connection.update -> close` path as unexpected disconnects. That allowed old sockets to emit `RECONNECTING`, `LOGGED_OUT`, receipts, or auth persistence after a refresh/logout had already started.

## Worker Changes

### 1. Explicit transitional session events

The worker now emits immediate `session.updated` events when commands start:

- `START_SESSION` -> `CONNECTING`
- `REFRESH_QR` -> `CONNECTING`
- `LOGOUT_SESSION` -> `LOGGING_OUT`

These events are sent before the command is marked `COMPLETED`.

### 2. Intentional close tracking

Each managed socket now tracks a close intent:

- `NONE`
- `REFRESH_QR`
- `LOGOUT`
- `STOP`

If a socket is being closed intentionally, its later `connection.update: close` event is ignored by the reconnect logic.

### 3. Stale socket suppression

Only the current socket for a session is now allowed to:

- persist credentials
- emit QR updates
- emit connection updates
- emit message upserts
- emit message receipts

This prevents an older socket from overwriting the active session state after a refresh or logout.

### 4. Refresh QR lifecycle is now deterministic

On `REFRESH_QR`:

1. Worker emits `session.updated` with `status: "CONNECTING"`.
2. Existing socket is removed from the active session map.
3. Existing socket is intentionally closed with close intent `REFRESH_QR`.
4. Pending auth writes are drained.
5. Auth keys are cleared.
6. A new socket is created.
7. When Baileys emits a QR, worker sends `session.updated` with `status: "QR_READY"`.

### 5. Logout lifecycle is now deterministic

On `LOGOUT_SESSION`:

1. Worker emits `session.updated` with `status: "LOGGING_OUT"`.
2. Existing socket is removed from the active session map.
3. Existing socket is marked with close intent `LOGOUT`.
4. Worker calls `socket.logout()`.
5. Pending auth writes are drained.
6. Auth keys are cleared.
7. Worker emits `session.updated` with `status: "LOGGED_OUT"`.

## Event Contract For UI

### Session statuses you should expect

The UI should treat these as the canonical worker-driven states:

- `CONNECTING`
- `QR_READY`
- `CONNECTED`
- `LOGGING_OUT`
- `LOGGED_OUT`
- `RECONNECTING`

### New metadata values

`session.updated.payload.metadata.trigger` may now include:

- `START_SESSION`
- `REFRESH_QR`
- `LOGOUT_SESSION`
- `QR_EMITTED`

These are hints for the UI. The primary state should still come from `payload.status`.

## Recommended UI Behavior

### Start / refresh QR

When the user starts or refreshes a session:

- show a loading state on `CONNECTING`
- clear any currently shown QR when `CONNECTING` arrives
- render the new QR only when `QR_READY` arrives
- do not assume command `COMPLETED` means QR is already available

### Logout

When the user logs out:

- show a pending state on `LOGGING_OUT`
- clear the current QR immediately
- clear any connected-device identity on `LOGGED_OUT`
- treat `LOGGED_OUT` as the terminal state, not command completion alone

### Reconnect handling

If `RECONNECTING` arrives:

- show reconnecting UI
- keep waiting for a later `CONNECTED` or `QR_READY`
- do not treat it as logout

## No schema change required

These changes do not require a database schema change.

The webhook shape is unchanged except for richer `payload.metadata.trigger` values on `session.updated`.

## Verification

Worker verification run:

```bash
npx tsc --noEmit
```

Result: passed.
