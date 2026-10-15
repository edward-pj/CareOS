import { describe, expect, it, vi } from "vitest";
import { SnsNotifier } from "../src/adapters/sns.js";

const arn = "arn:aws:sns:us-east-1:123456789012:careos-caregivers";

describe("SnsNotifier", () => {
  it("publishes to the topic with the kind attribute and returns the MessageId", async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: "m-1" });
    const id = await new SnsNotifier({ send } as never, arn).send("DOSE_LOGGED", "CareOS: 2.0 mL Infant Motrin administered to Leo by Sarah at 11:42 PM.");
    expect(id).toBe("m-1");
    const input = send.mock.calls[0]![0].input;
    expect(input).toMatchObject({ TopicArn: arn, Message: expect.stringContaining("Leo by Sarah"), MessageAttributes: { kind: { StringValue: "DOSE_LOGGED" } } });
  });

  it("swallows SNS failures: a dose that was recorded must not fail because an alert failed", async () => {
    const log = vi.fn();
    const send = vi.fn().mockRejectedValue(new Error("OptedOut"));
    await expect(new SnsNotifier({ send } as never, arn, 1000, log).send("CRITICAL_BLOCK", "x")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OptedOut"));
  });

  it("gives up after the timeout instead of hanging the request", async () => {
    const log = vi.fn();
    const send = vi.fn().mockReturnValue(new Promise(() => {}));
    const t0 = Date.now();
    await expect(new SnsNotifier({ send } as never, arn, 80, log).send("OVERRIDE_USED", "x")).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
