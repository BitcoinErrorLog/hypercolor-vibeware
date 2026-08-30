export const EVENT_TYPES = [
  "app.route.viewed",
  "app.onboarding.state",
  "app.onboarding.abandoned",
  "app.chat.empty_state",
  "app.thread.send_settled",
  "app.request.decision",
  "app.backup.export_outcome",
  "app.error.coarse",
  "app.pwa.installed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const PAYLOAD_FIELDS: Record<EventType, readonly string[]> = {
  "app.route.viewed": ["route", "from_route"],
  "app.onboarding.state": ["state"],
  "app.onboarding.abandoned": ["step"],
  "app.chat.empty_state": ["kind"],
  "app.thread.send_settled": ["channel", "outcome", "kind"],
  "app.request.decision": ["kind", "decision"],
  "app.backup.export_outcome": ["outcome"],
  "app.error.coarse": ["code", "surface"],
  "app.pwa.installed": ["outcome"],
};

export const ROUTE_VALUES = [
  "welcome",
  "enable",
  "chats",
  "chat",
  "channels",
  "channel",
  "contacts",
  "contact",
  "requests",
  "profile",
  "settings",
  "ring-callback",
] as const;

export const FROM_ROUTE_VALUES = [...ROUTE_VALUES, "none"] as const;

export const ERROR_CODES = [
  "network",
  "auth",
  "protocol",
  "consumed",
  "validation",
  "unavailable",
  "too-large",
  "not-found",
  "unsupported-target",
  "decrypt-failed",
] as const;

export const ERROR_SURFACES = [
  "hc-chats-ui",
  "hc-thread-ui",
  "hc-onboarding-ui",
  "chats",
  "thread",
  "onboarding",
  "settings",
  "requests",
  "pwa",
  "groups",
  "contacts",
  "ring-callback",
] as const;

export type PayloadEnums = {
  [K in EventType]: {
    [F in (typeof PAYLOAD_FIELDS)[K][number]]: readonly string[];
  };
};

export const PAYLOAD_ENUMS = {
  "app.route.viewed": {
    route: ROUTE_VALUES,
    from_route: FROM_ROUTE_VALUES,
  },
  "app.onboarding.state": {
    state: ["no-identity", "needs-enable", "session-offline", "live"],
  },
  "app.onboarding.abandoned": { step: ["welcome", "enable"] },
  "app.chat.empty_state": { kind: ["dms", "groups", "requests"] },
  "app.thread.send_settled": {
    channel: ["dm", "group"],
    outcome: ["sent", "failed", "queued"],
    kind: ["text", "attachment"],
  },
  "app.request.decision": {
    kind: ["dm", "group-invite"],
    decision: ["accept", "decline"],
  },
  "app.backup.export_outcome": { outcome: ["shown", "confirmed", "cancelled"] },
  "app.error.coarse": {
    code: ERROR_CODES,
    surface: ERROR_SURFACES,
  },
  "app.pwa.installed": { outcome: ["accepted", "dismissed"] },
} as const satisfies PayloadEnums;

const FORBIDDEN_VALUE_CHARS = /[\s/?#=@]/;

export const MAX_PAYLOAD_BYTES = 256;
export const MAX_COARSE_STRING = 64;
export const RETENTION_DAYS = 14;

const BANNED_KEY_RE =
  /body|rawJson|recovery|token|pubky|secret|payment|attachment|cookie|authorization/i;

const PUBKY_Z32ISH_RE = /^[a-z0-9]{52}$/i;
const RECOVERY_B64URL_RE = /^[A-Za-z0-9_-]{43}$/;
const COHORT_KEY_RE = /^[0-9a-f]{64}$/i;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type AcceptedEvidence = {
  id: string;
  surfaceId: string;
  type: EventType;
  payload: Record<string, string>;
  occurredAt: Date;
  modelAllowed: true;
};

export type EvidenceDecision =
  | { accepted: true; row: AcceptedEvidence }
  | { accepted: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (!isPlainObject(value)) return acc;
  for (const [key, child] of Object.entries(value)) {
    acc.push(key);
    collectKeys(child, acc);
  }
  return acc;
}

function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") {
    acc.push(value);
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
    return acc;
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectStrings(child, acc);
  }
  return acc;
}

export function secretShapeReason(value: string): "pubky_shaped" | "recovery_shaped" | null {
  const trimmed = value.trim();
  if (PUBKY_Z32ISH_RE.test(trimmed)) return "pubky_shaped";
  if (RECOVERY_B64URL_RE.test(trimmed)) return "recovery_shaped";
  for (const token of trimmed.split(/[^A-Za-z0-9_-]+/)) {
    if (!token) continue;
    if (PUBKY_Z32ISH_RE.test(token)) return "pubky_shaped";
    if (RECOVERY_B64URL_RE.test(token)) return "recovery_shaped";
  }
  return null;
}

