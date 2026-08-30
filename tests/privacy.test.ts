import { describe, expect, it } from "vitest";
import { evaluateEvidence } from "../src/privacy.js";
import { allowlistedEvent, TEST_COHORT_KEY } from "./harness.js";

const id = () => "evt_test";

describe("evaluateEvidence", () => {
  it("accepts an allowlisted coarse event", () => {
    const decision = evaluateEvidence(allowlistedEvent(), id);
    expect(decision).toEqual({
      accepted: true,
      row: expect.objectContaining({
        type: "app.chat.empty_state",
        payload: { kind: "dms" },
        modelAllowed: true,
      }),
    });
  });

  it("drops unknown event types", () => {
    const decision = evaluateEvidence(allowlistedEvent({ event_type: "app.message.body" }), id);
    expect(decision).toEqual({ accepted: false, reason: "unknown_event" });
  });

  it("drops planted body keys", () => {
    const decision = evaluateEvidence(
      allowlistedEvent({
        payload: { kind: "dms", body: "secret message" },
      }),
      id,
    );
    expect(decision.accepted).toBe(false);
  });

  it("rejects a raw pubky as cohort_key", () => {
    const decision = evaluateEvidence(allowlistedEvent({ cohort_key: "y".repeat(52) }), id);
    expect(decision).toEqual({ accepted: false, reason: "invalid_actor" });
  });

  it("rejects missing cohort_key", () => {
    const event = allowlistedEvent();
    delete (event as { cohort_key?: string }).cohort_key;
    const decision = evaluateEvidence(event, id);
    expect(decision).toEqual({ accepted: false, reason: "invalid_actor" });
  });

  it("accepts actor.cohort_key", () => {
    const event = allowlistedEvent();
    delete (event as { cohort_key?: string }).cohort_key;
    const decision = evaluateEvidence({ ...event, actor: { cohort_key: TEST_COHORT_KEY } }, id);
    expect(decision.accepted).toBe(true);
  });
});