function extractCohortKey(body: Record<string, unknown>): string | null {
  if (typeof body.cohort_key === "string") return body.cohort_key;
  if (isPlainObject(body.actor) && typeof body.actor.cohort_key === "string") {
    return body.actor.cohort_key;
  }
  return null;
}

export function evaluateEvidence(body: unknown, idFactory: () => string): EvidenceDecision {
  if (!isPlainObject(body)) {
    return { accepted: false, reason: "invalid_json" };
  }

  if (typeof body.event_type !== "string" || !isEventType(body.event_type)) {
    return { accepted: false, reason: "unknown_event" };
  }

  const eventType = body.event_type;
  const payload = body.payload;
  if (!isPlainObject(payload)) {
    return { accepted: false, reason: "payload_not_object" };
  }

  const keys = collectKeys(payload);
  for (const key of keys) {
    if (BANNED_KEY_RE.test(key)) {
      return { accepted: false, reason: "banned_key" };
    }
  }

  const allowed = PAYLOAD_FIELDS[eventType];
  const topKeys = Object.keys(payload);
  if (topKeys.some((key) => !allowed.includes(key))) {
    return { accepted: false, reason: "extra_keys" };
  }
  if (allowed.some((key) => !Object.hasOwn(payload, key))) {
    return { accepted: false, reason: "missing_keys" };
  }

  const clean: Record<string, string> = {};
  const enums = PAYLOAD_ENUMS[eventType] as Record<string, readonly string[]>;
  for (const key of allowed) {
    const value = payload[key];
    if (typeof value !== "string") {
      return { accepted: false, reason: "invalid_payload" };
    }
    if (value.length > MAX_COARSE_STRING) {
      return { accepted: false, reason: "invalid_payload" };
    }
    if (FORBIDDEN_VALUE_CHARS.test(value)) {
      return { accepted: false, reason: "invalid_payload" };
    }
    const shaped = secretShapeReason(value);
    if (shaped) return { accepted: false, reason: shaped };
    const allowedValues = enums[key];
    if (!allowedValues || !allowedValues.includes(value)) {
      return { accepted: false, reason: "invalid_payload" };
    }
    clean[key] = value;
  }

  for (const value of collectStrings(payload)) {
    const shaped = secretShapeReason(value);
    if (shaped) return { accepted: false, reason: shaped };
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(clean);
  } catch {
    return { accepted: false, reason: "unserializable" };
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    return { accepted: false, reason: "payload_too_large" };
  }

  if (isPlainObject(body.privacy) && Object.hasOwn(body.privacy, "contains_user_content")) {
    if (body.privacy.contains_user_content !== false) {
      return { accepted: false, reason: "contains_user_content" };
    }
  }

  const cohortKey = extractCohortKey(body);
  if (!cohortKey) {
    return { accepted: false, reason: "invalid_actor" };
  }
  if (secretShapeReason(cohortKey) === "pubky_shaped" || !COHORT_KEY_RE.test(cohortKey)) {
    return { accepted: false, reason: "invalid_actor" };
  }

  if (typeof body.surface_id !== "string" || body.surface_id.length === 0 || body.surface_id.length > 64) {
    return { accepted: false, reason: "unknown_surface" };
  }
  if (secretShapeReason(body.surface_id)) {
    return { accepted: false, reason: "unknown_surface" };
  }

  if (typeof body.occurred_at !== "string") {
    return { accepted: false, reason: "invalid_occurred_at" };
  }
  const occurredAt = new Date(body.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) {
    return { accepted: false, reason: "invalid_occurred_at" };
  }
  const now = Date.now();
  if (occurredAt.getTime() > now + 5 * 60 * 1000) {
    return { accepted: false, reason: "invalid_occurred_at" };
  }
  if (occurredAt.getTime() < now - RETENTION_DAYS * 24 * 60 * 60 * 1000) {
    return { accepted: false, reason: "expired" };
  }

  let id = idFactory();
  if (typeof body.event_id === "string") {
    if (!EVENT_ID_RE.test(body.event_id) || secretShapeReason(body.event_id)) {
      return { accepted: false, reason: "invalid_event_id" };
    }
    id = body.event_id;
  }

  return {
    accepted: true,
    row: {
      id,
      surfaceId: body.surface_id,
      type: eventType,
      payload: clean,
      occurredAt,
      modelAllowed: true,
    },
  };
}
